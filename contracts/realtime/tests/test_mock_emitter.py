"""Mock-emitter tests (RA-067).

Two layers:
- Deterministic generation (``scripted_messages`` / ``emit_to`` via a fake
  async sink) — fast, no network, no httpx.
- One genuine WS round-trip (uvicorn in a thread + ``websockets`` client)
  proving the FastAPI endpoint serves the contract. Guarded so an infra
  hiccup skips rather than spuriously reds.

Acceptance covered: a client receives snapshot + heartbeat + a scripted
CRITICAL well within the 60s budget.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time

import pytest

from contracts.realtime import mock_emitter as me
from contracts.realtime.events import RealtimeMessage, SnapshotPayload


def _parse(text: str) -> RealtimeMessage:
    return RealtimeMessage.model_validate_json(text)


# --------------------------------------------------------------------------
# Deterministic generation
# --------------------------------------------------------------------------


def test_first_frame_is_snapshot() -> None:
    em = me.MockEmitter()
    msgs = em.scripted_messages(1)
    assert msgs[0].type == "snapshot"
    assert msgs[0].seq == 1
    assert msgs[0].payload.family == "snapshot"


def test_snapshot_carries_full_state() -> None:
    em = me.MockEmitter()
    snap = em.build_snapshot()
    payload = snap.payload
    assert isinstance(payload, SnapshotPayload)
    # Snapshot must carry price, regime, zones, signals, scenarios for resync.
    assert payload.price is not None
    assert payload.regime is not None
    assert len(payload.zones) > 0
    assert len(payload.recent_signals) >= 1
    assert len(payload.open_scenarios) >= 1


def test_seq_is_monotonic() -> None:
    em = me.MockEmitter()
    seqs = [m.seq for m in em.scripted_messages(12)]
    assert seqs == list(range(1, 13))


def test_first_three_frames_cover_acceptance() -> None:
    # snapshot + heartbeat + CRITICAL within the first three frames.
    em = me.MockEmitter()
    msgs = em.scripted_messages(3)
    assert msgs[0].type == "snapshot"
    assert msgs[1].type == "heartbeat"
    assert msgs[2].tier == "CRITICAL"
    assert msgs[2].type == "event"


def test_all_tiers_and_families_exercised() -> None:
    em = me.MockEmitter()
    msgs = em.scripted_messages(10)
    tiers = {m.tier for m in msgs}
    families = {m.payload.family for m in msgs}
    assert {"CRITICAL", "HIGH", "MEDIUM"} <= tiers
    # Spans signal/sweep/iceberg/absorption/price_tick/zone_update/regime.
    assert {"signal", "sweep", "iceberg", "absorption", "price_tick", "zone_update"} <= families


def test_emit_to_via_fake_sink() -> None:
    em = me.MockEmitter(tick_s=0.0)
    received: list[str] = []

    async def sink(text: str) -> None:
        received.append(text)

    asyncio.run(em.emit_to(sink, max_messages=6))

    assert len(received) == 6
    parsed = [_parse(t) for t in received]
    assert parsed[0].type == "snapshot"
    assert any(m.tier == "CRITICAL" for m in parsed)
    # Every frame is valid contract JSON with a monotonic seq.
    assert [m.seq for m in parsed] == list(range(1, 7))


def test_emit_to_frames_are_valid_contract_json() -> None:
    em = me.MockEmitter(tick_s=0.0)
    received: list[str] = []

    async def sink(text: str) -> None:
        received.append(text)

    asyncio.run(em.emit_to(sink, max_messages=10))
    for text in received:
        obj = json.loads(text)
        # round-trips back through the validator without loss
        RealtimeMessage.model_validate(obj)


# --------------------------------------------------------------------------
# Genuine WS round-trip (guarded)
# --------------------------------------------------------------------------


def _start_server(app: object) -> tuple[object, int]:
    import uvicorn

    config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="error")  # type: ignore[arg-type]
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10.0
    while not server.started and time.time() < deadline:
        time.sleep(0.02)
    if not server.started:
        raise RuntimeError("mock server did not start in time")
    sock = server.servers[0].sockets[0]  # type: ignore[attr-defined]
    port = sock.getsockname()[1]
    return server, port


async def _recv_n(port: int, n: int) -> list[dict[str, object]]:
    try:
        from websockets.asyncio.client import connect
    except Exception:  # pragma: no cover - older websockets
        from websockets import connect  # type: ignore[attr-defined,no-redef]

    frames: list[dict[str, object]] = []
    async with connect(f"ws://127.0.0.1:{port}/ws") as ws:
        for _ in range(n):
            frames.append(json.loads(await asyncio.wait_for(ws.recv(), timeout=10.0)))
    return frames


def test_snapshot_rest_handler_returns_snapshot_envelope() -> None:
    # The GET /snapshot REST route (resync target) returns a valid snapshot
    # envelope. Tested via the handler directly (no httpx dependency).
    payload = me.snapshot()
    assert payload["type"] == "snapshot"
    assert payload["seq"] == 1
    # Round-trips back through the contract validator.
    msg = RealtimeMessage.model_validate(payload)
    assert isinstance(msg.payload, SnapshotPayload)
    assert msg.payload.price is not None


def test_live_ws_roundtrip_snapshot_heartbeat_critical() -> None:
    pytest.importorskip("websockets")
    # Speed up the live emitter so the test isn't slow.
    me._emitter.tick_s = 0.01
    try:
        server, port = _start_server(me.app)
    except Exception as exc:  # pragma: no cover - infra-dependent
        pytest.skip(f"could not start mock server: {exc}")

    try:
        frames = asyncio.run(_recv_n(port, 3))
    finally:
        server.should_exit = True  # type: ignore[attr-defined]

    assert frames[0]["type"] == "snapshot"
    assert frames[1]["type"] == "heartbeat"
    assert frames[2]["tier"] == "CRITICAL"
    # Each frame validates against the contract.
    for f in frames:
        RealtimeMessage.model_validate(f)
