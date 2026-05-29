"""``python -m rithmic_analytics.cli.replay_session`` — trade-replay orchestrator.

Pipeline:

1. Load trade log (Tradesea CSV or manual JSON, auto-detected by extension).
2. Load OBS-01 capture JSONL.
3. Optionally load zone envelope JSON for proximity computation.
4. Call :func:`replay_session` to produce snapshots.
5. Render HTML report.

Exit codes:
    0 — success
    1 — bad input (file missing, unparseable)
    2 — usage error (mutually exclusive args, etc.)

Example::

    python -m rithmic_analytics.cli.replay_session \\
        --trade-log C:\\Users\\Neel\\Downloads\\orders_2026-05-19.csv \\
        --jsonl data\\captures\\2026-05-19\\MNQ_rth.jsonl \\
        --output data\\reports\\replay_2026-05-19.html \\
        --zones data\\zones\\2026-05-18_MNQ_rth.json \\
        --window-sec 60
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import sys
from pathlib import Path

import jsonschema

from rithmic_analytics.core.contracts import MNQ
from rithmic_analytics.core.loader import load_obs01_trades
from rithmic_analytics.core.schema import Zone, validate_envelope
from rithmic_analytics.core.trade_log import (
    CancelledOrder,
    TradeFill,
    load_manual_log,
    load_tradesea_csv,
)
from rithmic_analytics.features.trade_replay import replay_session
from rithmic_analytics.viewer.trade_replay_report import render_trade_replay_html

EXIT_OK: int = 0
EXIT_BAD_INPUT: int = 1
EXIT_USAGE: int = 2

_LOG = logging.getLogger("rithmic_analytics.replay_session")


def _load_zones_envelope(path: Path) -> tuple[list[Zone], float | None]:
    """Parse a zone-envelope JSON file. Returns ``(zones, atr_14_or_None)``.

    Validated against ``zone_schema.json`` before unpacking — any malformed
    envelope raises ``jsonschema.ValidationError``.
    """
    payload = json.loads(path.read_text(encoding="utf-8"))
    validate_envelope(payload)
    zones = [
        Zone(
            id=z["id"],
            top=z["top"],
            bot=z["bot"],
            type=z["type"],
            conviction=z["conviction"],
            text=z["text"],
            sources=list(z["sources"]),
            volume_pct=z.get("volume_pct"),
            multi_tf_count=z.get("multi_tf_count"),
            multi_session_count=z.get("multi_session_count"),
        )
        for z in payload.get("zones", [])
    ]
    atr_raw = payload.get("atr_14")
    if atr_raw is None:
        atr_14: float | None = None
    else:
        atr_val = float(atr_raw)
        atr_14 = None if math.isnan(atr_val) else atr_val
    return zones, atr_14


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m rithmic_analytics.cli.replay_session",
        description=(
            "Replay fills against the captured tick tape and render an HTML "
            "report with pre/post-fill orderflow snapshots."
        ),
    )
    parser.add_argument(
        "--trade-log", type=Path, required=True,
        help="Path to Tradesea CSV (.csv) or manual JSON log (.json).",
    )
    parser.add_argument(
        "--jsonl", type=Path, required=True,
        help="Path to the OBS-01 capture (e.g. data/captures/2026-05-19/MNQ_rth.jsonl).",
    )
    parser.add_argument(
        "--output", type=Path, required=True,
        help="Destination HTML report path.",
    )
    parser.add_argument(
        "--zones", type=Path, default=None,
        help="Optional zone-envelope JSON for proximity computation.",
    )
    parser.add_argument(
        "--window-sec", type=int, default=60,
        help="Pre/post window width in seconds. Default 60.",
    )
    parser.add_argument(
        "--pnl-horizons",
        default="60,300,900",
        help="Comma-separated PnL horizons in seconds. Default: 60,300,900.",
    )
    parser.add_argument(
        "--title", default=None,
        help="Report title override.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. See module docstring for exit-code semantics."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = _build_parser().parse_args(argv)

    # ---- Validate input paths ----
    if not args.trade_log.exists():
        _LOG.error(f"trade log not found: {args.trade_log}")
        return EXIT_BAD_INPUT
    if not args.jsonl.exists():
        _LOG.error(f"capture JSONL not found: {args.jsonl}")
        return EXIT_BAD_INPUT
    if args.zones is not None and not args.zones.exists():
        _LOG.error(f"--zones path does not exist: {args.zones}")
        return EXIT_BAD_INPUT

    # ---- Parse pnl horizons ----
    try:
        horizons = tuple(
            int(s.strip()) for s in args.pnl_horizons.split(",") if s.strip()
        )
        if not horizons or any(h <= 0 for h in horizons):
            raise ValueError("pnl horizons must be positive integers")
    except ValueError as exc:
        _LOG.error(f"bad --pnl-horizons={args.pnl_horizons!r}: {exc}")
        return EXIT_USAGE

    # ---- Load trade log ----
    suffix = args.trade_log.suffix.lower()
    fills: list[TradeFill] = []
    cancelled: list[CancelledOrder] = []
    try:
        if suffix == ".csv":
            fills, cancelled = load_tradesea_csv(args.trade_log)
        elif suffix == ".json":
            fills = load_manual_log(args.trade_log)
        else:
            _LOG.error(
                f"--trade-log: unrecognised extension {suffix!r}; "
                f"use .csv (Tradesea) or .json (manual log)"
            )
            return EXIT_USAGE
    except (FileNotFoundError, json.JSONDecodeError, ValueError,
            jsonschema.ValidationError) as exc:
        _LOG.error(f"failed to load trade log {args.trade_log}: {exc}")
        return EXIT_BAD_INPUT

    _LOG.info(
        f"loaded {len(fills)} fills + {len(cancelled)} cancellations "
        f"from {args.trade_log.name}"
    )

    # ---- Load capture ----
    try:
        trades = load_obs01_trades(args.jsonl)
    except (json.JSONDecodeError, KeyError, ValueError) as exc:
        _LOG.error(f"failed to load JSONL {args.jsonl}: {exc}")
        return EXIT_BAD_INPUT

    _LOG.info(f"loaded {len(trades):,} trades from {args.jsonl.name}")

    # ---- Optional zones ----
    zones: list[Zone] | None = None
    atr_14: float | None = None
    if args.zones is not None:
        try:
            zones, atr_14 = _load_zones_envelope(args.zones)
        except (json.JSONDecodeError, KeyError, jsonschema.ValidationError) as exc:
            _LOG.error(f"failed to load zones {args.zones}: {exc}")
            return EXIT_BAD_INPUT
        _LOG.info(f"loaded {len(zones)} zones (atr_14={atr_14}) from {args.zones.name}")

    # ---- Replay ----
    session = replay_session(
        fills, trades, MNQ,
        zones=zones, atr_14=atr_14, cancelled=cancelled,
        window_seconds=args.window_sec,
        pnl_horizons_seconds=horizons,
    )

    skipped = (
        session.fills_skipped_symbol_mismatch
        + session.fills_skipped_outside_window
    )
    _LOG.info(
        f"replayed {len(session.snapshots)} fills ({skipped} skipped: "
        f"{session.fills_skipped_symbol_mismatch} symbol mismatch, "
        f"{session.fills_skipped_outside_window} outside window)"
    )

    # ---- Render ----
    out = render_trade_replay_html(session, args.output, title=args.title)
    _LOG.info(f"wrote replay report → {out}")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
