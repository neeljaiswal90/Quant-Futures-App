"""RA-112e step 10 / Move 3 — tail-cap calibration pre-compute.

Scans the last N completed sessions' obs01 capture streams, computes
overlapping 60-min realized ranges (high - low across each window), pools
the windows across sessions, and writes a per-session-kind percentile
artifact consumed by sigma_zones_v3 at runtime.

Hard rules per the methodology spec:

  * **Prior completed sessions only.** Never include the as-of date — that
    would leak future data into today's cap.
  * **Per-session-kind file.** MNQ_RTH and MNQ_GLOBEX have very different
    volatility profiles; one global p99 would be wrong for both.
  * **Last-valid-on-failure.** This script does NOT delete an existing file
    on failure; the runtime falls back to the prior valid calibration. A
    refresh writes to a temp file, fsyncs, then renames atomically.

The runtime consumer is :mod:`realtime_backend.sigma_zones_v3` (not yet
extended at this commit — that's step 4 of the build). This script ships
*first* so we have calibration data to A/B against the legacy ATR cap.

Usage:
    python -m realtime_backend.calibration.compute_tail_cap \\
        --captures-root D:/Quant-futures-app/tools/rithmic_analytics/data/captures \\
        --session-kind rth \\
        --lookback 20 \\
        --as-of 2026-06-02 \\
        --out-dir D:/Quant-futures-app/data/calibration

Top-window diagnostics (no file write):
    python -m ... --session-kind rth --as-of 2026-06-02 \\
        --dump-top-windows 20
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import os
import sys
import tempfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable

from realtime_backend.volatility_estimators import (
    RealizedRangeWindow,
    overlapping_realized_ranges,
    percentile,
)

SCHEMA_VERSION = "tail_cap_calibration.v1"
GENERATOR_VERSION = "compute_tail_cap.v1"

# MNQ tick size — used as metadata in the calibration JSON so downstream
# consumers can do sanity checks without hard-coding.
MNQ_TICK_SIZE = 0.25

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class RangeStatsPoints:
    """Percentile snapshot of the pooled range distribution. Nested under
    ``range_stats_points`` in the artifact so v2 can add other quantile
    sets (e.g. session-bucketed) without renaming v1 fields."""
    p50: float | None
    p75: float | None
    p90: float | None
    p95: float
    p98: float
    p99: float
    max: float


@dataclass(slots=True)
class SessionSkipReason:
    """Recorded reason for skipping a candidate session — preserved in the
    artifact so a low ``lookback_sessions_used`` can be audited."""
    date: str
    reason: str


@dataclass(slots=True)
class CalibrationArtifact:
    """Wire shape of the calibration JSON. Mirrors the reviewed v1 spec.

    Field naming convention:
      * ``session_kind`` not ``session`` — avoids collision with concrete
        session-date / open-close fields downstream.
      * ``range_stats_points`` is a nested object so quantile additions
        don't require renaming top-level fields.
      * ``sessions_used`` + ``sessions_skipped`` together account for the
        full lookback window — auditable.
    """
    schema_version: str
    generator_version: str
    symbol: str
    session_kind: str
    tick_size: float
    unit: str                       # "points" — explicit so v2 can pivot to ticks if useful
    as_of_date: str                 # YYYY-MM-DD
    valid_from_session_date: str    # first date the file is valid for
    uses_sessions_strictly_before: str  # exclusion boundary, made explicit
    computed_at_ts_ns: int
    lookback_sessions_requested: int
    lookback_sessions_used: int
    sessions_used: list[str]
    sessions_skipped: list[SessionSkipReason]
    range_horizon_minutes: int
    range_step_minutes: int
    overlapping_windows: bool       # True for sliding overlapping windows
    n_windows: int
    effective_sample_note: str
    quantile_method: str            # "linear"
    price_source: str               # "raw_trade_prints" in v1
    range_stats_points: RangeStatsPoints
    bad_tick_filter: dict           # {"enabled", "method", "params"}


def _iter_trade_ticks(obs01_path: Path) -> Iterable[tuple[int, float]]:
    """Yield (ts_ns, price) for each TRADE event in the obs01 stream.

    Skips malformed lines silently — these capture files are append-only and
    a truncated last line on a crashed run shouldn't kill calibration.

    Note: the capture format stores ``ts_ns`` and other large integer fields
    as strings (to survive JS Number precision loss when downstream consumers
    parse via JSON.parse — int54 doesn't fit a JS Number). We parse to int.
    """
    with obs01_path.open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if d.get("type") != "TRADE":
                continue
            ts_ns_raw = d.get("ts_ns")
            payload = d.get("payload") or {}
            price = payload.get("price")
            try:
                ts_ns = int(ts_ns_raw) if ts_ns_raw is not None else None
            except (ValueError, TypeError):
                ts_ns = None
            if ts_ns is not None and isinstance(price, (int, float)):
                yield (ts_ns, float(price))


@dataclass(slots=True)
class ScanResult:
    """Internal result of scanning the captures: all pooled windows + a
    per-session breakdown so we can both write the artifact and dump top-N
    diagnostics from the same compute."""
    pooled: list[RealizedRangeWindow] = field(default_factory=list)
    per_session: dict[str, list[RealizedRangeWindow]] = field(default_factory=dict)
    sessions_used: list[str] = field(default_factory=list)
    sessions_skipped: list[SessionSkipReason] = field(default_factory=list)
    source_files: dict[str, Path] = field(default_factory=dict)


def _session_dates_for(captures_root: Path, as_of: dt.date, session_kind: str,
                       symbol: str, lookback: int) -> list[tuple[dt.date, Path]]:
    """Find up to ``lookback`` prior completed sessions whose obs01 file exists.

    The current session (``as_of`` and later) is excluded — we never train
    tomorrow's cap on today's data.
    """
    target_file = f"{symbol}_{session_kind}.obs01.jsonl"
    candidates: list[tuple[dt.date, Path]] = []
    for entry in sorted(captures_root.iterdir(), reverse=True):
        if not entry.is_dir():
            continue
        try:
            d = dt.date.fromisoformat(entry.name)
        except ValueError:
            continue
        if d >= as_of:
            continue
        obs = entry / target_file
        if not obs.is_file():
            continue
        candidates.append((d, obs))
        if len(candidates) >= lookback:
            break
    return candidates


def scan_captures(
    *,
    captures_root: Path,
    session_kind: str,
    symbol: str,
    lookback: int,
    as_of: dt.date,
    range_horizon_minutes: int = 60,
    range_step_minutes: int = 1,
) -> ScanResult:
    """Walk the captures, compute overlapping windows per session, pool them,
    and record skip reasons. The result is enough to both write the artifact
    and dump top-N diagnostics."""
    if not captures_root.is_dir():
        raise FileNotFoundError(f"captures_root does not exist: {captures_root}")

    result = ScanResult()
    candidates = _session_dates_for(captures_root, as_of, session_kind, symbol, lookback)
    if not candidates:
        raise FileNotFoundError(
            f"no prior {symbol}_{session_kind} obs01 files under {captures_root} "
            f"strictly before {as_of}"
        )

    for d, obs in candidates:
        date_str = d.isoformat()
        if obs.stat().st_size == 0:
            result.sessions_skipped.append(SessionSkipReason(date_str, "empty_obs01_file"))
            continue
        ticks = list(_iter_trade_ticks(obs))
        if not ticks:
            result.sessions_skipped.append(SessionSkipReason(date_str, "no_TRADE_events"))
            continue
        windows = overlapping_realized_ranges(
            ticks,
            horizon_minutes=range_horizon_minutes,
            step_minutes=range_step_minutes,
        )
        if not windows:
            result.sessions_skipped.append(
                SessionSkipReason(date_str, f"span_less_than_{range_horizon_minutes}min")
            )
            continue
        result.pooled.extend(windows)
        result.per_session[date_str] = windows
        result.sessions_used.append(date_str)
        result.source_files[date_str] = obs

    return result


def compute_calibration(
    *,
    captures_root: Path,
    session_kind: str,
    symbol: str,
    lookback: int,
    as_of: dt.date,
    range_horizon_minutes: int = 60,
    range_step_minutes: int = 1,
) -> tuple[CalibrationArtifact, ScanResult]:
    """Build a CalibrationArtifact from the last ``lookback`` prior sessions.

    Returns the artifact AND the full ScanResult so callers can dump
    top-windows diagnostics without re-scanning the captures.
    """
    scan = scan_captures(
        captures_root=captures_root,
        session_kind=session_kind,
        symbol=symbol,
        lookback=lookback,
        as_of=as_of,
        range_horizon_minutes=range_horizon_minutes,
        range_step_minutes=range_step_minutes,
    )
    if not scan.pooled:
        raise RuntimeError(
            f"no usable realized-range windows from {len(scan.sessions_skipped)} "
            f"candidate sessions (all skipped)"
        )

    ranges = [w.range_points for w in scan.pooled]
    stats = RangeStatsPoints(
        p50=percentile(ranges, 50.0),
        p75=percentile(ranges, 75.0),
        p90=percentile(ranges, 90.0),
        p95=percentile(ranges, 95.0),
        p98=percentile(ranges, 98.0),
        p99=percentile(ranges, 99.0),
        max=max(ranges),
    )

    artifact = CalibrationArtifact(
        schema_version=SCHEMA_VERSION,
        generator_version=GENERATOR_VERSION,
        symbol=symbol,
        session_kind=session_kind,
        tick_size=MNQ_TICK_SIZE,
        unit="points",
        as_of_date=as_of.isoformat(),
        valid_from_session_date=as_of.isoformat(),
        uses_sessions_strictly_before=as_of.isoformat(),
        computed_at_ts_ns=time.time_ns(),
        lookback_sessions_requested=lookback,
        lookback_sessions_used=len(scan.sessions_used),
        sessions_used=list(scan.sessions_used),
        sessions_skipped=list(scan.sessions_skipped),
        range_horizon_minutes=range_horizon_minutes,
        range_step_minutes=range_step_minutes,
        overlapping_windows=True,
        n_windows=len(ranges),
        effective_sample_note=(
            "overlapping windows; effective independent sample is lower than n_windows"
        ),
        quantile_method="linear",
        price_source="raw_trade_prints",
        range_stats_points=stats,
        bad_tick_filter={
            "enabled": False,
            "method": "trade_price_vs_l1_sanity",
            "params": {"note": "v1 disabled; planned for v2 with L1 sync"},
        },
    )
    return artifact, scan


def write_calibration_atomic(
    artifact: CalibrationArtifact,
    *,
    out_dir: Path,
) -> Path:
    """Write the artifact to a temp file in ``out_dir`` then rename atomically.

    Sequence is: write → flush → fsync → replace. The fsync forces the body
    to durable storage BEFORE the rename, so a power loss or crash between
    rename and durable commit cannot leave a half-written file at the
    canonical path. A partial write (e.g. disk full) leaves the prior valid
    file untouched — the last-valid-on-failure rule depends on this.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"tail_cap.{artifact.symbol}_{artifact.session_kind}.v1.json"
    body = json.dumps(asdict(artifact), indent=2, sort_keys=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=out_path.name + ".",
        suffix=".tmp",
        dir=str(out_dir),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(body)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, out_path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return out_path


def render_top_windows(scan: ScanResult, *, top_n: int) -> list[dict]:
    """Return the top-N widest realized-range windows across the pool,
    descending. Each row carries enough info to answer 'is this large
    range from a real move or a bad tick' without re-reading captures."""
    flat: list[tuple[str, RealizedRangeWindow]] = []
    for date_str, windows in scan.per_session.items():
        for w in windows:
            flat.append((date_str, w))
    flat.sort(key=lambda pair: pair[1].range_points, reverse=True)
    rows: list[dict] = []
    for date_str, w in flat[: max(0, top_n)]:
        rows.append({
            "session_date": date_str,
            "window_start_ts_ns": str(w.start_ts_ns),
            "window_end_ts_ns": str(w.end_ts_ns),
            "low_price": w.low_price,
            "high_price": w.high_price,
            "range_points": w.range_points,
            "n_trades": w.n_trades,
            "source_file": str(scan.source_files.get(date_str, "")),
        })
    return rows


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Compute tail-cap calibration from prior session captures.",
    )
    p.add_argument(
        "--captures-root",
        type=Path,
        default=Path("D:/Quant-futures-app/tools/rithmic_analytics/data/captures"),
        help="Root directory containing YYYY-MM-DD session subdirs.",
    )
    p.add_argument("--symbol", default="MNQ")
    p.add_argument(
        "--session-kind",
        choices=["rth", "globex"],
        required=True,
        help="Per-session-kind calibration. RTH and globex have materially "
             "different volatility profiles; one global p99 would be wrong "
             "for both.",
    )
    p.add_argument("--lookback", type=int, default=20)
    p.add_argument(
        "--as-of",
        type=dt.date.fromisoformat,
        default=dt.date.today(),
        help="YYYY-MM-DD. Calibration is for this date; only strictly-prior "
             "sessions are used (no leakage).",
    )
    p.add_argument("--horizon-minutes", type=int, default=60)
    p.add_argument("--step-minutes", type=int, default=1)
    p.add_argument(
        "--out-dir",
        type=Path,
        default=Path("D:/Quant-futures-app/data/calibration"),
    )
    p.add_argument(
        "--print-only",
        action="store_true",
        help="Compute and print the artifact JSON to stdout; do not write.",
    )
    p.add_argument(
        "--dump-top-windows",
        type=int,
        default=0,
        metavar="N",
        help="Print the N widest realized-range windows (with source file, "
             "low/high, n_trades) to stdout for bad-tick audit. Combine with "
             "--print-only to inspect without writing. Default 0 = no dump.",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)s  %(message)s",
    )
    args = _parse_args(argv)
    try:
        artifact, scan = compute_calibration(
            captures_root=args.captures_root,
            session_kind=args.session_kind,
            symbol=args.symbol,
            lookback=args.lookback,
            as_of=args.as_of,
            range_horizon_minutes=args.horizon_minutes,
            range_step_minutes=args.step_minutes,
        )
    except Exception as e:
        logger.error("calibration failed: %s", e)
        return 2

    if args.dump_top_windows > 0:
        rows = render_top_windows(scan, top_n=args.dump_top_windows)
        print("=== top-windows audit ===")
        print(json.dumps(rows, indent=2))
        print("=== /top-windows ===")

    if args.print_only:
        print(json.dumps(asdict(artifact), indent=2, sort_keys=True))
        return 0

    out_path = write_calibration_atomic(artifact, out_dir=args.out_dir)
    stats = artifact.range_stats_points
    logger.info(
        "wrote %s: %d windows from %d/%d sessions; "
        "p95=%.2f p98=%.2f p99=%.2f max=%.2f",
        out_path,
        artifact.n_windows,
        artifact.lookback_sessions_used,
        artifact.lookback_sessions_requested,
        stats.p95, stats.p98, stats.p99, stats.max,
    )
    if artifact.lookback_sessions_used < 15:
        logger.warning(
            "LOW SAMPLE: only %d sessions used (target 15+); cap values "
            "should be treated as shadow-mode only until corpus grows",
            artifact.lookback_sessions_used,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
