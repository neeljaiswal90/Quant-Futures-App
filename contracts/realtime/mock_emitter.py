"""Mock realtime emitter (RA-067).

Serves the exact WS interface RA-060 will implement, but generates
synthetic CRITICAL / HIGH / MEDIUM events on a timer instead of running
real detectors over a capture tail. The frontend (RA-061) and the
notification daemon (RA-062) develop entirely against this — zero
dependency on a running backend or live capture.

Two layers, deliberately separated:

- :meth:`MockEmitter.scripted_messages` / :meth:`MockEmitter.emit_to` —
  the transport-agnostic message *generation*. ``emit_to`` takes any
  async ``send(text)`` callable, so it is unit-testable with a fake sink
  (no network, no httpx).
- :data:`app` — the FastAPI WebSocket endpoint that wires a real socket's
  ``send_text`` into ``emit_to``. Same surface RA-060 implements.

Run standalone::

    python -m contracts.realtime.mock_emitter   # ws://127.0.0.1:8765/ws
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from contracts.realtime.events import (
    AbsorptionPayload,
    HeartbeatPayload,
    IcebergPayload,
    MessageType,
    PriceTickPayload,
    RealtimeMessage,
    RealtimePayload,
    ScenarioState,
    SignalPayload,
    SnapshotPayload,
    SweepPayload,
    Tier,
    VolRegimePayload,
    ZoneState,
    ZoneUpdatePayload,
    make_message,
    now_pt_iso,
)

AsyncSend = Callable[[str], Awaitable[None]]

# A representative MNQ price neighborhood for synthetic events.
_BASE_PRICE: float = 30080.0

# (envelope type, payload factory, tier) — the repeating post-snapshot loop.
_ScheduleEntry = tuple[MessageType, Callable[[], RealtimePayload], Tier | None]


def _snapshot_payload() -> SnapshotPayload:
    return SnapshotPayload(
        price=_BASE_PRICE,
        sigma=12.5,
        regime="NORMAL",
        zones=[
            ZoneState(id="vpoc", kind="vpoc", price=30075.0, label="VPOC"),
            ZoneState(id="vah", kind="vah", price=30120.0, label="VAH"),
            ZoneState(id="val", kind="val", price=30030.0, label="VAL"),
            ZoneState(id="sigma1_up", kind="sigma1", price=30092.5, label="+1σ"),
            ZoneState(id="sigma1_dn", kind="sigma1", price=30067.5, label="-1σ"),
        ],
        recent_signals=[
            SignalPayload(
                event_type="cvd_breakdown",
                level_id="vpoc",
                description="Session CVD rolled negative at VPOC",
                intensity=0.6,
                confidence="medium",
            )
        ],
        open_scenarios=[
            ScenarioState(
                id="scn-long-val",
                label="Long off VAL reclaim",
                probability=0.55,
                target_price=30120.0,
            )
        ],
    )


def _critical_signal() -> SignalPayload:
    return SignalPayload(
        event_type="confluence_stack",
        level_id="vpoc",
        description="CRITICAL: iceberg + absorption + sweep stacked at VPOC",
        intensity=0.95,
        confidence="high",
        metadata={"families": ["iceberg", "absorption", "sweep"]},
    )


_SCHEDULE: tuple[_ScheduleEntry, ...] = (
    (
        "heartbeat",
        lambda: HeartbeatPayload(server_ts_ns=0, last_capture_ts_ns=0, stale=False),
        None,
    ),
    ("event", _critical_signal, "CRITICAL"),
    (
        "event",
        lambda: SweepPayload(
            price=_BASE_PRICE + 5.0,
            direction="up",
            ticks_cleared=4,
            level_id="vah",
            description="Swept VAH by 4 ticks",
        ),
        "HIGH",
    ),
    (
        "heartbeat",
        lambda: HeartbeatPayload(server_ts_ns=0, last_capture_ts_ns=0, stale=False),
        None,
    ),
    (
        "event",
        lambda: IcebergPayload(
            price=_BASE_PRICE - 5.0,
            side="bid",
            refills=4,
            total_consumed=320,
            level_id="val",
            description="Iceberg refilling bid at VAL",
        ),
        "MEDIUM",
    ),
    (
        "regime",
        lambda: VolRegimePayload(
            regime="HIGH", sigma=21.0, description="Vol regime → HIGH"
        ),
        None,
    ),
    (
        "event",
        lambda: AbsorptionPayload(
            price=_BASE_PRICE,
            side="ask",
            score=0.72,
            level_id="vpoc",
            description="Ask absorption at VPOC",
        ),
        "HIGH",
    ),
    (
        "event",
        lambda: PriceTickPayload(
            price=_BASE_PRICE + 0.25,
            bid=_BASE_PRICE,
            ask=_BASE_PRICE + 0.5,
            volume=3,
        ),
        None,
    ),
    (
        "event",
        lambda: ZoneUpdatePayload(
            zones=[ZoneState(id="wvwap", kind="wvwap", price=30088.0, label="W-VWAP")]
        ),
        None,
    ),
)


@dataclass
class MockEmitter:
    """Deterministic synthetic event source over the realtime contract.

    Attributes:
        tick_s: Seconds between frames in the live :meth:`emit_to` loop.
            Tests set this near-zero; the standalone server uses ~1s so a
            scripted CRITICAL lands at ~2s (well within the 60s acceptance).
        schema_version: Echoed into every envelope.
    """

    tick_s: float = 1.0
    _schedule: tuple[_ScheduleEntry, ...] = field(default=_SCHEDULE, repr=False)

    def build_snapshot(self, seq: int = 1) -> RealtimeMessage:
        """The initial-load / resync snapshot frame."""
        return make_message(type="snapshot", seq=seq, payload=_snapshot_payload())

    def message_at(self, step: int) -> RealtimeMessage:
        """Deterministic frame for 0-based ``step`` (step 0 = snapshot)."""
        seq = step + 1
        if step == 0:
            return self.build_snapshot(seq=seq)
        env_type, payload_factory, tier = self._schedule[(step - 1) % len(self._schedule)]
        payload = payload_factory()
        if isinstance(payload, HeartbeatPayload):
            # Stamp the heartbeat with a real server time at emit.
            import time

            payload = HeartbeatPayload(
                server_ts_ns=time.time_ns(),
                last_capture_ts_ns=time.time_ns(),
                stale=False,
            )
        return make_message(type=env_type, seq=seq, payload=payload, tier=tier, ts_pt=now_pt_iso())

    def scripted_messages(self, limit: int) -> list[RealtimeMessage]:
        """First ``limit`` frames as a list — deterministic, no I/O.

        Used by unit tests; ``[snapshot, heartbeat, CRITICAL, ...]`` so the
        first three frames already cover the acceptance criterion.
        """
        return [self.message_at(i) for i in range(limit)]

    async def emit_to(self, send: AsyncSend, *, max_messages: int | None = None) -> None:
        """Drive ``send`` with frames on the timer until cancelled / capped.

        Transport-agnostic: ``send`` is any ``async (text) -> None``. The
        FastAPI endpoint passes ``ws.send_text``; tests pass a fake sink.
        """
        step = 0
        while True:
            await send(self.message_at(step).model_dump_json())
            step += 1
            if max_messages is not None and step >= max_messages:
                return
            await asyncio.sleep(self.tick_s)


# --------------------------------------------------------------------------
# FastAPI app — the WS surface RA-060 will mirror
# --------------------------------------------------------------------------

app = FastAPI(title="RA-067 mock realtime emitter")
_emitter = MockEmitter()


@app.get("/health")
def health() -> dict[str, object]:
    """Liveness probe for the mock server."""
    return {"status": "ok", "role": "mock_emitter"}


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    """Stream synthetic contract frames until the client disconnects."""
    await websocket.accept()

    async def send(text: str) -> None:
        await websocket.send_text(text)

    try:
        await _emitter.emit_to(send)
    except WebSocketDisconnect:
        return


def main() -> None:
    """Run the mock server. ``ws://127.0.0.1:8765/ws``."""
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")


if __name__ == "__main__":
    main()
