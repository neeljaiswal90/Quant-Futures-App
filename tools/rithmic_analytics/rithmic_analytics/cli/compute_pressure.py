"""``python -m rithmic_analytics.cli.compute_pressure`` — RA-035 CLI.

Loads an MBO sibling, computes order-flow pressure diagnostics, writes
JSON. Standalone counterpart to daily_zones' ``--emit-pressure-json``
flag for ad-hoc reprocessing.

Exit codes:
    0 — success
    1 — bad input (MBO file missing / unparseable)
    2 — usage error (output exists without --force, etc.)

Example::

    python -m rithmic_analytics.cli.compute_pressure \\
        --mbo data/captures/2026-05-21/MNQ_globex.mbo.jsonl \\
        --output data/order_pressure/2026-05-21_MNQ_globex.json \\
        --spoof-cancel-window-ms 500
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from rithmic_analytics.core.contracts import MNQ
from rithmic_analytics.core.loader import load_mbo
from rithmic_analytics.features.order_pressure import (
    OrderPressureConfig,
    aggregate_to_session_summary,
    compute_order_pressure,
)

EXIT_OK: int = 0
EXIT_BAD_INPUT: int = 1
EXIT_USAGE: int = 2

_LOG = logging.getLogger("rithmic_analytics.compute_pressure")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m rithmic_analytics.cli.compute_pressure",
        description=(
            "Compute MBO add/cancel pressure diagnostics from a normalized "
            "MBO JSONL. Emits row-oriented JSON with per-bin counts + "
            "add_cancel_ratio + depletion_velocity + spoof_score."
        ),
    )
    parser.add_argument(
        "--mbo", type=Path, required=True,
        help="Path to the MBO JSONL sibling (e.g. .../MNQ_globex.mbo.jsonl).",
    )
    parser.add_argument(
        "--output", type=Path, required=True,
        help="Destination pressure JSON.",
    )
    parser.add_argument(
        "--window-seconds", type=int, default=30,
        help="Time-bucket width in seconds. Default 30.",
    )
    parser.add_argument(
        "--price-bin-ticks", type=int, default=4,
        help="Price bin width in contract ticks. Default 4 (1pt MNQ).",
    )
    parser.add_argument(
        "--spoof-cancel-window-ms", type=int, default=500,
        help=(
            "Max (cancel_ts - add_ts) ms for an add-then-cancel pair to "
            "count as spoofing. Default 500ms. Tunable knob — surface in "
            "output metadata."
        ),
    )
    parser.add_argument(
        "--top-n-levels", type=int, default=None,
        help=(
            "If set, also write the top-N session-summary levels by "
            "max_spoof_score to a sibling _summary.json file."
        ),
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

    if not args.mbo.exists():
        _LOG.error(f"MBO file not found: {args.mbo}")
        return EXIT_BAD_INPUT
    if args.output.exists() and not args.force:
        _LOG.error(
            f"--output exists: {args.output}. Pass --force to overwrite."
        )
        return EXIT_USAGE
    if args.window_seconds <= 0:
        _LOG.error("--window-seconds must be > 0")
        return EXIT_USAGE
    if args.price_bin_ticks <= 0:
        _LOG.error("--price-bin-ticks must be > 0")
        return EXIT_USAGE
    if args.spoof_cancel_window_ms <= 0:
        _LOG.error("--spoof-cancel-window-ms must be > 0")
        return EXIT_USAGE

    try:
        mbo = load_mbo(args.mbo)
    except (json.JSONDecodeError, KeyError, ValueError) as exc:
        _LOG.error(f"failed to load MBO {args.mbo}: {exc}")
        return EXIT_BAD_INPUT

    _LOG.info(f"loaded {len(mbo):,} MBO events from {args.mbo.name}")

    config = OrderPressureConfig(
        window_seconds=args.window_seconds,
        price_bin_ticks=args.price_bin_ticks,
        spoof_cancel_window_ms=args.spoof_cancel_window_ms,
    )

    import time
    start = time.perf_counter()
    series = compute_order_pressure(mbo, MNQ, config=config)
    elapsed = time.perf_counter() - start

    _LOG.info(
        f"computed pressure: {len(series.rows):,} (time × price) bins from "
        f"{series.n_input_events:,} events ({series.n_unique_order_ids:,} unique order_ids) "
        f"in {elapsed:.1f}s"
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(series.to_dict(), indent=2), encoding="utf-8"
    )
    _LOG.info(f"wrote pressure JSON → {args.output}")

    if args.top_n_levels is not None:
        summary = aggregate_to_session_summary(series)
        # Sort by max_spoof_score desc, keep None at bottom
        ranked = sorted(
            summary.items(),
            key=lambda kv: (
                kv[1]["max_spoof_score"] if kv[1]["max_spoof_score"] is not None else -1.0
            ),
            reverse=True,
        )[: args.top_n_levels]
        summary_path = args.output.with_name(args.output.stem + "_summary.json")
        summary_path.write_text(
            json.dumps(dict(ranked), indent=2), encoding="utf-8"
        )
        _LOG.info(f"wrote top-{args.top_n_levels} summary → {summary_path}")

    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
