"""Reconnecting WebSocket client for the realtime contract.

A thin, hand-rolled loop over ``websockets`` that:

- connects to the stream, parses each frame into a :class:`RealtimeMessage`,
  and hands it to an async ``on_message`` callback;
- on any disconnect/error, reconnects with exponential backoff + full
  jitter (base 0.5s, ×2, cap 30s), retrying **forever**;
- resets the backoff once a connection has *survived* a few seconds (so a
  long-lived link that finally drops starts retrying fast, while a
  connect-flap doesn't hammer the server);
- stops cleanly when its ``asyncio.Event`` is set.

Backoff is hand-rolled (not a library) per the RA-062 decision so the
policy is explicit and unit-testable: :func:`backoff_delays` is a pure
generator the tests assert against.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import random
from collections.abc import Awaitable, Callable, Iterator

from contracts.realtime.events import RealtimeMessage

logger = logging.getLogger("notification_daemon.ws")

OnMessage = Callable[[RealtimeMessage], Awaitable[None]]

# Backoff policy (RA-062 decision).
_BASE_DELAY_S = 0.5
_MULTIPLIER = 2.0
_CAP_S = 30.0
# A connection that survives at least this long is "healthy"; its eventual
# drop resets the backoff so we reconnect promptly.
_HEALTHY_AFTER_S = 5.0


def backoff_delays(
    *,
    base: float = _BASE_DELAY_S,
    multiplier: float = _MULTIPLIER,
    cap: float = _CAP_S,
    rng: random.Random | None = None,
) -> Iterator[float]:
    """Infinite generator of full-jitter backoff delays.

    Deterministic exponential ceiling ``min(cap, base * multiplier**n)`` with
    **full jitter**: each yielded delay is uniform in ``[0, ceiling]``. Pass a
    seeded ``rng`` to make it deterministic in tests.
    """
    r = rng or random.Random()
    ceiling = base
    while True:
        yield r.uniform(0.0, min(ceiling, cap))
        ceiling = min(ceiling * multiplier, cap)


async def _connect(url: str):  # type: ignore[no-untyped-def]
    """Open a WS connection, preferring the modern asyncio client API."""
    try:
        from websockets.asyncio.client import connect
    except ImportError:  # pragma: no cover - older websockets fallback
        from websockets import connect  # noqa: F811
    return connect(url)


class RealtimeClient:
    """Reconnecting WS client that pumps frames into ``on_message``."""

    def __init__(
        self,
        url: str,
        on_message: OnMessage,
        *,
        stop_event: asyncio.Event | None = None,
        rng: random.Random | None = None,
        max_reconnects: int | None = None,
    ) -> None:
        """``max_reconnects`` caps the number of (re)connect *attempts*; it
        exists only so tests can bound the otherwise-infinite loop. Production
        leaves it ``None`` (retry forever)."""
        self.url = url
        self._on_message = on_message
        self._stop = stop_event or asyncio.Event()
        self._rng = rng
        self._max_reconnects = max_reconnects

    def stop(self) -> None:
        """Request a graceful shutdown of the run loop."""
        self._stop.set()

    async def _pump(self, ws: object) -> None:
        """Read frames until the socket closes; dispatch each parsed frame."""
        async for raw in ws:  # type: ignore[attr-defined]
            text = raw.decode() if isinstance(raw, (bytes, bytearray)) else str(raw)
            try:
                msg = RealtimeMessage.model_validate_json(text)
            except Exception:
                logger.warning("dropping unparseable frame", exc_info=True)
                continue
            await self._on_message(msg)

    async def _pump_until_stop(self, ws: object) -> None:
        """Pump frames but break out promptly when :meth:`stop` is set.

        The frame loop on a live stream blocks indefinitely; without this
        race a ``stop()`` during an active connection would not take effect
        until the (never-arriving) next disconnect. We run the pump as a task
        and cancel it the moment the stop event fires.
        """
        pump_task = asyncio.ensure_future(self._pump(ws))
        stop_task = asyncio.ensure_future(self._stop.wait())
        try:
            done, _ = await asyncio.wait(
                {pump_task, stop_task}, return_when=asyncio.FIRST_COMPLETED
            )
            if pump_task in done:
                # Socket closed on its own; surface any error to run().
                pump_task.result()
        finally:
            for task in (pump_task, stop_task):
                if not task.done():
                    task.cancel()
                    # Drain the cancelled task; ignore its CancelledError or
                    # any teardown error (we are already shutting down).
                    with contextlib.suppress(BaseException):
                        await task

    async def run(self) -> None:
        """Connect-pump-reconnect forever until :meth:`stop` is called."""
        delays = backoff_delays(rng=self._rng)
        attempts = 0
        loop = asyncio.get_event_loop()
        while not self._stop.is_set():
            attempts += 1
            if self._max_reconnects is not None and attempts > self._max_reconnects:
                logger.info("reached max_reconnects=%d; stopping", self._max_reconnects)
                return
            connected_at: float | None = None
            try:
                logger.info("connecting to %s (attempt %d)", self.url, attempts)
                async with await _connect(self.url) as ws:
                    connected_at = loop.time()
                    logger.info("connected to %s", self.url)
                    await self._pump_until_stop(ws)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("WS connection error: %s", exc)
            else:
                logger.info("WS connection closed by peer")

            if self._stop.is_set():
                return

            # Reset the backoff if the connection was healthy (survived a
            # while) before it dropped — a real outage after a good run
            # should reconnect quickly, not after a long penalty.
            if connected_at is not None and (loop.time() - connected_at) >= _HEALTHY_AFTER_S:
                logger.debug("connection was healthy; resetting backoff")
                delays = backoff_delays(rng=self._rng)

            delay = next(delays)
            logger.info("reconnecting in %.2fs", delay)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=delay)
            except TimeoutError:
                pass  # delay elapsed; loop and reconnect
            else:
                return  # stop was set during the wait


__all__ = ["RealtimeClient", "backoff_delays", "OnMessage"]
