"""Multi-client WebSocket fan-out with per-client bounded backpressure.

Transport-agnostic on purpose: a :class:`ClientConnection` wraps any
``async (text) -> None`` send callable, so the broadcast/backpressure logic is
unit-testable with a fake sink (mirrors the RA-067 mock's ``emit_to`` design)
without httpx / a real socket.

Backpressure policy (GREEN-LIT): each client has an
``asyncio.Queue(maxsize=256)``. When the queue is full we **drop the oldest**
frame and enqueue the new one, then bump the global ``seq`` accounting so the
client detects the gap (its next received ``seq`` jumps) and resyncs via REST
``/snapshot``. A slow client never blocks the broadcaster or other clients.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from contracts.realtime.events import RealtimeMessage

AsyncSend = Callable[[str], Awaitable[None]]


@dataclass(eq=False)
class ClientConnection:
    """One connected client: a bounded outbound queue + a writer task.

    The writer task drains the queue to ``send`` sequentially; the broadcaster
    only ever *enqueues* (non-blocking, drop-oldest on overflow), so one stuck
    socket cannot stall the others.

    ``eq=False`` keeps identity-based hashing so instances are usable as
    set members in :class:`ConnectionManager`.
    """

    send: AsyncSend
    queue_maxsize: int = 256
    queue: asyncio.Queue[str] = field(init=False)
    dropped: int = field(default=0, init=False)
    _writer: asyncio.Task[None] | None = field(default=None, init=False)
    _closed: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        self.queue = asyncio.Queue(maxsize=self.queue_maxsize)

    def start(self) -> None:
        """Launch the background writer that drains the queue to ``send``."""
        if self._writer is None:
            self._writer = asyncio.create_task(self._drain())

    async def _drain(self) -> None:
        try:
            while True:
                text = await self.queue.get()
                await self.send(text)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Send failed (socket closed / reset). Stop draining; the manager
            # will reap this client. Swallow so one dead socket is isolated.
            self._closed = True

    def offer(self, text: str) -> bool:
        """Enqueue a frame, dropping the oldest if the queue is full.

        Returns True if a drop occurred (caller bumps seq accounting so the
        client gap-detects), False otherwise.
        """
        dropped = False
        if self.queue.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self.queue.get_nowait()
            self.dropped += 1
            dropped = True
        with contextlib.suppress(asyncio.QueueFull):
            self.queue.put_nowait(text)
        return dropped

    @property
    def closed(self) -> bool:
        return self._closed

    async def close(self) -> None:
        """Cancel the writer task and mark the connection closed."""
        self._closed = True
        if self._writer is not None:
            self._writer.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._writer
            self._writer = None


class ConnectionManager:
    """Registry of live clients + a single broadcast entry point.

    ``broadcast`` serializes a :class:`RealtimeMessage` once and offers the
    text to every client's bounded queue. The total number of drops across the
    fan-out is returned so the server can bump its global ``seq`` and the next
    real frame lands at a higher number — the client's gap detector fires and
    it pulls a fresh ``/snapshot``.
    """

    def __init__(self, *, client_queue_maxsize: int = 256) -> None:
        self._clients: set[ClientConnection] = set()
        self._client_queue_maxsize = client_queue_maxsize
        self._lock = asyncio.Lock()

    async def connect(self, send: AsyncSend) -> ClientConnection:
        """Register a new client and start its writer task."""
        client = ClientConnection(send=send, queue_maxsize=self._client_queue_maxsize)
        client.start()
        async with self._lock:
            self._clients.add(client)
        return client

    async def disconnect(self, client: ClientConnection) -> None:
        """Deregister and tear down a client."""
        async with self._lock:
            self._clients.discard(client)
        await client.close()

    async def broadcast(self, message: RealtimeMessage) -> int:
        """Offer ``message`` to every client. Returns clients that dropped.

        A nonzero return means at least one slow client lost a frame; the
        caller should advance the global seq so the gap is observable.
        """
        text = message.model_dump_json()
        dropped_clients = 0
        dead: list[ClientConnection] = []
        async with self._lock:
            clients = list(self._clients)
        for client in clients:
            if client.closed:
                dead.append(client)
                continue
            if client.offer(text):
                dropped_clients += 1
        for client in dead:
            await self.disconnect(client)
        return dropped_clients

    async def broadcast_text(self, text: str) -> int:
        """Offer a pre-serialized frame (used in tests / replay)."""
        dropped_clients = 0
        async with self._lock:
            clients = list(self._clients)
        for client in clients:
            if client.offer(text):
                dropped_clients += 1
        return dropped_clients

    @property
    def client_count(self) -> int:
        return len(self._clients)

    async def close_all(self) -> None:
        """Tear down every client (server shutdown)."""
        async with self._lock:
            clients = list(self._clients)
            self._clients.clear()
        for client in clients:
            await client.close()


__all__ = ["AsyncSend", "ClientConnection", "ConnectionManager"]
