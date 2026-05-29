"""``python -m rithmic_analytics.cli.compute_vp`` — one-shot zone JSON producer.

Pipeline: load OBS-01 JSONL → compute Volume Profile + Wilder ATR → build a
canonical zone envelope → validate against ``zone_schema.json`` → emit (stdout
by default, file with ``--output``).

Exit codes:
    0 — success
    1 — bad input (file missing or unparseable JSONL)
    2 — output failed schema validation (should not happen unless we ship a bug;
        keeps us honest)

Example:
    python -m rithmic_analytics.cli.compute_vp \\
        --input D:\\Quant-futures-app\\data\\probes\\infra01\\full\\l1-trade-post04d.obs01.jsonl \\
        --output zones.json \\
        --symbol MNQ --timeframe rth --bin-size-ticks 20 --va-pct 0.70
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import jsonschema

from rithmic_analytics.core.contracts import MNQ
from rithmic_analytics.core.loader import load_obs01_trades
from rithmic_analytics.core.schema import ZoneEnvelope, validate_envelope
from rithmic_analytics.features.atr import compute_atr_from_ticks
from rithmic_analytics.features.volume_profile import compute_vp

_NS_PER_MINUTE: int = 60 * 10**9

EXIT_OK: int = 0
EXIT_BAD_INPUT: int = 1
EXIT_SCHEMA_FAIL: int = 2


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m rithmic_analytics.cli.compute_vp",
        description=(
            "Compute Volume Profile + ATR from an OBS-01 JSONL capture and emit "
            "a canonical zone JSON envelope."
        ),
    )
    parser.add_argument(
        "--input",
        type=Path,
        required=True,
        help="Path to the OBS-01 JSONL file (e.g. l1-trade-post04d.obs01.jsonl).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Where to write the zone JSON. If omitted, prints summary + JSON to stdout.",
    )
    parser.add_argument(
        "--symbol",
        default="MNQ",
        help="Root symbol (e.g. MNQ). Not the front-month contract. Default: MNQ.",
    )
    parser.add_argument(
        "--timeframe",
        default="rth",
        help="Timeframe label for the envelope (e.g. rth, globex, 5m). Default: rth.",
    )
    parser.add_argument(
        "--bin-size-ticks",
        type=int,
        default=20,
        help="VP bin width in ticks. 20 ticks = 5 points for MNQ (tick=0.25). Default: 20.",
    )
    parser.add_argument(
        "--bin-size-mode",
        choices=("fixed", "adaptive"),
        default="fixed",
        help=(
            "RA-039: 'fixed' honors --bin-size-ticks; 'adaptive' derives bin "
            "width from ATR via round(atr_14/4) clamped to [4, 40] ticks. NaN "
            "ATR transparently falls back to bin_size_ticks=20 with a WARN log. "
            "Default: fixed."
        ),
    )
    parser.add_argument(
        "--va-pct",
        type=float,
        default=0.70,
        help="Value-area target fraction. Default: 0.70.",
    )
    parser.add_argument(
        "--hvn-dedup-ticks",
        type=int,
        default=60,
        help="Minimum tick distance between HVNs. 60 ticks = 15 pts for MNQ. Default: 60.",
    )
    parser.add_argument(
        "--top-n",
        type=int,
        default=6,
        help="Number of HVNs / LVNs to emit. Default: 6.",
    )
    parser.add_argument(
        "--atr-bar-size-min",
        type=int,
        default=5,
        help="ATR bar size in minutes. Default: 5.",
    )
    parser.add_argument(
        "--atr-period",
        type=int,
        default=14,
        help="ATR smoothing period. Default: 14.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point.

    Args:
        argv: Optional argument list (for testing); defaults to ``sys.argv[1:]``.

    Returns:
        Exit code (see module docstring).
    """
    args = _build_parser().parse_args(argv)

    if not args.input.exists():
        print(f"error: input file not found: {args.input}", file=sys.stderr)
        return EXIT_BAD_INPUT

    try:
        trades = load_obs01_trades(args.input)
    except (json.JSONDecodeError, KeyError, ValueError) as exc:
        print(f"error: failed to parse {args.input}: {exc}", file=sys.stderr)
        return EXIT_BAD_INPUT

    # RA-039: compute ATR first so adaptive mode can consult it.
    atr_14 = compute_atr_from_ticks(
        trades,
        period=args.atr_period,
        bar_size_ns=args.atr_bar_size_min * _NS_PER_MINUTE,
    )

    vp = compute_vp(
        trades,
        MNQ,
        bin_size_ticks=args.bin_size_ticks,
        va_pct=args.va_pct,
        hvn_dedup_ticks=args.hvn_dedup_ticks,
        top_n=args.top_n,
        bin_size_mode=args.bin_size_mode,
        atr_14=atr_14,
    )

    envelope = ZoneEnvelope.from_volume_profile(
        vp,
        symbol=args.symbol,
        timeframe=args.timeframe,
        atr_14=atr_14,
        data_source="rithmic",
        # RA-039: when adaptive mode resolves, surface the effective ticks
        # used (so the envelope reflects what was actually binned).
        bin_size_ticks=vp.effective_bin_size_ticks or args.bin_size_ticks,
        bars_used=len(trades),
    )

    payload = envelope.to_dict()
    try:
        validate_envelope(payload)
    except jsonschema.ValidationError as exc:
        print(f"error: emitted envelope failed schema validation: {exc.message}", file=sys.stderr)
        return EXIT_SCHEMA_FAIL

    rendered = envelope.to_json()
    if args.output is None:
        print(envelope.summary_line(), file=sys.stderr)
        print(rendered)
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
        print(envelope.summary_line(), file=sys.stderr)
        print(f"wrote {args.output}", file=sys.stderr)

    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
