from __future__ import annotations

from rithmic_dashboard.features.mbo_order_tracker import MboOrderTracker
from rithmic_dashboard.models import MboOrderEvent, TradeTick


def _mbo(
    *,
    action: str,
    side: str = "A",
    ts: int,
    order_id: str = "ord-1",
    price: float = 30220.0,
    size: int = 30,
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
    )


def _trade(*, ts: int, side: str = "buy", qty: int = 30, price: float = 30220.0) -> TradeTick:
    return TradeTick(
        timestamp_ns=ts,
        price=price,
        quantity=qty,
        aggressor_side="sell" if side == "sell" else "buy",
    )


def test_mbo_remove_requires_matching_obs_trade_confirmation() -> None:
    events = (
        _mbo(action="A", ts=1_000_000_000),
        _mbo(action="C", ts=1_010_000_000),
    )

    consumed = MboOrderTracker().process(
        events,
        [_trade(ts=1_025_000_000, side="buy", qty=30)],
    )

    assert len(consumed) == 1
    assert consumed[0].side == "A"
    assert consumed[0].aggressor_side == "buy"
    assert consumed[0].consumed_qty == 30


def test_mbo_remove_without_obs_trade_is_cancel_not_consumption() -> None:
    events = (
        _mbo(action="A", ts=1_000_000_000),
        _mbo(action="C", ts=1_010_000_000),
    )

    assert MboOrderTracker().process(events, []) == ()


def test_mbo_obs_matching_allows_fifty_ms_clock_skew_only() -> None:
    events = (
        _mbo(action="A", ts=1_000_000_000),
        _mbo(action="C", ts=1_010_000_000),
    )
    inside = MboOrderTracker().process(events, [_trade(ts=1_060_000_000, side="buy")])
    outside = MboOrderTracker().process(events, [_trade(ts=1_061_000_000, side="buy")])

    assert len(inside) == 1
    assert outside == ()


def test_mbo_trade_volume_is_not_reused_across_multiple_order_removals() -> None:
    events = (
        _mbo(action="A", ts=1_000_000_000, order_id="ord-1", size=20),
        _mbo(action="A", ts=1_001_000_000, order_id="ord-2", size=20),
        _mbo(action="C", ts=1_010_000_000, order_id="ord-1", size=20),
        _mbo(action="C", ts=1_011_000_000, order_id="ord-2", size=20),
    )

    consumed = MboOrderTracker().process(events, [_trade(ts=1_010_000_000, side="buy", qty=30)])

    assert sum(item.consumed_qty for item in consumed) == 30
