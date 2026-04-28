"""DATA-02-MBO provider-internal MBO book-state CLI."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from services.market_data_sidecar.book.mbo_book_state import (
    DEFAULT_TICK_SIZE,
    build_mbo_book_state_journal,
)
from services.market_data_sidecar.session.session_clock import validate_session_id


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DATA-02-MBO provider-internal MBO book-state builder")
    parser.add_argument("--input", required=True, help="DATA-01B-MBO journal or rich Rithmic probe JSONL")
    parser.add_argument("--out", required=True, help="MBO book-state MICROSTRUCTURE journal JSONL output")
    parser.add_argument("--report", required=True, help="DATA-02-MBO book-state report JSON output")
    parser.add_argument("--run-id", required=True, help="Deterministic run_id for emitted events")
    parser.add_argument("--session-id", required=True, help="Deterministic session_id for emitted events")
    parser.add_argument("--symbol", default="MNQM6", help="Symbol label for emitted book-state snapshots")
    parser.add_argument("--tick-size", type=float, default=DEFAULT_TICK_SIZE, help="Instrument tick size")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    session_id = validate_session_id(args.session_id)
    report = build_mbo_book_state_journal(
        input_path=Path(args.input),
        output_path=Path(args.out),
        report_path=Path(args.report),
        run_id=args.run_id,
        session_id=session_id,
        symbol=args.symbol,
        tick_size=args.tick_size,
    )
    print(
        json.dumps(
            {
                "book_state_schema_version": report.book_state_schema_version,
                "consumed_mbo_lifecycle_events": report.consumed_mbo_lifecycle_events,
                "emitted_book_state_snapshots": report.emitted_book_state_snapshots,
                "active_orders": report.active_orders,
                "bid_level_count": report.bid_level_count,
                "ask_level_count": report.ask_level_count,
                "mbo_book_state_status": report.mbo_book_state_status,
                "queue_position_status": report.queue_position_status,
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
