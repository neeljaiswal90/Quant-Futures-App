"""FastAPI application wiring — the WS surface RA-067's mock specifies.

Mirrors ``contracts/realtime/mock_emitter.py`` exactly: ``GET /health``,
``GET /snapshot``, and ``WebSocket /ws``. Swapping the UI/daemon from mock to
this backend should require only a URL change.

Wiring (assembled in the lifespan):

- :class:`ConnectionManager` fans frames out to clients with per-client
  bounded queues (drop-oldest).
- :class:`FeedState` owns the monotonic seq + snapshot cache + tier policy.
- :class:`CaptureWatcher` runs the detectors on a worker thread; its results
  are marshaled onto the event loop via ``loop.call_soon_threadsafe`` and fed
  to ``FeedState.emit_signal_diff``.
- A heartbeat task emits liveness/staleness on a timer.

On WS connect we replay the current ``/snapshot`` frame so a fresh client (or
one that reconnected after a seq gap) starts aligned to the live counter.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator

from contracts.realtime.events import DepthPayload, ErrorPayload, make_message
from fastapi import BackgroundTasks, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

from realtime_backend.config.router import create_config_router
from realtime_backend.config.store import AlertConfigStore
from realtime_backend.connection_manager import ConnectionManager
from realtime_backend.feed import FeedState
from realtime_backend.orderflow import build_orderflow_stats
from realtime_backend.price_ticks import LatestPriceTick
from realtime_backend.settings import Settings, settings_from_env
from realtime_backend.shutdown import EndDayShutdownService, ShutdownTarget
from realtime_backend.watcher import CaptureWatcher, ComputeResult

logger = logging.getLogger("ra60.realtime_backend")


class RealtimeBackend:
    """Holds the long-lived objects and the loop/thread plumbing."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.manager = ConnectionManager(client_queue_maxsize=settings.client_queue_maxsize)
        self.feed = FeedState(manager=self.manager, settings=settings)
        # RA-068: one shared AlertConfigStore backs both the REST surface
        # (RA-063 router) and any gating path, so a PUT is visible on the next
        # read with no restart. Persists to data/dashboard/alert_config.json —
        # the same file the RA-062 daemon reads.
        self.config_store = AlertConfigStore()
        self.watcher: CaptureWatcher | None = None
        self._heartbeat_task: asyncio.Task[None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    # ----- watcher → loop marshaling ------------------------------------

    def _on_result_threadsafe(self, result: ComputeResult) -> None:
        """Called from the watcher worker thread; hop onto the loop."""
        loop = self._loop
        if loop is None:
            return
        loop.call_soon_threadsafe(
            lambda: asyncio.ensure_future(self._handle_result(result))
        )

    def _on_error_threadsafe(self, exc: Exception) -> None:
        loop = self._loop
        if loop is None:
            logger.warning("watcher error before loop ready: %s", exc)
            return
        loop.call_soon_threadsafe(
            lambda: asyncio.ensure_future(self._handle_error(exc))
        )

    def _on_price_tick_threadsafe(self, tick: LatestPriceTick) -> None:
        """Fast-price callback from watcher thread; emits orderflow=null."""
        loop = self._loop
        if loop is None:
            return
        loop.call_soon_threadsafe(
            lambda: asyncio.ensure_future(self._handle_fast_price_tick(tick))
        )

    def _on_depth_threadsafe(self, payload: DepthPayload) -> None:
        """Depth callback from watcher thread; emits a bounded depth snapshot."""
        loop = self._loop
        if loop is None:
            return
        loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self._handle_depth(payload)))

    async def _handle_result(self, result: ComputeResult) -> None:
        """Diff + emit tiered events, then refresh the snapshot cache."""
        try:
            await self.feed.emit_price_tick(
                result.price_tick,
                orderflow=build_orderflow_stats(result.signals, result.price_tick),
            )
            await self.feed.emit_signal_diff(
                result.signals,
                envelope=result.envelope,
                recent_signals=result.recent_signals,
                current_price=result.current_price,
            )
        finally:
            self.feed.update_snapshot_inputs(
                signals=result.signals,
                envelope=result.envelope,
                recent_signals=result.recent_signals,
                last_append_ts_ns=result.last_append_ts_ns,
                current_price=result.current_price,
                price_tick=result.price_tick,
            )

    async def _handle_fast_price_tick(self, tick: LatestPriceTick) -> None:
        await self.feed.emit_price_tick(tick, orderflow=None)

    async def _handle_depth(self, payload: DepthPayload) -> None:
        await self.feed.emit_depth(payload)

    async def _handle_error(self, exc: Exception) -> None:
        logger.warning("detector pass failed: %s", exc)
        message = make_message(
            type="error",
            payload=ErrorPayload(code="detector_error", message=str(exc)),
            seq=self.feed.current_seq + 1,
        )
        with contextlib.suppress(Exception):
            await self.manager.broadcast(message)

    # ----- heartbeat -----------------------------------------------------

    async def _heartbeat_loop(self) -> None:
        interval = self.settings.heartbeat_interval_seconds
        try:
            while True:
                await asyncio.sleep(interval)
                await self.feed.emit_heartbeat()
        except asyncio.CancelledError:
            raise

    # ----- lifespan ------------------------------------------------------

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self.watcher = CaptureWatcher(
            self.settings,
            self._on_result_threadsafe,
            on_price_tick=self._on_price_tick_threadsafe,
            on_depth=self._on_depth_threadsafe,
            on_error=self._on_error_threadsafe,
        )
        # Seed one compute up-front (blocking, off the loop) so /snapshot has
        # state immediately. Tolerate failure — heartbeat will report stale.
        try:
            seed = await asyncio.to_thread(self.watcher.seed)
            self.feed.update_snapshot_inputs(
                signals=seed.signals,
                envelope=seed.envelope,
                recent_signals=seed.recent_signals,
                last_append_ts_ns=seed.last_append_ts_ns,
                current_price=seed.current_price,
                price_tick=seed.price_tick,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("initial seed compute failed: %s", exc)
        self.watcher.start()
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def stop(self) -> None:
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._heartbeat_task
            self._heartbeat_task = None
        if self.watcher is not None:
            await asyncio.to_thread(self.watcher.stop)
            self.watcher = None
        await self.manager.close_all()


async def _execute_end_day_shutdown(app: FastAPI, targets: list[ShutdownTarget]) -> None:
    """Run after the HTTP response: stop in-process services, then kill targets."""

    await asyncio.sleep(0.2)
    backend: RealtimeBackend = app.state.backend
    with contextlib.suppress(Exception):
        await backend.stop()
    service: EndDayShutdownService = app.state.shutdown_service
    await asyncio.to_thread(service.execute_plan, targets)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the FastAPI app bound to ``settings`` (env defaults if None)."""
    resolved = settings or settings_from_env()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        backend: RealtimeBackend = app.state.backend
        await backend.start()
        try:
            yield
        finally:
            await backend.stop()

    app = FastAPI(title="RA-060 realtime backend", lifespan=lifespan)
    backend = RealtimeBackend(resolved)
    app.state.backend = backend
    app.state.shutdown_service = EndDayShutdownService(backend_port=resolved.port)
    # RA-068: expose the shared store + mount the RA-063 config router so the
    # UI's settings PUT persists centrally (and reaches the daemon's file read).
    app.state.config_store = backend.config_store
    app.include_router(create_config_router(backend.config_store))

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved.cors_origins),
        allow_credentials=True,
        # PUT is required for the alert-config endpoint (RA-063) — the browser
        # preflights a settings save; GET-only would block it.
        # POST is required for the explicit end-day shutdown endpoint.
        allow_methods=["GET", "PUT", "POST"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health() -> dict[str, object]:
        """Liveness probe (mirrors the mock; adds live counters)."""
        backend: RealtimeBackend = app.state.backend
        return {
            "status": "ok",
            "role": "realtime_backend",
            "seq": backend.feed.current_seq,
            "clients": backend.manager.client_count,
        }

    @app.get("/snapshot")
    def snapshot() -> JSONResponse:
        """REST snapshot at the current live seq for load + resync."""
        backend: RealtimeBackend = app.state.backend
        message = backend.feed.build_snapshot_message()
        return JSONResponse(content=message.model_dump())

    @app.get("/api/bookmap-backfill")
    async def bookmap_backfill() -> JSONResponse:
        """Bounded session-history backfill for Bookmap-style reconnect hydration."""
        backend: RealtimeBackend = app.state.backend
        return JSONResponse(content=await backend.feed.bookmap_backfill_payload())

    @app.post("/api/shutdown/end-day")
    def end_day_shutdown(background_tasks: BackgroundTasks) -> JSONResponse:
        """Explicit operator-triggered shutdown for the full local live stack."""
        service: EndDayShutdownService = app.state.shutdown_service
        targets = service.build_plan()
        background_tasks.add_task(_execute_end_day_shutdown, app, targets)
        return JSONResponse(content=service.response_payload(targets))

    @app.websocket("/ws")
    async def ws_endpoint(websocket: WebSocket) -> None:
        """Stream contract frames until the client disconnects.

        On connect we send the current snapshot frame directly, then register
        the socket with the ConnectionManager so it receives live broadcasts.
        """
        backend: RealtimeBackend = app.state.backend
        await websocket.accept()

        async def send(text: str) -> None:
            await websocket.send_text(text)

        # Replay the latest cached depth before the snapshot so a new client
        # sees frames in non-decreasing seq order. The cached depth can be older
        # than the current snapshot; sending it after the snapshot would trigger
        # the UI's out-of-order/gap resync path on every connect.
        #
        # Some browsers disconnect during reload before the first send
        # completes; in that case exit quietly instead of logging an ASGI
        # exception.
        try:
            if backend.feed.latest_depth_message is not None:
                await send(backend.feed.latest_depth_message.model_dump_json())
            snapshot_msg = backend.feed.build_snapshot_message()
            await send(snapshot_msg.model_dump_json())
        except WebSocketDisconnect:
            return

        client = await backend.manager.connect(send)
        try:
            # Keep the socket open; inbound frames are ignored (read-only feed).
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            await backend.manager.disconnect(client)

    return app


# Module-level app for ``uvicorn realtime_backend.app:app`` style invocation.
app = create_app()


__all__ = ["RealtimeBackend", "app", "create_app"]
