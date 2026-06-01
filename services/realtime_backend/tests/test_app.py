"""Tests for the FastAPI wiring: routes, CORS, snapshot, backend lifecycle.

httpx is not installed in this environment, so Starlette's TestClient is
unavailable. We therefore exercise the route *handlers* and the
``RealtimeBackend`` orchestration directly (the live socket path is verified
out-of-band against a running server). This keeps the suite hermetic and fast.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Any, cast

from contracts.realtime.events import SnapshotPayload
from fastapi import BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from starlette.routing import WebSocketRoute

from realtime_backend.app import RealtimeBackend, create_app
from realtime_backend.settings import Settings
from realtime_backend.shutdown import ShutdownTarget

from .conftest import PT, sample_envelope, trade, write_raw


def _collector(sink: list[str]) -> Callable[[str], Awaitable[None]]:
    """An async send callable that records frames into ``sink``."""

    async def _send(text: str) -> None:
        sink.append(text)

    return _send


def _fixture_settings(tmp_path: Path) -> Settings:
    root = tmp_path / "analytics"
    capture = root / "data" / "captures" / "2026-05-22" / "MNQ_globex.jsonl"
    base = int(datetime(2026, 5, 21, 19, 5, tzinfo=PT).timestamp() * 1_000_000_000)
    rows = [
        trade(base + i * 30_000_000_000, 29400.0 + (i % 5), 4, "buy" if i % 2 == 0 else "sell")
        for i in range(40)
    ]
    write_raw(capture, rows)
    zones = root / "data" / "zones" / "2026-05-22_MNQ_globex.json"
    zones.parent.mkdir(parents=True, exist_ok=True)
    zones.write_text(json.dumps(sample_envelope()), encoding="utf-8")
    return Settings(
        analytics_root=root,
        scratch_dir=tmp_path / "scratch" / "dashboard",
        ewma_calibration_path=None,
        session_override="globex",
        trading_date_override="2026-05-22",
        poll_fallback_interval_seconds=0.0,
        fast_price_poll_interval_seconds=0.0,
        heartbeat_interval_seconds=0.1,
    )


def test_app_registers_mock_compatible_routes(tmp_path: Path) -> None:
    app = create_app(_fixture_settings(tmp_path))
    paths = {getattr(r, "path", None) for r in app.routes}
    assert "/health" in paths
    assert "/snapshot" in paths
    assert "/api/bookmap-backfill" in paths
    assert "/api/shutdown/end-day" in paths
    assert any(isinstance(r, WebSocketRoute) and r.path == "/ws" for r in app.routes)


def test_cors_allow_list_is_vite_dev_origin_not_wildcard(tmp_path: Path) -> None:
    app = create_app(_fixture_settings(tmp_path))
    cors = [m for m in app.user_middleware if m.cls is CORSMiddleware]
    assert cors, "CORS middleware not configured"
    raw_origins = cors[0].kwargs["allow_origins"]
    assert isinstance(raw_origins, list)
    assert "http://localhost:5173" in raw_origins
    assert "http://127.0.0.1:5173" in raw_origins
    assert "http://tauri.localhost" in raw_origins
    raw_methods = cors[0].kwargs["allow_methods"]
    assert isinstance(raw_methods, list)
    assert "POST" in raw_methods
    assert "*" not in raw_origins


def test_end_day_shutdown_route_schedules_background_task(tmp_path: Path) -> None:
    app = create_app(_fixture_settings(tmp_path))

    class FakeShutdownService:
        def build_plan(self) -> list[ShutdownTarget]:
            return [ShutdownTarget(kind="dashboard_ui", pid=123, reason="test")]

        def response_payload(self, targets: list[ShutdownTarget]) -> dict[str, object]:
            return {"status": "scheduled", "target_count": len(targets)}

    app.state.shutdown_service = FakeShutdownService()
    route = next(r for r in app.routes if getattr(r, "path", None) == "/api/shutdown/end-day")
    background_tasks = BackgroundTasks()
    response = route.endpoint(background_tasks)  # type: ignore[attr-defined]

    assert json.loads(response.body) == {"status": "scheduled", "target_count": 1}
    assert len(background_tasks.tasks) == 1


def test_health_handler_reports_status(tmp_path: Path) -> None:
    app = create_app(_fixture_settings(tmp_path))
    # The health route function is a closure; invoke it via the route endpoint.
    health = next(r for r in app.routes if getattr(r, "path", None) == "/health")
    payload = health.endpoint()  # type: ignore[attr-defined]
    assert payload["status"] == "ok"
    assert payload["role"] == "realtime_backend"
    assert "seq" in payload and "clients" in payload


def test_backend_lifecycle_seeds_snapshot_and_emits_heartbeat(tmp_path: Path) -> None:
    async def scenario() -> None:
        backend = RealtimeBackend(_fixture_settings(tmp_path))
        received: list[str] = []

        await backend.start()
        try:
            # Seed populated the snapshot cache from the fixture capture.
            snap = backend.feed.build_snapshot_message()
            assert snap.payload.price is not None  # type: ignore[attr-defined]

            # Register a client and let the heartbeat loop emit at least once.
            await backend.manager.connect(_collector(received))
            await asyncio.sleep(0.35)
        finally:
            await backend.stop()

        frames = [json.loads(t) for t in received]
        assert any(f["type"] == "heartbeat" for f in frames)
        seqs = [f["seq"] for f in frames]
        assert seqs == sorted(seqs)  # monotonic non-decreasing on the wire

    asyncio.run(scenario())


def test_backend_fast_price_poller_emits_without_compute_trigger(tmp_path: Path) -> None:
    async def scenario() -> None:
        settings = replace(
            _fixture_settings(tmp_path),
            fast_price_poll_interval_seconds=0.05,
            fast_price_tail_bytes=8_192,
        )
        capture = (
            settings.analytics_root
            / "data"
            / "captures"
            / "2026-05-22"
            / "MNQ_globex.jsonl"
        )
        backend = RealtimeBackend(settings)
        received: list[str] = []
        await backend.start()
        try:
            await backend.manager.connect(_collector(received))
            await asyncio.sleep(0.15)
            received.clear()

            with capture.open("a", encoding="utf-8") as f:
                ts = int(datetime(2026, 5, 21, 20, 1, tzinfo=PT).timestamp() * 1_000_000_000)
                f.write(json.dumps(trade(ts, 29418.25, 2, "sell")) + "\n")

            deadline = asyncio.get_running_loop().time() + 2.0
            frames: list[dict[str, Any]] = []
            while asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(0.05)
                frames = [json.loads(text) for text in received]
                if any(_payload(frame)["family"] == "price_tick" for frame in frames):
                    break
        finally:
            await backend.stop()

        tick = next(frame for frame in frames if _payload(frame)["family"] == "price_tick")
        payload = _payload(tick)
        assert payload["price"] == 29418.25
        assert payload["volume"] == 2
        assert payload["orderflow"] is None

    asyncio.run(scenario())


def test_snapshot_handler_returns_current_seq(tmp_path: Path) -> None:
    async def scenario() -> None:
        backend = RealtimeBackend(_fixture_settings(tmp_path))
        await backend.start()
        try:
            await backend.feed.emit_heartbeat()
            msg = backend.feed.build_snapshot_message()
            assert msg.seq == backend.feed.current_seq
            assert msg.type == "snapshot"
        finally:
            await backend.stop()

    asyncio.run(scenario())


def test_backend_smoke_snapshot_heartbeat_price_tick_after_append(tmp_path: Path) -> None:
    async def scenario() -> None:
        settings = _fixture_settings(tmp_path)
        capture = (
            settings.analytics_root
            / "data"
            / "captures"
            / "2026-05-22"
            / "MNQ_globex.jsonl"
        )
        backend = RealtimeBackend(settings)
        received: list[str] = []
        await backend.start()
        try:
            snapshot = backend.feed.build_snapshot_message()
            assert snapshot.type == "snapshot"
            snapshot_payload = cast(SnapshotPayload, snapshot.payload)
            assert snapshot_payload.price == 29404.0  # latest fixture trade, not VWAP

            await backend.manager.connect(_collector(received))
            await asyncio.sleep(0.15)

            with capture.open("a", encoding="utf-8") as f:
                ts = int(datetime(2026, 5, 21, 19, 59, tzinfo=PT).timestamp() * 1_000_000_000)
                f.write(json.dumps(trade(ts, 29412.25, 7, "buy")) + "\n")
            assert backend.watcher is not None
            backend.watcher.trigger()
            deadline = asyncio.get_running_loop().time() + 5.0
            frames: list[dict[str, Any]] = []
            while asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(0.05)
                frames = [json.loads(text) for text in received]
                if any(_payload(frame)["family"] == "price_tick" for frame in frames):
                    break
        finally:
            await backend.stop()

        families = [_payload(frame)["family"] for frame in frames]
        assert "heartbeat" in families
        assert "price_tick" in families
        tick = next(frame for frame in frames if _payload(frame)["family"] == "price_tick")
        assert tick["ts_ns"] == int(datetime(2026, 5, 21, 19, 59, tzinfo=PT).timestamp() * 1_000_000_000)
        assert _payload(tick)["price"] == 29412.25
        assert _payload(tick)["volume"] == 7

    asyncio.run(scenario())


def _payload(frame: dict[str, Any]) -> dict[str, Any]:
    return cast(dict[str, Any], frame["payload"])
