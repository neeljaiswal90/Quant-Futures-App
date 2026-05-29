"""``python -m rithmic_analytics.cli.analyze_cancellations`` — RA-036 CLI.

Loads Tradesea cancellation records + the live OBS-01 tape, runs the
analysis, writes JSON. Mirrors the standalone-orchestrator pattern of
``cli.compute_pressure`` (RA-035) and ``cli.replay_session`` (RA-026).

Exit codes:
    0 — success
    1 — bad input (orders / jsonl file missing / unparseable)
    2 — usage error (output exists without --force, bad arg combo)

Example::

    python -m rithmic_analytics.cli.analyze_cancellations \\
        --orders data/trades/2026-05-19/orders.csv \\
        --jsonl data/captures/2026-05-19/MNQ_rth.obs01.jsonl \\
        --output data/cancellations/2026-05-19_MNQ_rth.json
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import date
from pathlib import Path

import jsonschema

from rithmic_analytics.core.contracts import MNQ
from rithmic_analytics.core.loader import load_obs01_trades
from rithmic_analytics.core.trade_log import load_tradesea_csv
from rithmic_analytics.features.cancellation_analysis import (
    CancellationAnalysisConfig,
    analyze_cancellations,
)

EXIT_OK: int = 0
EXIT_BAD_INPUT: int = 1
EXIT_USAGE: int = 2

_LOG = logging.getLogger("rithmic_analytics.analyze_cancellations")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m rithmic_analytics.cli.analyze_cancellations",
        description=(
            "Analyze Tradesea cancelled-order records against the live "
            "tape. Output answers Rule 7: did price reach your cancelled "
            "limit within N minutes? Did you rebuy at worse?"
        ),
    )
    parser.add_argument(
        "--orders", type=Path, required=True,
        help="Path to Tradesea orders CSV (contains both filled + cancelled rows).",
    )
    parser.add_argument(
        "--jsonl", type=Path, required=True,
        help="Path to the OBS-01 capture JSONL (or .obs01.jsonl sibling).",
    )
    parser.add_argument(
        "--output", type=Path, required=True,
        help="Destination cancellation-analysis JSON.",
    )
    parser.add_argument(
        "--regret-window-minutes", type=int, default=5,
        help="How long after cancel to look forward for reach-limit. Default 5.",
    )
    parser.add_argument(
        "--rebuy-window-minutes", type=int, default=10,
        help="How long to look forward for a regret rebuy fill. Default 10.",
    )
    parser.add_argument(
        "--regret-tolerance-ticks", type=int, default=1,
        help="Within N ticks of limit counts as reached. Default 1.",
    )
    parser.add_argument(
        "--min-window-seconds", type=int, default=60,
        help=(
            "Minimum post-cancel tape duration for the outcome to count "
            "in regret_cancel_rate denominator. Default 60s."
        ),
    )
    parser.add_argument(
        "--trading-date", type=date.fromisoformat, default=None,
        help="ISO date stamp for the report metadata. Default: not stamped.",
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Overwrite --output if it already exists.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = _build_parser().parse_args(argv)

    if not args.orders.exists():
        _LOG.error(f"orders CSV not found: {args.orders}")
        return EXIT_BAD_INPUT
    if not args.jsonl.exists():
        _LOG.error(f"capture JSONL not found: {args.jsonl}")
        return EXIT_BAD_INPUT
    if args.output.exists() and not args.force:
        _LOG.error(
            f"--output exists: {args.output}. Pass --force to overwrite."
        )
        return EXIT_USAGE
    for arg_name, value in [
        ("--regret-window-minutes", args.regret_window_minutes),
        ("--rebuy-window-minutes", args.rebuy_window_minutes),
        ("--regret-tolerance-ticks", args.regret_tolerance_ticks),
        ("--min-window-seconds", args.min_window_seconds),
    ]:
        if value < 0:
            _LOG.error(f"{arg_name} must be >= 0 (got {value})")
            return EXIT_USAGE

    try:
        fills, cancellations = load_tradesea_csv(args.orders)
    except (FileNotFoundError, ValueError, jsonschema.ValidationError) as exc:
        _LOG.error(f"failed to load orders CSV {args.orders}: {exc}")
        return EXIT_BAD_INPUT

    try:
        trades = load_obs01_trades(args.jsonl)
    except (json.JSONDecodeError, KeyError, ValueError) as exc:
        _LOG.error(f"failed to load JSONL {args.jsonl}: {exc}")
        return EXIT_BAD_INPUT

    _LOG.info(
        f"loaded {len(fills)} fills + {len(cancellations)} cancellations "
        f"from {args.orders.name}; {len(trades):,} trades from {args.jsonl.name}"
    )

    config = CancellationAnalysisConfig(
        regret_window_minutes=args.regret_window_minutes,
        rebuy_window_minutes=args.rebuy_window_minutes,
        regret_tolerance_ticks=args.regret_tolerance_ticks,
        min_window_seconds=args.min_window_seconds,
    )

    report = analyze_cancellations(
        cancellations, trades, MNQ,
        fills=fills, config=config,
        trading_date=args.trading_date,
    )

    s = report.session_summary
    rate_str = (
        f"{s.regret_cancel_rate * 100:.1f}%"
        if s.regret_cancel_rate is not None else "n/a"
    )
    _LOG.info(
        f"analyzed {s.n_cancels_analyzed}/{s.n_cancels_total} cancellations: "
        f"{s.n_reached_limit} reached limit, {s.n_favorable} favorable, "
        f"{s.n_unfavorable} unfavorable, {s.n_neutral} neutral, "
        f"{s.n_regret_rebuys} regret-rebuys; regret_cancel_rate={rate_str}"
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report.to_dict(), indent=2, default=str),
        encoding="utf-8",
    )
    _LOG.info(f"wrote cancellation analysis → {args.output}")

    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
