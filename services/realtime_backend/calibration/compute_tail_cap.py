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
    refresh writes to a temp file then renames atomically.

The runtime consumer is :mod:`realtime_backend.sigma_zones_v3` (not yet
extended at this commit — that's step 4 of the build). This script ships
*first* so we have calibration data to A/B against the legacy ATR cap.

Usage:
    python -m realtime_backend.calibration.compute_tail_cap \\
        --captures-root D:/Quant-futures-app/tools/rithmic_analytics/data/captures \\
        --session rth \\
        --lookback 20 \\
        --as-of 2026-06-02 \\
        --out-dir D:/Quant-futures-app/data/calibration
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
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

from realtime_backend.volatility_estimators import (
    overlapping_realized_ranges,
    percentile,
)

SCHEMA_VERSION = "tail_cap_calibration.v1"

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class CalibrationArtifact:
    """Wire shape of the calibration JSON. Mirrors the user's spec verbatim
    so future tools can consume it without guessing field names."""
    schema_version: str
    symbol: str
    session: str
    computed_at_ts_ns: int
    valid_for_date: str          # YYYY-MM-DD — first date the file is valid for
    lookback_sessions: int
    sessions_used: list[str]     # YYYY-MM-DD strings, prior completed sessions only
    range_horizon_minutes: int
    range_step_minutes: int
    n_windows: int
    effective_sample_note: str   # "overlapping_windows" — non-IID, callers should note
    p95_range_points: float
    p98_range_points: float
    p99_range_points: float
    max_range_points: float
    bad_tick_filter: dict        # {"enabled": bool, "method": str, "params": dict}


def _iter_trade_ticks(obs01_path: Path) -> Iterable[tuple[int, float]]:
    """Yield (ts_ns, price) for each TRADE event in the obs01 stream.

    Skips malformed lines silently — these capture files are append-only and
    a truncated last line on a crashed run shouldn't kill calibration.

    Note: the capture format stores ``ts_ns`` and other large integer fields
    as strings (to survive JS precision loss when downstream consumers parse
    via JSON.parse — int54 doesn't fit a JS Number). We parse to int here.
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
            # ts_ns may be a stringified int (capture format) or a real int.
            try:
                ts_ns = int(ts_ns_raw) if ts_ns_raw is not None else None
            except (ValueError, TypeError):
                ts_ns = None
            if ts_ns is not None and isinstance(price, (int, float)):
                yield (ts_ns, float(price))


def _session_dates_for(captures_root: Path, as_of: dt.date, session: str,
                       symbol: str, lookback: int) -> list[dt.date]:
    """Find up to ``lookback`` prior completed sessions whose obs01 file exists.

    Walks the captures root scanning date-named directories. The current
    session (``as_of`` and later) is excluded — we never train tomorrow's
    cap on today's data.
    """
    target_file = f"{symbol}_{session}.obs01.jsonl"
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
        # Sanity: non-empty file. An RTH session with 0 trades is data
        # corruption (or holiday); skip rather than poison the pool.
        if obs.stat().st_size == 0:
            continue
        candidates.append((d, obs))
        if len(candidates) >= lookback:
            break
    return [d for d, _ in candidates]


def compute_calibration(
    *,
    captures_root: Path,
    session: str,
    symbol: str,
    lookback: int,
    as_of: dt.date,
    range_horizon_minutes: int = 60,
    range_step_minutes: int = 1,
) -> CalibrationArtifact:
    """Build a CalibrationArtifact from the last ``lookback`` prior sessions.

    Pools overlapping realized-range windows across all sessions in the
    lookback; the pooled distribution is the basis for percentile statistics.
    Overlapping windows are NOT statistically independent — we note this
    explicitly in ``effective_sample_note`` so downstream analysis doesn't
    misinterpret the sample count.

    Raises FileNotFoundError if no prior sessions were found.
    """
    if not captures_root.is_dir():
        raise FileNotFoundError(f"captures_root does not exist: {captures_root}")

    target_file = f"{symbol}_{session}.obs01.jsonl"
    dates = _session_dates_for(captures_root, as_of, session, symbol, lookback)
    if not dates:
        raise FileNotFoundError(
            f"no prior {symbol}_{session} obs01 files under {captures_root} "
            f"strictly before {as_of}"
        )

    all_ranges: list[float] = []
    sessions_used: list[str] = []
    for d in dates:
        obs = captures_root / d.isoformat() / target_file
        ticks = list(_iter_trade_ticks(obs))
        if not ticks:
            logger.warning("session %s has 0 TRADE ticks; skipping", d)
            continue
        windows = overlapping_realized_ranges(
            ticks,
            horizon_minutes=range_horizon_minutes,
            step_minutes=range_step_minutes,
        )
        if not windows:
            logger.warning(
                "session %s yielded 0 %d-min windows (span < horizon?); skipping",
                d, range_horizon_minutes,
            )
            continue
        all_ranges.extend(w.range_points for w in windows)
        sessions_used.append(d.isoformat())

    if not all_ranges:
        raise RuntimeError(
            f"no usable realized-range windows from {len(dates)} candidate sessions"
        )

    return CalibrationArtifact(
        schema_version=SCHEMA_VERSION,
        symbol=symbol,
        session=session,
        computed_at_ts_ns=time.time_ns(),
        valid_for_date=as_of.isoformat(),
        lookback_sessions=lookback,
        sessions_used=sessions_used,
        range_horizon_minutes=range_horizon_minutes,
        range_step_minutes=range_step_minutes,
        n_windows=len(all_ranges),
        effective_sample_note="overlapping_windows",
        p95_range_points=percentile(all_ranges, 95.0),
        p98_range_points=percentile(all_ranges, 98.0),
        p99_range_points=percentile(all_ranges, 99.0),
        max_range_points=max(all_ranges),
        bad_tick_filter={
            "enabled": False,
            "method": "trade_price_vs_l1_sanity",
            "params": {"note": "v1: filter disabled; planned for v2 with L1 sync"},
        },
    )


def write_calibration_atomic(
    artifact: CalibrationArtifact,
    *,
    out_dir: Path,
) -> Path:
    """Write the artifact to a temp file in ``out_dir`` then rename atomically.

    A partial write (e.g. disk full) leaves the prior valid file untouched —
    the last-valid-on-failure rule depends on this.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"tail_cap.{artifact.symbol}_{artifact.session}.v1.json"
    body = json.dumps(asdict(artifact), indent=2, sort_keys=True)
    # NamedTemporaryFile(delete=False) so we can rename it after close.
    fd, tmp_name = tempfile.mkstemp(
        prefix=out_path.name + ".",
        suffix=".tmp",
        dir=str(out_dir),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(body)
        os.replace(tmp_name, out_path)
    except Exception:
        # Clean up the tmp file on failure — don't leave debris.
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return out_path


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
        "--session",
        choices=["rth", "globex"],
        required=True,
        help="Session kind. Calibration is per-kind because RTH and globex "
             "have materially different volatility profiles.",
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
        help="Compute and print to stdout but do not write the file.",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)s  %(message)s",
    )
    args = _parse_args(argv)
    try:
        artifact = compute_calibration(
            captures_root=args.captures_root,
            session=args.session,
            symbol=args.symbol,
            lookback=args.lookback,
            as_of=args.as_of,
            range_horizon_minutes=args.horizon_minutes,
            range_step_minutes=args.step_minutes,
        )
    except Exception as e:
        logger.error("calibration failed: %s", e)
        return 2

    if args.print_only:
        print(json.dumps(asdict(artifact), indent=2, sort_keys=True))
        return 0

    out_path = write_calibration_atomic(artifact, out_dir=args.out_dir)
    logger.info(
        "wrote %s: %d windows from %d sessions; p95=%.2f p98=%.2f p99=%.2f max=%.2f",
        out_path,
        artifact.n_windows,
        len(artifact.sessions_used),
        artifact.p95_range_points,
        artifact.p98_range_points,
        artifact.p99_range_points,
        artifact.max_range_points,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
