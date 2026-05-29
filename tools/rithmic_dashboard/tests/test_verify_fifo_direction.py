from __future__ import annotations

from rithmic_dashboard.cli.verify_fifo_direction import monotonic_stats
from rithmic_dashboard.models import MboOrderEvent


def _add(*, ts: int, order_id: str, priority: str, price: float = 30220.0) -> MboOrderEvent:
    return MboOrderEvent(
        timestamp_ns=ts,
        recv_ts_ns=None,
        sequence=None,
        action="A",
        side="A",
        price=price,
        size=5,
        order_id=order_id,
        priority=priority,
    )


def test_rising_priority_with_arrival_is_all_increasing() -> None:
    # Same level; later arrivals carry higher tokens -> all adjacent pairs increasing.
    events = [_add(ts=1_000 + i, order_id=f"o{i}", priority=str(100 + i * 10)) for i in range(5)]
    stats = monotonic_stats(events)
    assert stats.increasing_pairs == 4
    assert stats.decreasing_pairs == 0
    assert stats.increasing_fraction == 1.0


def test_falling_priority_with_arrival_is_all_decreasing() -> None:
    events = [_add(ts=1_000 + i, order_id=f"o{i}", priority=str(500 - i * 10)) for i in range(5)]
    stats = monotonic_stats(events)
    assert stats.decreasing_pairs == 4
    assert stats.increasing_fraction == 0.0


def test_levels_are_separated_by_price_bucket() -> None:
    # Two price levels, each internally increasing; no cross-level pairs counted.
    a = [_add(ts=10 + i, order_id=f"a{i}", priority=str(100 + i), price=30220.0) for i in range(3)]
    b = [_add(ts=20 + i, order_id=f"b{i}", priority=str(900 + i), price=30225.0) for i in range(3)]
    stats = monotonic_stats(a + b)
    assert stats.levels == 2
    assert stats.increasing_pairs == 4  # 2 per level
    assert stats.decreasing_pairs == 0


def test_non_add_and_missing_priority_ignored() -> None:
    events = [
        _add(ts=1, order_id="o1", priority="100"),
        MboOrderEvent(
            timestamp_ns=2, recv_ts_ns=None, sequence=None, action="C", side="A",
            price=30220.0, size=5, order_id="o1", priority="999",
        ),  # cancel -> ignored
        _add(ts=3, order_id="o2", priority=""),  # non-numeric priority -> ignored
        _add(ts=4, order_id="o3", priority="200"),
    ]
    stats = monotonic_stats(events)
    # Only o1 (100) and o3 (200) count -> one increasing pair.
    assert stats.increasing_pairs == 1
    assert stats.decreasing_pairs == 0
