"""``python -m rithmic_analytics.cli.heartbeat`` — daily heartbeat task entry.

Production schedule: ``RithmicHeartbeat`` runs every day at 10:00 ET via
Windows Task Scheduler (RA-011). Each run:

1. Writes today's heartbeat file at ``data/heartbeat/{trading_date}.txt``.
2. Scans the last N weekdays for missing heartbeats and emits one
   ``CAPTURE_HEARTBEAT_MISSING`` NDJSON alert per missing day past its deadline.

Exit codes:
    0 — success (heartbeat written; missing-detection results in the log)
    1 — bad config (paths uncreatable, etc.)
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import date, datetime, time
from pathlib import Path
from zoneinfo import ZoneInfo

from rithmic_analytics.ops.heartbeat_check import (
    check_missing_heartbeats,
    write_heartbeat,
)

EXIT_OK: int = 0
EXIT_BAD_CONFIG: int = 1

_ET: ZoneInfo = ZoneInfo("America/New_York")
_LOG = logging.getLogger("rithmic_analytics.heartbeat")


def _now_et() -> datetime:
    return datetime.now(_ET)


def _today_et() -> date:
    return _now_et().date()


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m rithmic_analytics.cli.heartbeat",
        description="Write today's heartbeat file and check past missing heartbeats.",
    )
    parser.add_argument(
        "--captures-root",
        type=Path,
        default=Path("data/captures"),
        help="Capture root scanned for today's files. Default: data/captures.",
    )
    parser.add_argument(
        "--heartbeat-dir",
        type=Path,
        default=Path("data/heartbeat"),
        help="Where heartbeat files are written / read. Default: data/heartbeat.",
    )
    parser.add_argument(
        "--alerts-path",
        type=Path,
        default=Path("data/alerts/alerts.ndjson"),
        help="NDJSON alerts file. Default: data/alerts/alerts.ndjson.",
    )
    parser.add_argument(
        "--root-symbol",
        default="MNQ",
        help="Root symbol embedded in the heartbeat record. Default: MNQ.",
    )
    parser.add_argument(
        "--deadline-hour-et",
        type=int,
        default=10,
        help="Past-deadline check threshold (hour, ET). Default: 10.",
    )
    parser.add_argument(
        "--deadline-minute-et",
        type=int,
        default=30,
        help="Past-deadline check threshold (minute). Default: 30.",
    )
    parser.add_argument(
        "--lookback-weekdays",
        type=int,
        default=5,
        help="How many calendar days back to scan. Default: 5.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = _build_parser().parse_args(argv)

    now = _now_et()
    today = now.date()

    try:
        written = write_heartbeat(
            args.captures_root, args.heartbeat_dir, today, args.root_symbol
        )
    except OSError as exc:
        _LOG.error(f"could not write heartbeat: {exc}")
        return EXIT_BAD_CONFIG
    _LOG.info(f"wrote heartbeat: {written}")

    deadline = time(args.deadline_hour_et, args.deadline_minute_et)
    missing = check_missing_heartbeats(
        args.heartbeat_dir,
        args.alerts_path,
        now_et=now,
        deadline=deadline,
        lookback_weekdays=args.lookback_weekdays,
    )
    if missing:
        _LOG.warning(
            f"flagged {len(missing)} missing heartbeat(s): "
            f"{[d.isoformat() for d in missing]}"
        )
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
