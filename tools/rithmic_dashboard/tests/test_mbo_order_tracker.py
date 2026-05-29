from __future__ import annotations

from rithmic_dashboard.features.mbo_order_tracker import (
    _SOURCE_OBS,
    _SOURCE_OBS_PRIORITY,
    _SOURCE_PRIORITY,
    MboOrderTracker,
    _parse_priority,
)
from rithmic_dashboard.models import MboOrderEvent, TradeTick


def _mbo(
    *,
    action: str,
    side: str = "A",
    ts: int,
    order_id: str = "ord-1",
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


# ---------------------------------------------------------------------------
# RA-065: priority confirmation channel
# ---------------------------------------------------------------------------


def test_ra065_parse_priority_defensive() -> None:
    assert _parse_priority(None) is None
    assert _parse_priority("104910029946") == 104910029946
    assert _parse_priority("  12  ") == 12
    assert _parse_priority("not-a-number") is None
    assert _parse_priority("1.5") is None  # floats are not queue positions


def test_ra065_all_none_priority_path_is_byte_exact_obs_tag() -> None:
    """BYTE-EXACT GATE (tracker side): with priority absent on every event, the
    OBS-confirmed ConsumedOrder is numerically identical to the legacy path and
    keeps confirmation_source='obs_trade_tail'."""
    events = (
        _mbo(action="A", ts=1_000_000_000),
        _mbo(action="C", ts=1_010_000_000),
    )
    consumed = MboOrderTracker().process(events, [_trade(ts=1_025_000_000, side="buy", qty=30)])
    assert len(consumed) == 1
    c = consumed[0]
    assert c.confirmation_source == _SOURCE_OBS
    assert c.priority is None
    assert c.consumed_qty == 30
    assert c.side == "A"
    assert c.aggressor_side == "buy"


def test_ra065_queue_position_one_delete_confirms_without_obs() -> None:
    """Either-channel: an order at queue-position-1 that deletes is confirmed as
    consumption even with NO OBS trade. Tagged 'priority_queue'; consumed_qty is
    the visible size."""
    # Two same-bucket asks; ord-front has the lower (ascending=front) priority.
    events = (
        _mbo(action="A", ts=1_000_000_000, order_id="front", size=12, priority="100"),
        _mbo(action="A", ts=1_001_000_000, order_id="back", size=7, priority="200"),
        _mbo(action="C", ts=1_010_000_000, order_id="front", size=12, priority="100"),
    )
    consumed = MboOrderTracker().process(events, [])  # no trades at all
    assert len(consumed) == 1
    c = consumed[0]
    assert c.order_id == "front"
    assert c.confirmation_source == _SOURCE_PRIORITY
    assert c.consumed_qty == 12  # visible size
    assert c.priority == "100"


def test_ra065_back_of_queue_delete_without_obs_is_still_a_cancel() -> None:
    """Priority is NOT a necessary condition and a back-of-queue delete with no
    OBS trade stays a cancel (not consumption) — the priority channel only adds
    front-of-queue confirmations, never relaxes the OBS path."""
    events = (
        _mbo(action="A", ts=1_000_000_000, order_id="front", size=12, priority="100"),
        _mbo(action="A", ts=1_001_000_000, order_id="back", size=7, priority="200"),
        _mbo(action="C", ts=1_010_000_000, order_id="back", size=7, priority="200"),
    )
    assert MboOrderTracker().process(events, []) == ()


def test_ra065_both_channels_agree_tags_obs_plus_priority_and_keeps_obs_qty() -> None:
    """When OBS and the queue-position channel both fire, the OBS-derived
    consumed_qty is preserved (RA-059 numerics untouched) and the source is
    'obs+priority'."""
    events = (
        _mbo(action="A", ts=1_000_000_000, order_id="front", size=30, priority="100"),
        _mbo(action="C", ts=1_010_000_000, order_id="front", size=30, priority="100"),
    )
    # OBS trade qty (25) differs from visible size (30) → confirm OBS qty wins.
    consumed = MboOrderTracker().process(events, [_trade(ts=1_020_000_000, side="buy", qty=25)])
    assert len(consumed) == 1
    c = consumed[0]
    assert c.confirmation_source == _SOURCE_OBS_PRIORITY
    assert c.consumed_qty == 25  # OBS-derived, NOT visible_size


def test_ra065_fifo_direction_is_a_single_flippable_param() -> None:
    """RA-066 hook: flipping fifo_ascending_is_front makes the HIGH-priority
    order the front of the queue instead of the low one."""
    events = (
        _mbo(action="A", ts=1_000_000_000, order_id="low", size=5, priority="100"),
        _mbo(action="A", ts=1_001_000_000, order_id="high", size=5, priority="200"),
        _mbo(action="C", ts=1_010_000_000, order_id="high", size=5, priority="200"),
    )
    # Descending-is-front → the high-priority order is queue-position-1.
    tracker = MboOrderTracker(fifo_ascending_is_front=False)
    consumed = tracker.process(events, [])
    assert len(consumed) == 1
    assert consumed[0].order_id == "high"
    assert consumed[0].confirmation_source == _SOURCE_PRIORITY


def test_ra065_priority_jump_refill_flag_set_on_add() -> None:
    """A fresh add whose priority jumps past the prior queue tail at the same
    (price, side) within the refill window is flagged as a refresh candidate."""
    tracker = MboOrderTracker()
    base = 1_000_000_000
    tracker.process(
        (
            _mbo(action="A", ts=base, order_id="o1", size=5, priority="100"),
            # o2 surfaces BEHIND the tail (higher priority, ascending=front) shortly after.
            _mbo(action="A", ts=base + 1_000_000, order_id="o2", size=5, priority="500"),
        ),
        [],
    )
    assert tracker.active["o1"].refill_by_priority_jump is False  # first add, no prior tail
    assert tracker.active["o2"].refill_by_priority_jump is True


def test_ra065_non_numeric_priority_is_inert() -> None:
    """A non-numeric vendor priority neither breaks tracking nor activates the
    priority channel — behaves like the all-None path (OBS only)."""
    events = (
        _mbo(action="A", ts=1_000_000_000, order_id="x", priority="GARBAGE"),
        _mbo(action="C", ts=1_010_000_000, order_id="x", priority="GARBAGE"),
    )
    # No OBS trade → must stay a cancel (priority can't confirm without a parse).
    assert MboOrderTracker().process(events, []) == ()
    # With OBS trade → confirmed via OBS only, legacy tag.
    consumed = MboOrderTracker().process(events, [_trade(ts=1_020_000_000, side="buy", qty=30)])
    assert len(consumed) == 1
    assert consumed[0].confirmation_source == _SOURCE_OBS


def test_ra065_priority_index_pruned_under_overflow_eviction() -> None:
    """The priority index is maintained in lockstep with eviction — no leak
    under busy-open churn (RA-052)."""
    tracker = MboOrderTracker(max_active_orders=2)
    base = 1_000_000_000
    events = tuple(
        _mbo(action="A", ts=base + i, order_id=f"o{i}", price=30000.0 + i * 0.25,
             size=5, priority=str(100 + i))
        for i in range(10)
    )
    tracker.process(events, [])
    # active is bounded by max_active_orders; the index must not exceed it either.
    assert len(tracker.active) <= 2
    total_indexed = sum(len(bucket) for bucket in tracker._priority_index.values())
    assert total_indexed <= 2
