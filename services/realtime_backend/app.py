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

from contracts.realtime.events import ErrorPayload, make_message
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

from realtime_backend.config.router import create_config_router
from realtime_backend.config.store import AlertConfigStore
from realtime_backend.connection_manager import ConnectionManager
from realtime_backend.feed import FeedState
from realtime_backend.settings import Settings, settings_from_env
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

    async def _handle_result(self, result: ComputeResult) -> None:
        """Diff + emit tiered events, then refresh the snapshot cache."""
        try:
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
            )

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
        allow_methods=["GET", "PUT"],
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

        # Immediate snapshot so the client starts aligned to the live seq.
        snapshot_msg = backend.feed.build_snapshot_message()
        await send(snapshot_msg.model_dump_json())

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
