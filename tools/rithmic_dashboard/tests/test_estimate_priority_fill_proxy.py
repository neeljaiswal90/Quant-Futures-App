from __future__ import annotations

from rithmic_dashboard.cli.estimate_priority_fill_proxy import (
    index_trades,
    nearest_delta_ns,
    proxy_stats,
)
from rithmic_dashboard.features.mbo_order_tracker import _SOURCE_PRIORITY, ConsumedOrder
from rithmic_dashboard.models import TradeTick

PX = 30220.0


def _tick(*, ts: int, side: str = "sell", price: float = PX) -> TradeTick:
    return TradeTick(timestamp_ns=ts, price=price, quantity=5, aggressor_side=side)


def _consumed(*, ts: int, source: str, side: str = "B", aggressor: str = "sell") -> ConsumedOrder:
    return ConsumedOrder(
        order_id="o",
        side="B" if side == "B" else "A",
        price=PX,
        visible_size=5,
        consumed_qty=5,
        aggressor_side="sell" if aggressor == "sell" else "buy",
        add_ts_ns=ts - 1000,
        consume_ts_ns=ts,
        confirmation_source=source,
    )


def test_index_and_nearest_delta() -> None:
    idx = index_trades([_tick(ts=1_000), _tick(ts=5_000), _tick(ts=9_000)])
    key = (round(PX / 0.25), "sell")
    assert nearest_delta_ns(idx[key], 4_900) == 100  # nearest is 5_000
    assert nearest_delta_ns(idx[key], 1_000) == 0
    assert nearest_delta_ns([], 1) is None


def test_proxy_counts_nearby_and_orphan_confirmations() -> None:
    # One priority-only confirmation WITH a print 200ms away (a likely fill),
    # one WITH NO print at the price+side (a near-certain cancel).
    ms = 1_000_000
    near = _consumed(ts=10 * ms, source=_SOURCE_PRIORITY)
    orphan = _consumed(ts=10_000 * ms, source=_SOURCE_PRIORITY)  # far from any trade
    # a sell-aggressor print 200ms after `near`'s consume_ts (near is at 10*ms)
    ticks = [_tick(ts=10 * ms + 200 * ms)]
    stats = proxy_stats([near, orphan], ticks)
    assert stats.total == 2
    # near: trade 200ms away -> counted from the 250ms window up, not the 50ms one
    assert stats.within[0] == 0  # ±50ms
    assert stats.within[1] == 1  # ±250ms
    assert stats.within[-1] == 1  # ±2000ms
    # orphan: no trade within 2s
    assert stats.none_within_max == 1


def test_only_expected_aggressor_side_matches() -> None:
    ms = 1_000_000
    # resting bid (side B) -> expected aggressor "sell"; a BUY print must NOT match.
    c = _consumed(ts=10 * ms, source=_SOURCE_PRIORITY, side="B", aggressor="sell")
    buy_only = [_tick(ts=10 * ms + 5 * ms, side="buy")]
    stats = proxy_stats([c], buy_only)
    assert stats.within[-1] == 0
    assert stats.none_within_max == 1
