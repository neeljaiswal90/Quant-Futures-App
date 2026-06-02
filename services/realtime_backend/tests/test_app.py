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
        # RA-112e: pin the zone-stream output paths to tmp_path so tests
        # never write to a real repo `data/` dir under any CWD.
        zone_snapshot_dir=tmp_path / "zone_snapshots",
        zone_touch_root=tmp_path / "zone_touch_root",
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


def test_backend_writes_zone_snapshot_on_seed(tmp_path: Path) -> None:
    """RA-112e: the seed compute must drop a session_open record to the
    zone-snapshot stream so the JSONL file is non-empty from boot."""
    async def scenario() -> None:
        settings = replace(
            _fixture_settings(tmp_path),
            zone_snapshot_dir=tmp_path / "zone_snapshots",
        )
        backend = RealtimeBackend(settings)
        await backend.start()
        try:
            # Give the seed's async _record_zone_snapshot time to land.
            await asyncio.sleep(0.05)
        finally:
            await backend.stop()

        files = list((tmp_path / "zone_snapshots").glob("*.jsonl"))
        assert files, "expected a zone_snapshot file to be created on seed"
        lines = files[0].read_text(encoding="utf-8").splitlines()
        assert lines, "expected at least one record in the snapshot file"
        first = json.loads(lines[0])
        assert first["schema_version"] == 1
        assert first["zone_snapshot_seq"] == 1
        assert first["emit_reason"] == "session_open"
        assert first["symbol"] == "MNQ"
        assert first["session"] == "globex"
        # Tactical anchor should be populated from the fixture's live VWAP.
        assert first["tactical_anchor"] is not None
        assert first["tactical_anchor"]["method"].startswith("vwap_w_")
        # Session anchors come from the fixture envelope.
        assert first["session_anchors"]["vah"] is not None
        # File path matches the trading-date / symbol / session convention.
        assert files[0].name.endswith("_MNQ_globex.jsonl")

    asyncio.run(scenario())


def test_backend_seed_populates_v3_shelves_on_snapshot(tmp_path: Path) -> None:
    """RA-112e step 4: the seed compute calls v3 shelf compute and the resulting
    shelves land in the zone_snapshot record (not the empty step-1 placeholder)."""
    async def scenario() -> None:
        settings = replace(
            _fixture_settings(tmp_path),
            zone_snapshot_dir=tmp_path / "zone_snapshots",
        )
        backend = RealtimeBackend(settings)
        await backend.start()
        try:
            await asyncio.sleep(0.2)
        finally:
            await backend.stop()

        files = list((tmp_path / "zone_snapshots").glob("*.jsonl"))
        assert files, "expected a zone_snapshot file to be created on seed"
        lines = files[0].read_text(encoding="utf-8").splitlines()
        assert lines
        first = json.loads(lines[0])
        # v3 + v2 shelves should now populate (was empty in step 1).
        assert len(first["shelves"]) > 0, "expected populated shelves (step 4)"
        families = {s["family"] for s in first["shelves"]}
        assert "sigma_v3_vwap_anchor" in families
        # v3 invariant: SUP_1 bottom == anchor (no shelf-crosses-anchor bug).
        sup_1 = next(
            s for s in first["shelves"]
            if s["family"] == "sigma_v3_vwap_anchor" and s["name"] == "SUP_1"
        )
        anchor_value = first["tactical_anchor"]["value"]
        assert abs(sup_1["low"] - anchor_value) < 1e-6
        # cap_bind_flags + bound_source dicts cover every shelf.
        shelf_keys = {f"{s['family']}:{s['name']}" for s in first["shelves"]}
        assert set(first["cap_bind_flags"].keys()) == shelf_keys
        assert set(first["bound_source"].keys()) == shelf_keys
        # method_versions reflects the live v3 tactical compute.
        assert first["method_versions"]["tactical"] == "v3.0.0"

    asyncio.run(scenario())


