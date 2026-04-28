"""DATA-04 tier-aware microstructure feature engine CLI."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path

from services.market_data_sidecar.features.microstructure_feature_engine import (
    DEFAULT_DEPTH_LEVELS,
    DEFAULT_OFI_MEDIUM_WINDOW,
    DEFAULT_OFI_SHORT_WINDOW,
    DEFAULT_TICK_SIZE,
    DEFAULT_TRADE_WINDOW,
    build_microstructure_feature_journal,
)
from services.market_data_sidecar.session.session_clock import validate_session_id


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DATA-04 tier-aware microstructure feature builder")
    parser.add_argument("--input", required=True, help="DATA-02-PS/DATA-02-MBO/TRADE journal JSONL")
    parser.add_argument("--out", required=True, help="DATA-04 FEATURES journal JSONL output")
    parser.add_argument("--report", required=True, help="DATA-04 feature report JSON output")
    parser.add_argument("--run-id", required=True, help="Deterministic run_id for emitted events")
    parser.add_argument("--session-id", required=True, help="Deterministic session_id for emitted events")
    parser.add_argument("--symbol", default="MNQM6", help="Symbol label for emitted feature snapshots")
    parser.add_argument("--tick-size", type=float, default=DEFAULT_TICK_SIZE, help="Instrument tick size")
    parser.add_argument("--depth-levels", type=int, default=DEFAULT_DEPTH_LEVELS, help="Depth levels for recent depth imbalance")
    parser.add_argument("--ofi-short-window", type=int, default=DEFAULT_OFI_SHORT_WINDOW, help="Short OFI moving window")
    parser.add_argument("--ofi-medium-window", type=int, default=DEFAULT_OFI_MEDIUM_WINDOW, help="Medium OFI moving window")
    parser.add_argument("--trade-window", type=int, default=DEFAULT_TRADE_WINDOW, help="Trade aggressor imbalance window")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    session_id = validate_session_id(args.session_id)
    report = build_microstructure_feature_journal(
        input_path=Path(args.input),
        output_path=Path(args.out),
        report_path=Path(args.report),
        run_id=args.run_id,
        session_id=session_id,
        symbol=args.symbol,
        tick_size=args.tick_size,
        depth_levels=args.depth_levels,
        ofi_short_window=args.ofi_short_window,
        ofi_medium_window=args.ofi_medium_window,
        trade_window=args.trade_window,
    )
    print(
        json.dumps(
            {
                "feature_schema_version": report.feature_schema_version,
                "emitted_feature_snapshots": report.emitted_feature_snapshots,
                "price_state_inputs": report.price_state_inputs,
                "mbo_book_state_inputs": report.mbo_book_state_inputs,
                "trade_inputs": report.trade_inputs,
                "microstructure_feature_status": report.microstructure_feature_status,
                "data01b_full_status": report.data01b_full_status,
                "sim_status": report.sim_status,
                "rel_status": report.rel_status,
                "diagnostic_count": report.diagnostic_count,
                "diagnostics_truncated": report.diagnostics_truncated,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
