"""Tests for the reconnecting WS client: backoff policy + reconnect lifecycle.

No pytest-asyncio in this env, so async paths are driven with ``asyncio.run``.
Reconnect is proven two ways:
- a pure fake-connection harness that drops the socket and asserts the loop
  reconnects (fast, deterministic, no network);
- a live round-trip against the RA-067 mock emitter (uvicorn-in-thread),
  guarded so an infra hiccup skips rather than reds.
"""

from __future__ import annotations

import asyncio
import random
import threading
import time

import pytest
from contracts.realtime.events import RealtimeMessage
from notification_daemon.ws_client import RealtimeClient, backoff_delays

# --------------------------------------------------------------------------
# Pure backoff policy
# --------------------------------------------------------------------------


def test_backoff_full_jitter_within_ceiling() -> None:
    rng = random.Random(1234)
    delays = backoff_delays(base=0.5, multiplier=2.0, cap=30.0, rng=rng)
    ceilings = [0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0, 30.0]
    for ceiling in ceilings:
        d = next(delays)
        assert 0.0 <= d <= ceiling


def test_backoff_is_capped() -> None:
    rng = random.Random(0)
    delays = backoff_delays(base=0.5, multiplier=2.0, cap=30.0, rng=rng)
    samples = [next(delays) for _ in range(50)]
    assert all(d <= 30.0 for d in samples)


def test_backoff_retries_forever() -> None:
    delays = backoff_delays(rng=random.Random(7))
    # Pull a lot of values; the generator never raises StopIteration.
    assert len([next(delays) for _ in range(1000)]) == 1000


# --------------------------------------------------------------------------
# Reconnect lifecycle via a fake connection (no network)
# --------------------------------------------------------------------------


class _FakeWS:
    """Async-iterable fake socket yielding a fixed set of frames then EOF."""

    def __init__(self, frames: list[str]) -> None:
        self._frames = list(frames)

    async def __aenter__(self) -> _FakeWS:
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    def __aiter__(self) -> _FakeWS:
        return self

    async def __anext__(self) -> str:
        if not self._frames:
            raise StopAsyncIteration
        return self._frames.pop(0)


def _frame(seq: int) -> str:
    from contracts.realtime.events import HeartbeatPayload

    return RealtimeMessage(
        type="heartbeat",
        seq=seq,
        ts_ns=0,
        ts_pt="2026-05-28T00:00:00-07:00",
        payload=HeartbeatPayload(server_ts_ns=0),
    ).model_dump_json()


def test_client_reconnects_after_drop(monkeypatch: pytest.MonkeyPatch) -> None:
    # The fake "server" hands out a fresh short-lived connection each time;
    # the client should pump it, see EOF, then reconnect — repeatedly.
    connect_calls = {"n": 0}

    async def fake_connect(url: str) -> _FakeWS:
        connect_calls["n"] += 1
        # Each connection yields one frame then drops (EOF).
        return _FakeWS([_frame(connect_calls["n"])])

    monkeypatch.setattr("notification_daemon.ws_client._connect", fake_connect)

    received: list[RealtimeMessage] = []

    async def on_message(msg: RealtimeMessage) -> None:
        received.append(msg)

    # Use a tiny/zero backoff so the test is fast; cap reconnect attempts.
    rng = random.Random(1)
    client = RealtimeClient(
        "ws://fake/ws", on_message, rng=rng, max_reconnects=3
    )
    # Force near-zero delays by patching the backoff base via monkeypatch on
    # the module constants is unnecessary — full jitter on base 0.5 with a
    # capped attempt count keeps it well under a second in practice, but to
    # be safe we stop after a few frames.

    async def driver() -> None:
        task = asyncio.create_task(client.run())
        # Wait until we've reconnected at least 3 times or timeout.
        deadline = asyncio.get_event_loop().time() + 5.0
        while connect_calls["n"] < 3 and asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(0.01)
        client.stop()
        await asyncio.wait_for(task, timeout=5.0)

    asyncio.run(driver())

    # Reconnected multiple times and delivered a frame from each connection.
    assert connect_calls["n"] >= 3
    assert len(received) >= 3


def test_client_stops_gracefully(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Idle(_FakeWS):
        # A connection that stays "open" (blocks on recv) until cancelled,
        # so the only way the run loop ends is a stop()-driven shutdown.
        async def __anext__(self) -> str:
            await asyncio.sleep(3600)
            raise StopAsyncIteration

    async def fake_connect(url: str) -> _FakeWS:
        return _Idle([])

    # monkeypatch (not direct assignment) so the patch is undone afterwards
    # and does not leak into the live WS test later in this module.
    monkeypatch.setattr("notification_daemon.ws_client._connect", fake_connect)

    async def on_message(msg: RealtimeMessage) -> None:  # pragma: no cover
        pass

    async def driver() -> None:
        client = RealtimeClient("ws://fake/ws", on_message, max_reconnects=2)
        task = asyncio.create_task(client.run())
        await asyncio.sleep(0.05)
        client.stop()
        await asyncio.wait_for(task, timeout=5.0)
        assert task.done()

    asyncio.run(driver())


# --------------------------------------------------------------------------
# Live round-trip against the RA-067 mock emitter (guarded)
# --------------------------------------------------------------------------


def _start_mock_server() -> tuple[object, int]:
    import uvicorn
    from contracts.realtime import mock_emitter as me

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


def test_live_ws_client_receives_frames() -> None:
    pytest.importorskip("websockets")
    pytest.importorskip("uvicorn")
    try:
        server, port = _start_mock_server()
    except Exception as exc:  # pragma: no cover - infra-dependent
        pytest.skip(f"could not start mock server: {exc}")

    received: list[RealtimeMessage] = []

    async def on_message(msg: RealtimeMessage) -> None:
        received.append(msg)

    client = RealtimeClient(f"ws://127.0.0.1:{port}/ws", on_message)

    async def driver() -> None:
        task = asyncio.create_task(client.run())
        deadline = asyncio.get_event_loop().time() + 10.0
        while len(received) < 3 and asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(0.02)
        client.stop()
        await asyncio.wait_for(task, timeout=5.0)

    try:
        asyncio.run(driver())
    finally:
        server.should_exit = True  # type: ignore[attr-defined]

    assert len(received) >= 3
    assert received[0].type == "snapshot"
    assert any(m.tier == "CRITICAL" for m in received)
