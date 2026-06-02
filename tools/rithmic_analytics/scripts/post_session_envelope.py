"""RA-112e — post-session envelope recompute from a continuous capture file.

Companion to the 2026-06-03 continuous-capture automation. Once the
automation's single ``MNQ_globex.jsonl`` capture is complete, this script
extracts the RTH ts_ns window from inside that file and writes a fresh
``data/zones/<DATE>_MNQ_rth.json`` matching the schema the realtime backend
expects to see in `reference_lines`.

Solves Gotcha #2 from the continuous-capture compatibility audit
(`feedback_stale_analytics_envelope.md`):
  * the analytics pipeline normally computes one envelope per file, early;
  * with continuous capture there is NO per-session file, so the pipeline
    never produces a fresh RTH envelope at all;
  * this script does that fresh RTH envelope from a ts_ns slice.

Reuses the existing ``compute_vp`` + ``ZoneEnvelope.from_volume_profile``
pipeline so the output is byte-for-byte indistinguishable from a
``daily_zones`` run except for the ``computed_at`` timestamp.

Usage:
    python -m scripts.post_session_envelope \\
        --captures-root D:/Quant-futures-app/tools/rithmic_analytics/data/captures \\
        --zones-root    D:/Quant-futures-app/tools/rithmic_analytics/data/zones \\
        --trading-date  2026-06-03 \\
        --target-session rth \\
        --source-session globex
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import sys
import tempfile
from datetime import date as dt_date
from datetime import datetime, time as dtime
from pathlib import Path
from zoneinfo import ZoneInfo

import jsonschema
import pandas as pd

from rithmic_analytics.cli.daily_zones import _build_vwap_reference_lines
from rithmic_analytics.core.contracts import MNQ
from rithmic_analytics.core.loader import load_obs01_trades
from rithmic_analytics.core.schema import ZoneEnvelope, validate_envelope
from rithmic_analytics.features.atr import compute_atr_from_ticks
from rithmic_analytics.features.volume_profile import compute_vp

# RTH session window, Pacific time.
_PT = ZoneInfo("America/Los_Angeles")
_RTH_OPEN_PT = dtime(6, 30)
_RTH_CLOSE_PT = dtime(13, 5)   # match capture end time
_GLOBEX_OPEN_PT = dtime(15, 0)
# Globex closes at next-day RTH open; for filtering we cap at 13:05 PT next day.

_LOG = logging.getLogger("post_session_envelope")


def _session_window_ts_ns(
    trading_date: dt_date, target_session: str
) -> tuple[int, int]:
    """Compute the ts_ns boundaries for the target session on the given date.

    RTH: 06:30 - 13:05 PT same date.
    Globex: 15:00 PT prior date through 13:05 PT next-trading-date (broad).
    """
    if target_session == "rth":
        start_pt = datetime.combine(trading_date, _RTH_OPEN_PT, tzinfo=_PT)
        end_pt = datetime.combine(trading_date, _RTH_CLOSE_PT, tzinfo=_PT)
    elif target_session == "globex":
        # Conservative: the globex window relevant to a calendar date is the
        # tape from prior-day 15:00 PT through current-day 06:30 PT.
        from datetime import timedelta
        prev = trading_date - timedelta(days=1)
        start_pt = datetime.combine(prev, _GLOBEX_OPEN_PT, tzinfo=_PT)
        end_pt = datetime.combine(trading_date, _RTH_OPEN_PT, tzinfo=_PT)
    else:
        raise ValueError(f"unknown target_session: {target_session}")
    start_ns = int(start_pt.timestamp() * 1_000_000_000)
    end_ns = int(end_pt.timestamp() * 1_000_000_000)
    return start_ns, end_ns


def _atomic_write(path: Path, body: str) -> None:
    """Same atomic write pattern as the calibration script: temp file +
    fsync + os.replace so a failed write doesn't clobber the prior file."""
    import os
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(body)
            if not body.endswith("\n"):
                f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try: os.unlink(tmp)
        except OSError: pass
        raise


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)s  %(message)s",
    )
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--captures-root", type=Path, required=True)
    ap.add_argument("--zones-root", type=Path, required=True)
    ap.add_argument(
        "--trading-date", type=dt_date.fromisoformat, required=True,
        help="The session date the recomputed envelope is FOR (YYYY-MM-DD).",
    )
    ap.add_argument(
        "--target-session", choices=["rth", "globex"], required=True,
        help="Session whose envelope we are recomputing.",
    )
    ap.add_argument(
        "--source-session", choices=["rth", "globex"], default=None,
        help="Which capture file to read from. Defaults to the target if a "
             "per-session file exists; otherwise falls back to globex (the "
             "continuous-capture file).",
    )
    ap.add_argument("--symbol", default="MNQ")
    ap.add_argument("--bin-size-ticks", type=int, default=20)
    ap.add_argument("--va-pct", type=float, default=0.70)
    ap.add_argument("--atr-period", type=int, default=14)
    ap.add_argument("--atr-bar-size-min", type=int, default=5)
    ap.add_argument(
        "--print-only", action="store_true",
        help="Print the envelope JSON to stdout; do not write the zones file.",
    )
    args = ap.parse_args(argv)

    # Resolve source file. Prefer the explicit --source-session; otherwise
    # try target then fall back to globex.
    candidates: list[str] = []
    if args.source_session is not None:
        candidates.append(args.source_session)
    else:
        candidates.extend([args.target_session, "globex"])
    src_path: Path | None = None
    for kind in candidates:
        p = args.captures_root / args.trading_date.isoformat() / f"{args.symbol}_{kind}.obs01.jsonl"
        if p.is_file():
            src_path = p
            _LOG.info("source file: %s", p)
            break
    if src_path is None:
        _LOG.error("no source obs01 file found for %s under %s", args.trading_date, args.captures_root)
        return 2

    # Load + filter to the target-session ts_ns window.
    start_ns, end_ns = _session_window_ts_ns(args.trading_date, args.target_session)
    _LOG.info("session ts_ns window [%d, %d) = %s → %s PT",
              start_ns, end_ns,
              datetime.fromtimestamp(start_ns / 1e9, tz=_PT).strftime("%Y-%m-%d %H:%M"),
              datetime.fromtimestamp(end_ns / 1e9, tz=_PT).strftime("%Y-%m-%d %H:%M"))
    trades = load_obs01_trades(src_path)
    if trades.empty:
        _LOG.error("no trades loaded from %s", src_path)
        return 2
    mask = (trades["event_ts_ns"] >= start_ns) & (trades["event_ts_ns"] < end_ns)
    filtered = trades.loc[mask].reset_index(drop=True)
    if filtered.empty:
        _LOG.error(
            "0 trades in the %s ts_ns window — file may pre-date the session or "
            "session may not have started yet", args.target_session,
        )
        return 2
    _LOG.info("loaded %d trades from source, %d after %s ts_ns filter",
              len(trades), len(filtered), args.target_session)

    # ATR(14, 5m) — same defaults as daily_zones
    _NS_PER_MINUTE = 60 * 10**9
    atr_14 = compute_atr_from_ticks(
        filtered,
        period=args.atr_period,
        bar_size_ns=args.atr_bar_size_min * _NS_PER_MINUTE,
    )

    # Volume profile + envelope (reusing the existing schema layer for
    # byte-compat with daily_zones output).
    vp = compute_vp(
        filtered, MNQ,
        bin_size_ticks=args.bin_size_ticks,
        va_pct=args.va_pct,
    )
    envelope = ZoneEnvelope.from_volume_profile(
        vp,
        symbol=args.symbol,
        timeframe=args.target_session,
        atr_14=atr_14,
        data_source="rithmic",
        bin_size_ticks=vp.effective_bin_size_ticks or args.bin_size_ticks,
        bars_used=len(filtered),
    )
    vwap_lines = _build_vwap_reference_lines(filtered, args.target_session)
    if vwap_lines:
        envelope = dataclasses.replace(
            envelope,
            reference_lines=envelope.reference_lines + vwap_lines,
        )

    payload = envelope.to_dict()
    try:
        validate_envelope(payload)
    except jsonschema.ValidationError as exc:
        _LOG.error("envelope failed schema validation: %s", exc.message)
        return 2

    body = envelope.to_json()
    out_path = args.zones_root / f"{args.trading_date.isoformat()}_{args.symbol}_{args.target_session}.json"
    if args.print_only:
        print(body)
        _LOG.info("(--print-only) would have written %s — %s", out_path, envelope.summary_line())
        return 0

    _atomic_write(out_path, body)
    _LOG.info("wrote %s — %s", out_path, envelope.summary_line())
    return 0


if __name__ == "__main__":
    sys.exit(main())
