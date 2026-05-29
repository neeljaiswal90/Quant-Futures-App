"""Calibrate iceberg ``match_tolerance_ms`` + quantify the RA-065 priority channel.

RA-066 Part A (runnable on local Rithmic captures). Two questions this answers:

1. **OBS-trade-tail tolerance knee.** Sweep ``match_tolerance_ms`` over a grid and
   measure iceberg YIELD with the priority channel OFF (the production default).
   The knee — the smallest tolerance capturing most of the OBS signal — is the
   recommended default; tighter rejects coincidental same-price trades, looser
   risks false confirmations.

2. **What flipping ``admit_priority_confirmation`` would do.** At each tolerance,
   also run with the priority channel ON and report the iceberg delta, plus the
   raw count of priority-only consumption confirmations (OBS silent, order at
   front of its FIFO queue). This quantifies RA-065's added signal.

What this does NOT do: validate the FIFO sort direction
(``FIFO_ASCENDING_IS_FRONT``) — that needs F/T ground truth (databento), which is
RA-066 Part B and the gate for actually flipping the channel on. Until Part B
passes, ``admit_priority_confirmation`` stays False (RA-069). See docs/tickets.md.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

from rithmic_dashboard.cli.calibrate_iceberg_thresholds import _session_pairs
from rithmic_dashboard.features.iceberg_detector import IcebergDetectorConfig, detect_icebergs
from rithmic_dashboard.features.live_signals import DEFAULT_TAIL_BYTES, load_trade_ticks_from_tail
from rithmic_dashboard.features.mbo_order_tracker import (
    _SOURCE_PRIORITY,
    MboOrderTracker,
    load_mbo_events_from_tail,
)
from rithmic_dashboard.models import MboOrderEvent, TradeTick

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ANALYTICS_ROOT = PROJECT_ROOT.parent / "rithmic_analytics"
DEFAULT_OUTPUT = PROJECT_ROOT / "data" / "live_analysis" / "iceberg_tolerance_sweep.json"
DEFAULT_SYMBOL = "MNQ"
TOLERANCE_GRID_MS: tuple[int, ...] = (5, 10, 25, 50, 100, 150, 250)
# Knee = smallest tolerance reaching this fraction of the max OBS-only yield.
KNEE_FRACTION = 0.90


@dataclass(frozen=True)
class ToleranceRow:
    tolerance_ms: int
    obs_icebergs: int
    priority_icebergs: int
    priority_iceberg_delta: int
    raw_obs_consumptions: int
    raw_priority_only_consumptions: int


@dataclass(frozen=True)
class ToleranceSweepResult:
    symbol: str
    generated_at_utc: str
    sessions_used: int
    sessions_scanned: int
    tail_bytes: int
    rows: tuple[ToleranceRow, ...]
    recommended_match_tolerance_ms: int
    priority_channel_note: str
    rejected_sessions: tuple[str, ...]


def _sweep_session(
    mbo_events: tuple[MboOrderEvent, ...],
    ticks: list[TradeTick],
    tolerance_ms: int,
) -> tuple[int, int, int, int]:
    """One session × tolerance: (obs_icebergs, prio_icebergs, raw_obs, raw_prio_only)."""
    cfg_obs = IcebergDetectorConfig(match_tolerance_ms=tolerance_ms)
    cfg_prio = IcebergDetectorConfig(
        match_tolerance_ms=tolerance_ms, admit_priority_confirmation=True
    )
    obs_icebergs = len(
        detect_icebergs(mbo_events=mbo_events, trades=ticks, levels=[], config=cfg_obs)
    )
    prio_icebergs = len(
        detect_icebergs(mbo_events=mbo_events, trades=ticks, levels=[], config=cfg_prio)
    )
    consumed = MboOrderTracker(match_tolerance_ms=tolerance_ms).process(mbo_events, ticks)
    raw_prio_only = sum(1 for c in consumed if c.confirmation_source == _SOURCE_PRIORITY)
    raw_obs = len(consumed) - raw_prio_only
    return obs_icebergs, prio_icebergs, raw_obs, raw_prio_only


def calibrate_tolerance(
    captures_root: Path,
    *,
    symbol: str = DEFAULT_SYMBOL,
    lookback_sessions: int = 30,
    tail_bytes: int = DEFAULT_TAIL_BYTES,
    grid: tuple[int, ...] = TOLERANCE_GRID_MS,
) -> ToleranceSweepResult | None:
    pairs, rejected = _session_pairs(captures_root, symbol=symbol)
    pairs = pairs[:lookback_sessions]
    loaded: list[tuple[tuple[MboOrderEvent, ...], list[TradeTick]]] = []
    rejected_reasons = list(rejected)
    for pair in pairs:
        mbo = load_mbo_events_from_tail(pair.mbo_path, tail_bytes=tail_bytes)
        ticks = load_trade_ticks_from_tail(pair.obs_path, tail_bytes=tail_bytes)
        if not mbo.events or not ticks:
            rejected_reasons.append(f"{pair.mbo_path.parent.name}/{pair.mbo_path.name}: empty tail")
            continue
        loaded.append((mbo.events, ticks))
    if not loaded:
        return None

    rows: list[ToleranceRow] = []
    for tol in grid:
        obs_i = prio_i = raw_obs = raw_prio = 0
        for mbo_events, ticks in loaded:
            o, p, ro, rp = _sweep_session(mbo_events, ticks, tol)
            obs_i += o
            prio_i += p
            raw_obs += ro
            raw_prio += rp
        rows.append(
            ToleranceRow(
                tolerance_ms=tol,
                obs_icebergs=obs_i,
                priority_icebergs=prio_i,
                priority_iceberg_delta=prio_i - obs_i,
                raw_obs_consumptions=raw_obs,
                raw_priority_only_consumptions=raw_prio,
            )
        )

    recommended = _knee(rows)
    note = _priority_note(rows, recommended)
    return ToleranceSweepResult(
        symbol=symbol,
        generated_at_utc=datetime.now(UTC).isoformat(),
        sessions_used=len(loaded),
        sessions_scanned=len(pairs),
        tail_bytes=tail_bytes,
        rows=tuple(rows),
        recommended_match_tolerance_ms=recommended,
        priority_channel_note=note,
        rejected_sessions=tuple(rejected_reasons),
    )


def _knee(rows: list[ToleranceRow]) -> int:
    """Smallest tolerance reaching KNEE_FRACTION of the max OBS-only yield."""
    if not rows:
        return IcebergDetectorConfig().match_tolerance_ms
    max_yield = max(r.obs_icebergs for r in rows)
    if max_yield <= 0:
        return IcebergDetectorConfig().match_tolerance_ms
    target = KNEE_FRACTION * max_yield
    for r in rows:  # rows are in ascending-tolerance order
        if r.obs_icebergs >= target:
            return r.tolerance_ms
    return rows[-1].tolerance_ms


def _priority_note(rows: list[ToleranceRow], tol: int) -> str:
    row = next((r for r in rows if r.tolerance_ms == tol), None)
    if row is None:
        return "no data"
    return (
        f"At {tol}ms: OBS icebergs={row.obs_icebergs}, "
        f"with-priority={row.priority_icebergs} (delta {row.priority_iceberg_delta:+d}); "
        f"raw consumptions OBS={row.raw_obs_consumptions} "
        f"priority-only={row.raw_priority_only_consumptions}. "
        "admit_priority_confirmation stays False until RA-066 Part B (databento "
        "F/T FIFO validation) confirms the priority-only deletes are real fills."
    )


def write_result_atomic(path: Path, result: ToleranceSweepResult) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(asdict(result), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--analytics-root", type=Path, default=DEFAULT_ANALYTICS_ROOT)
    parser.add_argument("--symbol", default=DEFAULT_SYMBOL)
    parser.add_argument("--lookback-sessions", type=int, default=30)
    parser.add_argument("--tail-bytes", type=int, default=DEFAULT_TAIL_BYTES)
    parser.add_argument("--output-path", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    captures_root = args.analytics_root / "data" / "captures"
    result = calibrate_tolerance(
        captures_root,
        symbol=args.symbol,
        lookback_sessions=args.lookback_sessions,
        tail_bytes=args.tail_bytes,
    )
    if result is None:
        print("insufficient calibration data: no MBO/OBS session pairs", file=sys.stderr)
        return 2
    write_result_atomic(args.output_path, result)
    print(
        f"iceberg tolerance sweep symbol={result.symbol} "
        f"sessions={result.sessions_used}/{result.sessions_scanned} "
        f"recommended_match_tolerance_ms={result.recommended_match_tolerance_ms}"
    )
    for r in result.rows:
        print(
            f"  {r.tolerance_ms:>4}ms  obs_icebergs={r.obs_icebergs:<4} "
            f"with_priority={r.priority_icebergs:<4} (delta {r.priority_iceberg_delta:+d})  "
            f"raw_obs={r.raw_obs_consumptions:<6} "
            f"raw_priority_only={r.raw_priority_only_consumptions}"
        )
    print(result.priority_channel_note)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
