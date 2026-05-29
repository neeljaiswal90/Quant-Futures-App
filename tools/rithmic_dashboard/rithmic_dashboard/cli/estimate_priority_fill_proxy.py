"""Rithmic-only precision proxy for priority-only confirmations (RA-066 Part B-b, no databento).

A priority-only confirmation is a front-of-queue delete the channel bets was a
FILL, fired precisely because OBS found no matching trade *volume* within the
50ms tolerance. With no F/T ground truth, we proxy fill-vs-cancel by asking:
does a trade exist at that price + expected aggressor side within a WIDE window
around the delete? A real fill should leave a nearby print; a pure cancel won't.

Interpretation (this is a BOUND, not a measurement):
- fraction with a nearby trade  -> OPTIMISTIC upper bound on precision (a
  coincidental print at the price inflates it);
- fraction with NO trade at the price+side within the widest window -> near-certain
  cancels (a strong lower bound on the cancel rate).
The true precision sits at or below the upper bound. Use it to decide whether
buying ~9 days of databento for a gold-standard number is worth it.
"""

from __future__ import annotations

import argparse
import bisect
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from rithmic_dashboard.cli.calibrate_iceberg_thresholds import _session_pairs
from rithmic_dashboard.features.live_signals import DEFAULT_TAIL_BYTES, load_trade_ticks_from_tail
from rithmic_dashboard.features.mbo_order_tracker import (
    _SOURCE_PRIORITY,
    ConsumedOrder,
    MboOrderTracker,
    load_mbo_events_from_tail,
)
from rithmic_dashboard.models import TradeTick

TICK = 0.25
WINDOWS_MS: tuple[int, ...] = (50, 250, 500, 1000, 2000)


def index_trades(ticks: list[TradeTick]) -> dict[tuple[int, str], list[int]]:
    """(price-bucket, aggressor_side) -> sorted trade timestamps (ns)."""
    idx: dict[tuple[int, str], list[int]] = defaultdict(list)
    for t in ticks:
        if t.timestamp_ns is None or t.aggressor_side not in ("buy", "sell"):
            continue
        idx[(round(t.price / TICK), t.aggressor_side)].append(t.timestamp_ns)
    for series in idx.values():
        series.sort()
    return idx


def nearest_delta_ns(sorted_ts: list[int], ts: int) -> int | None:
    """Smallest |Δt| from ``ts`` to any timestamp in the sorted list, or None."""
    if not sorted_ts:
        return None
    i = bisect.bisect_left(sorted_ts, ts)
    best: int | None = None
    for j in (i - 1, i):
        if 0 <= j < len(sorted_ts):
            d = abs(sorted_ts[j] - ts)
            if best is None or d < best:
                best = d
    return best


@dataclass(frozen=True)
class ProxyStats:
    total: int
    within: tuple[int, ...]  # cumulative count with a trade within WINDOWS_MS[k]
    none_within_max: int  # no trade at price+side within the widest window


def proxy_stats(confirmations: list[ConsumedOrder], ticks: list[TradeTick]) -> ProxyStats:
    idx = index_trades(ticks)
    windows_ns = [w * 1_000_000 for w in WINDOWS_MS]
    within = [0] * len(WINDOWS_MS)
    none_within_max = 0
    for c in confirmations:
        key = (round(c.price / TICK), c.aggressor_side)
        d = nearest_delta_ns(idx.get(key, []), c.consume_ts_ns)
        if d is None or d > windows_ns[-1]:
            none_within_max += 1
        for k, wn in enumerate(windows_ns):
            if d is not None and d <= wn:
                within[k] += 1
    return ProxyStats(
        total=len(confirmations), within=tuple(within), none_within_max=none_within_max
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--analytics-root",
        type=Path,
        default=Path(__file__).resolve().parents[2].parent / "rithmic_analytics",
    )
    parser.add_argument("--symbol", default="MNQ")
    parser.add_argument("--lookback-sessions", type=int, default=14)
    parser.add_argument("--tail-bytes", type=int, default=DEFAULT_TAIL_BYTES)
    parser.add_argument("--match-tolerance-ms", type=int, default=50)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    captures_root = args.analytics_root / "data" / "captures"
    pairs, _ = _session_pairs(captures_root, symbol=args.symbol)
    pairs = pairs[: args.lookback_sessions]
    if not pairs:
        print("no MBO capture pairs found", file=sys.stderr)
        return 2

    total = none_max = used = 0
    within = [0] * len(WINDOWS_MS)
    for pair in pairs:
        mbo = load_mbo_events_from_tail(pair.mbo_path, tail_bytes=args.tail_bytes)
        ticks = load_trade_ticks_from_tail(pair.obs_path, tail_bytes=args.tail_bytes)
        if not mbo.events or not ticks:
            continue
        consumed = MboOrderTracker(match_tolerance_ms=args.match_tolerance_ms).process(
            mbo.events, ticks
        )
        prio = [c for c in consumed if c.confirmation_source == _SOURCE_PRIORITY]
        if not prio:
            continue
        used += 1
        stats = proxy_stats(prio, ticks)
        total += stats.total
        none_max += stats.none_within_max
        for k in range(len(WINDOWS_MS)):
            within[k] += stats.within[k]

    if total == 0:
        print("no priority-only confirmations found (priority-bearing captures?)", file=sys.stderr)
        return 2

    print(f"priority-only fill proxy: sessions_used={used} confirmations={total}")
    for k, w in enumerate(WINDOWS_MS):
        pct = 100 * within[k] / total
        print(f"  trade at price+side within +/-{w:>4}ms: {within[k]:>7} ({pct:5.1f}%)")
    print(
        f"  NO trade within +/-{WINDOWS_MS[-1]}ms (near-certain cancels): "
        f"{none_max} ({100 * none_max / total:.1f}%)"
    )
    upper = 100 * within[-1] / total
    cancel_lo = 100 * none_max / total
    print(
        f"  => precision UPPER bound ~{upper:.1f}% (optimistic); "
        f"cancel LOWER bound ~{cancel_lo:.1f}%. True precision <= upper."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
