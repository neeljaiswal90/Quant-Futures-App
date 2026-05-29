"""End-to-end: boot the daemon's handler against the mock emitter and prove a
FakeNotifier receives the CRITICAL toast within budget.

Two layers:
- A deterministic, no-network e2e over the daemon's ``on_message`` driven by
  the mock emitter's ``scripted_messages`` (snapshot → heartbeat → CRITICAL).
  This proves the full wiring (zone ingest → gate → render → notify) and that
  the toast body carries the mapped zone price.
- A live round-trip: real WS client against the uvicorn-hosted mock,
  asserting the FakeNotifier fires the CRITICAL well within 3s.
"""

from __future__ import annotations

import asyncio
import threading
import time
from datetime import datetime

import pytest
from contracts.realtime import mock_emitter as me
from contracts.realtime.config import default_alert_config
from contracts.realtime.events import PT, RealtimeMessage
from notification_daemon.notifier import FakeNotifier
from notification_daemon.run import NotificationDaemon
from notification_daemon.ws_client import RealtimeClient

_MIDDAY = datetime(2026, 5, 28, 12, 0, tzinfo=PT)


def test_e2e_scripted_critical_reaches_fake_notifier(monkeypatch: pytest.MonkeyPatch) -> None:
    # Pin "now" to midday so quiet-hours never interferes deterministically.
    monkeypatch.setattr("notification_daemon.run._now_pt", lambda: _MIDDAY)

    fake = FakeNotifier()
    daemon = NotificationDaemon(notifier=fake, config=default_alert_config())

    emitter = me.MockEmitter()
    frames = emitter.scripted_messages(3)  # snapshot, heartbeat, CRITICAL

    async def drive() -> None:
        for f in frames:
            await daemon.on_message(f)

    asyncio.run(drive())

    assert len(fake.calls) == 1, "exactly one CRITICAL toast expected"
    title, body = fake.calls[0]
    assert "CRITICAL" in title
    # Snapshot frame seeded the zone map -> VPOC price appears in the toast.
    assert "VPOC @ 30075.00" in title
    assert "iceberg + absorption + sweep" in body
    assert daemon.seen == 3
    assert daemon.notified == 1


def test_e2e_quiet_hours_suppresses(monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = default_alert_config()
    # RA-069: only a FULL quiet window (audio_only=False) suppresses the visual
    # toast; audio_only=True keeps visual channels firing (see test_gate.py).
    cfg.quiet_hours.enabled = True  # default window 22:00-06:00
    cfg.quiet_hours.audio_only = False
    night = datetime(2026, 5, 28, 23, 30, tzinfo=PT)
    monkeypatch.setattr("notification_daemon.run._now_pt", lambda: night)

    fake = FakeNotifier()
    daemon = NotificationDaemon(notifier=fake, config=cfg)
    frames = me.MockEmitter().scripted_messages(3)

    async def drive() -> None:
        for f in frames:
            await daemon.on_message(f)

    asyncio.run(drive())
    assert fake.calls == [], "full quiet hours (audio_only=False) must suppress the toast"


def _start_mock_server() -> tuple[object, int]:
    import uvicorn

    me._emitter.tick_s = 0.01
    config = uvicorn.Config(me.app, host="127.0.0.1", port=0, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10.0
    while not server.started and time.time() < deadline:
        time.sleep(0.02)
    if not server.started:
        raise RuntimeError("mock server did not start in time")
    sock = server.servers[0].sockets[0]
    return server, sock.getsockname()[1]


def test_e2e_live_critical_within_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("websockets")
    pytest.importorskip("uvicorn")
    monkeypatch.setattr("notification_daemon.run._now_pt", lambda: _MIDDAY)

    try:
        server, port = _start_mock_server()
    except Exception as exc:  # pragma: no cover - infra-dependent
        pytest.skip(f"could not start mock server: {exc}")

    fake = FakeNotifier()
    daemon = NotificationDaemon(notifier=fake, config=default_alert_config())
    client = RealtimeClient(f"ws://127.0.0.1:{port}/ws", daemon.on_message)

    started = time.time()

    async def driver() -> None:
        task = asyncio.create_task(client.run())
        deadline = asyncio.get_event_loop().time() + 3.0
        while not fake.calls and asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(0.02)
        client.stop()
        await asyncio.wait_for(task, timeout=5.0)

    try:
        asyncio.run(driver())
    finally:
        server.should_exit = True  # type: ignore[attr-defined]

    elapsed = time.time() - started
    assert fake.calls, "FakeNotifier never received the CRITICAL toast"
    assert elapsed < 3.0, f"CRITICAL toast took {elapsed:.2f}s (budget 3s)"
    title, _ = fake.calls[0]
    assert "CRITICAL" in title


def _is_realtime_message(obj: object) -> bool:
    return isinstance(obj, RealtimeMessage)
