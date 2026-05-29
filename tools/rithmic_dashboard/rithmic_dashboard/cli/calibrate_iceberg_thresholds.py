"""Calibrate inferred iceberg thresholds from recent MBO/OBS capture tails."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

from rithmic_dashboard.features.iceberg_detector import IcebergDetectorConfig, detect_icebergs
from rithmic_dashboard.features.live_signals import DEFAULT_TAIL_BYTES, load_trade_ticks_from_tail
from rithmic_dashboard.features.mbo_order_tracker import load_mbo_events_from_tail

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ANALYTICS_ROOT = PROJECT_ROOT.parent / "rithmic_analytics"
DEFAULT_OUTPUT = PROJECT_ROOT / "data" / "live_analysis" / "iceberg_thresholds.json"
DEFAULT_SYMBOL = "MNQ"
TARGET_EVENTS_PER_SESSION = 7.5


@dataclass(frozen=True)
class SessionPair:
    mbo_path: Path
    obs_path: Path


@dataclass(frozen=True)
class CalibrationResult:
    symbol: str
    generated_at_utc: str
    thresholds: dict[str, int | float | bool]
    avg_events_per_session: float
    sessions_used: int
    sessions_scanned: int
    rejected_sessions: tuple[str, ...]
    event_counts: dict[str, int]


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    captures_root = args.analytics_root / "data" / "captures"
    result = calibrate_iceberg_thresholds(
        captures_root,
        symbol=args.symbol,
        lookback_sessions=args.lookback_sessions,
        tail_bytes=args.tail_bytes,
        min_sessions=args.min_sessions,
    )
    if result is None:
        print("insufficient iceberg calibration data: no MBO/OBS session pairs", file=sys.stderr)
        return 2
    write_calibration_atomic(args.output_path, result)
    print(
        "calibrated iceberg thresholds "
        f"symbol={result.symbol} "
        f"sessions={result.sessions_used}/{result.sessions_scanned} "
        f"avg_events={result.avg_events_per_session:.2f} "
        f"output={args.output_path}"
    )
    return 0


def calibrate_iceberg_thresholds(
    captures_root: Path,
    *,
    symbol: str = DEFAULT_SYMBOL,
    lookback_sessions: int = 30,
    tail_bytes: int = DEFAULT_TAIL_BYTES,
    min_sessions: int = 1,
) -> CalibrationResult | None:
    """Grid-search thresholds toward a 5-10 event/session operational target."""

    pairs, rejected = _session_pairs(captures_root, symbol=symbol)
    pairs = pairs[:lookback_sessions]
    if len(pairs) < min_sessions:
        return None

    session_payloads = []
    rejected_reasons = list(rejected)
    for pair in pairs:
        mbo = load_mbo_events_from_tail(pair.mbo_path, tail_bytes=tail_bytes)
        ticks = load_trade_ticks_from_tail(pair.obs_path, tail_bytes=tail_bytes)
        if not mbo.events or not ticks:
            rejected_reasons.append(f"{pair.mbo_path.parent.name}/{pair.mbo_path.name}: empty tail")
            continue
        session_payloads.append((pair, mbo.events, ticks))
    if len(session_payloads) < min_sessions:
        return None

    best_config = IcebergDetectorConfig()
    best_counts: dict[str, int] = {}
    best_avg = 0.0
    best_score = float("inf")
    for config in _candidate_configs():
        counts: dict[str, int] = {}
        for pair, mbo_events, ticks in session_payloads:
            count = len(
                detect_icebergs(
                    mbo_events=mbo_events,
                    trades=ticks,
                    levels=[],
                    config=config,
                )
            )
            counts[f"{pair.mbo_path.parent.name}/{pair.mbo_path.name}"] = count
        avg = sum(counts.values()) / max(1, len(counts))
        score = abs(avg - TARGET_EVENTS_PER_SESSION)
        if score < best_score:
            best_score = score
            best_config = config
            best_counts = counts
            best_avg = avg

    return CalibrationResult(
        symbol=symbol,
        generated_at_utc=datetime.now(UTC).isoformat(),
        thresholds={
            "min_refills": best_config.min_refills,
            "refill_window_seconds": best_config.refill_window_seconds,
            "size_consistency_pct": best_config.size_consistency_pct,
            "aggressor_side_consistent": best_config.aggressor_side_consistent,
            "min_total_consumed": best_config.min_total_consumed,
            "stack_window_minutes": best_config.stack_window_minutes,
            "level_proximity_pts": best_config.level_proximity_pts,
            "match_tolerance_ms": best_config.match_tolerance_ms,
        },
        avg_events_per_session=best_avg,
        sessions_used=len(session_payloads),
        sessions_scanned=len(pairs),
        rejected_sessions=tuple(rejected_reasons),
        event_counts=best_counts,
    )


def write_calibration_atomic(path: Path, result: CalibrationResult) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(asdict(result), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def _candidate_configs() -> list[IcebergDetectorConfig]:
    configs: list[IcebergDetectorConfig] = []
    for min_refills in (3, 4, 5):
        for min_total_consumed in (50, 75, 100):
            for consistency in (0.30, 0.40, 0.50):
                configs.append(
                    IcebergDetectorConfig(
                        min_refills=min_refills,
                        min_total_consumed=min_total_consumed,
                        size_consistency_pct=consistency,
                    )
                )
    return configs


def _session_pairs(captures_root: Path, *, symbol: str) -> tuple[list[SessionPair], list[str]]:
    pairs: list[SessionPair] = []
    rejected: list[str] = []
    if not captures_root.exists():
        return [], [f"missing captures root: {captures_root}"]
    for mbo_path in sorted(captures_root.glob(f"*/{symbol}_*.mbo.jsonl"), reverse=True):
        prefix = mbo_path.name.removesuffix(".mbo.jsonl")
        obs_path = mbo_path.with_name(f"{prefix}.obs01.jsonl")
        if not obs_path.exists():
            rejected.append(f"{mbo_path.parent.name}/{mbo_path.name}: missing obs01 sibling")
            continue
        pairs.append(SessionPair(mbo_path=mbo_path, obs_path=obs_path))
    return pairs, rejected


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--analytics-root", type=Path, default=DEFAULT_ANALYTICS_ROOT)
    parser.add_argument("--symbol", default=DEFAULT_SYMBOL)
    parser.add_argument("--lookback-sessions", type=int, default=30)
    parser.add_argument("--tail-bytes", type=int, default=DEFAULT_TAIL_BYTES)
    parser.add_argument("--min-sessions", type=int, default=1)
    parser.add_argument("--output-path", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args(argv)


if __name__ == "__main__":
    raise SystemExit(main())
