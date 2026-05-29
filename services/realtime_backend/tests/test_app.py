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
from datetime import datetime
from pathlib import Path

from fastapi.middleware.cors import CORSMiddleware
from starlette.routing import WebSocketRoute

from realtime_backend.app import RealtimeBackend, create_app
from realtime_backend.settings import Settings

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
        heartbeat_interval_seconds=0.1,
    )


def test_app_registers_mock_compatible_routes(tmp_path: Path) -> None:
    app = create_app(_fixture_settings(tmp_path))
    paths = {getattr(r, "path", None) for r in app.routes}
    assert "/health" in paths
    assert "/snapshot" in paths
    assert any(isinstance(r, WebSocketRoute) and r.path == "/ws" for r in app.routes)


def test_cors_allow_list_is_vite_dev_origin_not_wildcard(tmp_path: Path) -> None:
    app = create_app(_fixture_settings(tmp_path))
    cors = [m for m in app.user_middleware if m.cls is CORSMiddleware]
    assert cors, "CORS middleware not configured"
    raw_origins = cors[0].kwargs["allow_origins"]
    assert isinstance(raw_origins, list)
    assert "http://localhost:5173" in raw_origins
    assert "http://127.0.0.1:5173" in raw_origins
    assert "*" not in raw_origins


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