def test_ws_snapshot_payload_carries_v3_shelves(tmp_path: Path) -> None:
    """RA-112e step 4c: a /snapshot or WS snapshot frame must include the
    live v3 shelves so cold-start clients have the band overlay immediately."""
    async def scenario() -> None:
        settings = replace(
            _fixture_settings(tmp_path),
            zone_snapshot_dir=tmp_path / "zone_snapshots",
        )
        backend = RealtimeBackend(settings)
        await backend.start()
        try:
            await asyncio.sleep(0.2)
            # Drive a snapshot build through the same path /snapshot uses.
            msg = backend.feed.build_snapshot_message()
            payload = msg.payload  # type: ignore[union-attr]
        finally:
            await backend.stop()

        assert payload.family == "snapshot"  # type: ignore[attr-defined]
        shelves = payload.shelves  # type: ignore[attr-defined]
        assert len(shelves) > 0, "expected populated shelves on WS snapshot"
        families = {s.family for s in shelves}
        assert "sigma_v3_vwap_anchor" in families
        # Cap-bind flags cover every shelf id ("<family>:<name>").
        cap_flags = payload.cap_bind_flags  # type: ignore[attr-defined]
        shelf_keys = {f"{s.family}:{s.name}" for s in shelves}
        assert set(cap_flags.keys()) == shelf_keys

    asyncio.run(scenario())


def test_touch_logger_writes_touch_and_outcome(tmp_path: Path) -> None:
    """RA-112e step 2: drive a synthetic crossing through the live wiring and
    verify a touch row + at least one outcome row land on disk."""
    from realtime_backend.price_ticks import LatestPriceTick

    async def scenario() -> None:
        settings = replace(
            _fixture_settings(tmp_path),
            zone_snapshot_dir=tmp_path / "zone_snapshots",
            zone_touch_root=tmp_path,
        )
        backend = RealtimeBackend(settings)
        await backend.start()
        try:
            # Seed established the detector levels (VPOC 29400 / VAH 29425 / VAL 29375).
            await asyncio.sleep(0.05)

            # Synthesize a price sequence that crosses VPOC from below.
            # Default min_distance = 4 ticks = 1.0 pt, so we start ≥1pt away.
            base_ns = int(
                datetime(2026, 5, 21, 19, 30, tzinfo=PT).timestamp()
                * 1_000_000_000
            )
            tick_below = LatestPriceTick(
                trade_ts_ns=base_ns,
                price=29398.0,
                volume=1,
                aggressor_side="buy",
            )
            tick_at = LatestPriceTick(
                trade_ts_ns=base_ns + 1_000_000_000,
                price=29400.0,
                volume=2,
                aggressor_side="buy",
            )
            # First sample establishes the side baseline; second fires the touch.
            await asyncio.to_thread(
                backend._ingest_price_tick_for_touches, tick_below
            )
            await asyncio.to_thread(
                backend._ingest_price_tick_for_touches, tick_at
            )

            # Drive a post-touch tick well past the 1-min horizon so the
            # outcome row finalizes.
            tick_future = LatestPriceTick(
                trade_ts_ns=base_ns + 70_000_000_000,
                price=29402.0,
                volume=1,
                aggressor_side="buy",
            )
            await asyncio.to_thread(
                backend._ingest_price_tick_for_touches, tick_future
            )
        finally:
            await backend.stop()

        # Touches file populated.
        touches = list((tmp_path / "zone_touches").glob("*.jsonl"))
        assert touches, "expected a zone_touches JSONL file"
        touch_lines = touches[0].read_text(encoding="utf-8").splitlines()
        assert touch_lines, "expected at least one touch record"
        rec = json.loads(touch_lines[0])
        assert rec["event_id"].startswith("MNQ-")
        assert rec["zone_id"] == "ref-vpoc-29400.00"
        assert rec["approach_side"] == "from_below"
        assert rec["touch_price"] == 29400.0
        # Reference back to the snapshot stream.
        assert rec["zone_snapshot_seq"] >= 1

        # Outcomes file has at least the 1-min row (later horizons may stay
        # pending depending on flush timing — that's fine, they'd land later).
        outcomes = list((tmp_path / "zone_outcomes").glob("*.jsonl"))
        assert outcomes, "expected a zone_outcomes JSONL file"
        outcome_lines = outcomes[0].read_text(encoding="utf-8").splitlines()
        assert outcome_lines, "expected at least one outcome record"
        first_outcome = json.loads(outcome_lines[0])
        assert first_outcome["event_id"] == rec["event_id"]
        assert first_outcome["horizon_sec"] in (60, 180, 300, 600)

    asyncio.run(scenario())


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
