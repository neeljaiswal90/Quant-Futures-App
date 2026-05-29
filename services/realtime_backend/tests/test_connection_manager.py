"""Tests for the multi-client bounded-queue fan-out.

No pytest-asyncio in this environment, so each async scenario runs inside an
``asyncio.run`` body wrapped by a sync test function.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from contracts.realtime.events import PriceTickPayload, RealtimeMessage, make_message

from realtime_backend.connection_manager import ConnectionManager


def _tick(seq: int) -> RealtimeMessage:
    return make_message(
        type="event",
        payload=PriceTickPayload(price=29400.0 + seq),
        seq=seq,
    )


def _collector(sink: list[str]) -> Callable[[str], Awaitable[None]]:
    """An async send callable that records frames into ``sink``."""

    async def _send(text: str) -> None:
        sink.append(text)

    return _send


def test_broadcast_reaches_multiple_clients() -> None:
    async def scenario() -> None:
        mgr = ConnectionManager(client_queue_maxsize=16)
        a: list[str] = []
        b: list[str] = []
        await mgr.connect(_collector(a))
        await mgr.connect(_collector(b))
        assert mgr.client_count == 2
        dropped = await mgr.broadcast(_tick(1))
        await asyncio.sleep(0.05)  # let writer tasks drain
        assert dropped == 0
        assert len(a) == 1 and len(b) == 1
        await mgr.close_all()

    asyncio.run(scenario())


def test_slow_client_drops_oldest_without_blocking_others() -> None:
    async def scenario() -> None:
        mgr = ConnectionManager(client_queue_maxsize=4)

        # A "stuck" client whose send never completes -> queue fills.
        stuck_started = asyncio.Event()

        async def stuck(_text: str) -> None:
            stuck_started.set()
            await asyncio.sleep(3600)

        fast: list[str] = []
        await mgr.connect(stuck)
        await mgr.connect(_collector(fast))

        total_dropped = 0
        # Push more than maxsize so the stuck client overflows + drops oldest.
        for i in range(1, 20):
            total_dropped += await mgr.broadcast(_tick(i))
            await asyncio.sleep(0)  # yield so the fast writer drains
        await asyncio.sleep(0.05)

        # The fast client must have received frames despite the stuck one.
        assert len(fast) > 0
        # At least one drop must have occurred on the bounded stuck queue.
        assert total_dropped >= 1
        await mgr.close_all()

    asyncio.run(scenario())


def test_disconnect_removes_client() -> None:
    async def scenario() -> None:
        mgr = ConnectionManager()
        received: list[str] = []
        client = await mgr.connect(_collector(received))
        assert mgr.client_count == 1
        await mgr.disconnect(client)
        assert mgr.client_count == 0
        # Broadcast after disconnect reaches nobody, no error.
        assert await mgr.broadcast(_tick(1)) == 0

    asyncio.run(scenario())


def test_offer_drop_oldest_keeps_newest() -> None:
    async def scenario() -> None:
        from realtime_backend.connection_manager import ClientConnection

        async def _noop(_text: str) -> None:
            return None

        client = ClientConnection(send=_noop, queue_maxsize=2)
        # Do not start the writer so the queue stays full.
        assert client.offer("a") is False
        assert client.offer("b") is False
        assert client.offer("c") is True  # full -> drop oldest "a"
        # Queue should now hold b, c (oldest "a" dropped).
        drained = [client.queue.get_nowait() for _ in range(client.queue.qsize())]
        assert drained == ["b", "c"]
        assert client.dropped == 1

    asyncio.run(scenario())
