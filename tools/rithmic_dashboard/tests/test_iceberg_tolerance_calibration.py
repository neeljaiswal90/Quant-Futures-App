from __future__ import annotations

from rithmic_dashboard.cli.calibrate_iceberg_tolerance import (
    ToleranceRow,
    _knee,
    _sweep_session,
)
from rithmic_dashboard.models import MboOrderEvent, TradeTick

BASE_NS = 1_780_000_000_000_000_000


def _mbo(
    *,
    action: str,
    ts: int,
    order_id: str,
    side: str = "A",
    price: float = 30220.0,
    size: int = 30,
    priority: str | None = None,
) -> MboOrderEvent:
    return MboOrderEvent(
        timestamp_ns=ts,
        recv_ts_ns=None,
        sequence=None,
        action="A" if action == "A" else "M" if action == "M" else "C",
        side="B" if side == "B" else "A",
        price=price,
        size=size,
        order_id=order_id,
        priority=priority,
    )


def _trade(*, ts: int, qty: int = 30, price: float = 30220.0) -> TradeTick:
    return TradeTick(timestamp_ns=ts, price=price, quantity=qty, aggressor_side="buy")


def _obs_refills(quantities: list[int]) -> tuple[tuple[MboOrderEvent, ...], list[TradeTick]]:
    """OBS-confirmed refills: each add+cancel has a matching trade at the price."""
    events: list[MboOrderEvent] = []
    trades: list[TradeTick] = []
    for i, q in enumerate(quantities):
        add_ts = BASE_NS + i * 5 * 1_000_000_000
        cancel_ts = add_ts + 10_000_000
        events.append(_mbo(action="A", ts=add_ts, order_id=f"a{i}", size=q))
        events.append(_mbo(action="C", ts=cancel_ts, order_id=f"a{i}", size=q))
        trades.append(_trade(ts=cancel_ts + 20_000_000, qty=q))
    return tuple(events), trades


def test_knee_picks_smallest_tolerance_at_90pct_of_max() -> None:
    rows = [
        ToleranceRow(5, 2, 2, 0, 0, 0),
        ToleranceRow(10, 9, 9, 0, 0, 0),
        ToleranceRow(50, 10, 10, 0, 0, 0),
        ToleranceRow(250, 10, 10, 0, 0, 0),
    ]
    # max OBS yield = 10; 90% target = 9 -> first row >= 9 is the 10ms tier.
    assert _knee(rows) == 10


def test_knee_falls_back_to_default_when_no_obs_signal() -> None:
    rows = [ToleranceRow(t, 0, 1, 1, 100, 200) for t in (5, 50, 250)]
    # all-zero OBS yield -> the detector's default tolerance (50ms).
    assert _knee(rows) == 50


def test_sweep_session_obs_confirmed_run_yields_iceberg() -> None:
    events, trades = _obs_refills([30, 25, 30, 30, 30])
    obs_i, prio_i, raw_obs, raw_prio = _sweep_session(events, trades, 50)
    assert obs_i >= 1  # OBS-confirmed refills form an iceberg
    assert raw_obs >= 1
    assert raw_prio == 0  # no priority data -> no priority-only confirmations
