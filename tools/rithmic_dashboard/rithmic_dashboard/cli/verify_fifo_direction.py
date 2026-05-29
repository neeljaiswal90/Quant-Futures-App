"""Verify ``FIFO_ASCENDING_IS_FRONT`` from Rithmic captures alone (RA-066 Part B-a).

No databento / F-T needed. Rithmic's ``depth_order_priority`` is a large
monotonically-increasing token. This checks whether, WITHIN a (price-bucket, side)
level, the token rises with arrival time across consecutive ADDs. If it does, the
oldest order at a level — the front of the FIFO queue, which fills first — carries
the LOWEST token, so ``min(token) == front`` and ``FIFO_ASCENDING_IS_FRONT=True``
(the current setting, where ``_is_at_queue_front`` treats min as front) is correct.

Outputs the fraction of within-level adjacent ADD pairs that are monotonic-
increasing in priority. ~1.0 confirms True; ~0.0 would say flip it to False.
"""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from rithmic_dashboard.cli.calibrate_iceberg_thresholds import _session_pairs
from rithmic_dashboard.features.live_signals import DEFAULT_TAIL_BYTES
from rithmic_dashboard.features.mbo_order_tracker import (
    _parse_priority,
    load_mbo_events_from_tail,
)
from rithmic_dashboard.models import MboOrderEvent

TICK = 0.25


@dataclass(frozen=True)
class MonotonicStats:
    increasing_pairs: int
    decreasing_pairs: int
    equal_pairs: int
    levels: int

    @property
    def directional_pairs(self) -> int:
        return self.increasing_pairs + self.decreasing_pairs

    @property
    def increasing_fraction(self) -> float:
        return self.increasing_pairs / self.directional_pairs if self.directional_pairs else 0.0


def monotonic_stats(events: tuple[MboOrderEvent, ...] | list[MboOrderEvent]) -> MonotonicStats:
    """Per (price-bucket, side) level, count adjacent ADD pairs (in arrival order)
    whose priority token rises vs falls. Events must already be time-sorted."""
    by_level: dict[tuple[int, str], list[int]] = defaultdict(list)
    for ev in events:
        if ev.action != "A":
            continue
        prio = _parse_priority(ev.priority)
        if prio is None:
            continue
        by_level[(round(ev.price / TICK), ev.side)].append(prio)

    inc = dec = eq = 0
    levels = 0
    for series in by_level.values():
        if len(series) < 2:
            continue
        levels += 1
        for prev, cur in zip(series, series[1:], strict=False):
            if cur > prev:
                inc += 1
            elif cur < prev:
                dec += 1
            else:
                eq += 1
    return MonotonicStats(increasing_pairs=inc, decreasing_pairs=dec, equal_pairs=eq, levels=levels)


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
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    captures_root = args.analytics_root / "data" / "captures"
    pairs, _ = _session_pairs(captures_root, symbol=args.symbol)
    pairs = pairs[: args.lookback_sessions]
    if not pairs:
        print("no MBO capture pairs found", file=sys.stderr)
        return 2

    inc = dec = eq = levels = 0
    used = 0
    for pair in pairs:
        result = load_mbo_events_from_tail(pair.mbo_path, tail_bytes=args.tail_bytes)
        if not result.events:
            continue
        stats = monotonic_stats(result.events)
        if stats.directional_pairs == 0:
            continue
        used += 1
        inc += stats.increasing_pairs
        dec += stats.decreasing_pairs
        eq += stats.equal_pairs
        levels += stats.levels

    agg = MonotonicStats(inc, dec, eq, levels)
    frac = agg.increasing_fraction
    if frac >= 0.95:
        verdict = "CONFIRMED True (priority rises with arrival -> min token = front)"
    elif frac <= 0.05:
        verdict = "FLIP to False (priority falls with arrival -> max token = front)"
    else:
        verdict = "INCONCLUSIVE (token not monotonic with arrival at levels)"
    print(
        f"FIFO direction check: sessions_used={used} levels={levels} "
        f"adjacent_add_pairs={agg.directional_pairs} (equal={eq})"
    )
    print(f"  increasing_fraction={frac:.4f}  -> FIFO_ASCENDING_IS_FRONT {verdict}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
