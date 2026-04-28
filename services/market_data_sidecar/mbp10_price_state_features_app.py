"""DATA-02-PS MBP10 price-state feature snapshot CLI."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path

from services.market_data_sidecar.features.mbp10_price_state_features import (
    DEFAULT_STALE_THRESHOLD_MS,
    DEFAULT_TICK_SIZE,
    build_mbp10_price_state_feature_journal,
)
from services.market_data_sidecar.session.session_clock import validate_session_id


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DATA-02-PS MBP10 price-state feature builder")
    parser.add_argument("--input", required=True, help="DATA-01B-PS journal or rich Rithmic probe JSONL")
    parser.add_argument("--out", required=True, help="Feature snapshot JSONL output")
    parser.add_argument("--report", required=True, help="DATA-02-PS feature report JSON output")
    parser.add_argument("--run-id", required=True, help="Deterministic run_id for emitted events")
    parser.add_argument("--session-id", required=True, help="Deterministic session_id for emitted events")
    parser.add_argument("--symbol", default="MNQM6", help="Symbol label for emitted feature snapshots")
    parser.add_argument("--tick-size", type=float, default=DEFAULT_TICK_SIZE, help="Instrument tick size")
    parser.add_argument(
        "--stale-threshold-ms",
        type=int,
        default=DEFAULT_STALE_THRESHOLD_MS,
        help="Exchange-time gap threshold used to flag stale MBP10 state",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    session_id = validate_session_id(args.session_id)
    report = build_mbp10_price_state_feature_journal(
        input_path=Path(args.input),
        output_path=Path(args.out),
        run_id=args.run_id,
        session_id=session_id,
        symbol=args.symbol,
        tick_size=args.tick_size,
        stale_threshold_ms=args.stale_threshold_ms,
    )
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(asdict(report), sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(
        json.dumps(
            {
                "feature_schema_version": report.feature_schema_version,
                "emitted_feature_snapshots": report.emitted_feature_snapshots,
                "invalid_feature_snapshots": report.invalid_feature_snapshots,
                "mbp10_price_state_status": report.mbp10_price_state_status,
                "mbo_status": report.mbo_status,
                "size_order_count_status": report.size_order_count_status,
                "data01b_full_status": report.data01b_full_status,
                "diagnostic_count": report.diagnostic_count,
                "diagnostics_truncated": report.diagnostics_truncated,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

