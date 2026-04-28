"""DATA-01B-PS MBP10 price-state sidecar CLI."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path

from services.market_data_sidecar.publish.mbp10_price_state_publisher import (
    publish_mbp10_price_state_journal_from_probe,
)
from services.market_data_sidecar.session.session_clock import validate_session_id


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DATA-01B-PS MBP10 price-state journal publisher")
    parser.add_argument("--input", required=True, help="Rich Rithmic probe/provider JSONL input")
    parser.add_argument("--out", required=True, help="OBS-01 MBP10 price-state journal JSONL output")
    parser.add_argument("--report", required=True, help="DATA-01B-PS conversion report JSON output")
    parser.add_argument("--run-id", required=True, help="Deterministic run_id for emitted events")
    parser.add_argument("--session-id", required=True, help="Deterministic session_id for emitted events")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    session_id = validate_session_id(args.session_id)
    report = publish_mbp10_price_state_journal_from_probe(
        input_path=Path(args.input),
        output_path=Path(args.out),
        run_id=args.run_id,
        session_id=session_id,
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
                "mbp10_price_state_status": report.mbp10_price_state_status,
                "mbo_status": report.mbo_status,
                "size_order_count_status": report.size_order_count_status,
                "data01b_full_status": report.data01b_full_status,
                "input_rows": report.input_rows,
                "emitted_events": report.emitted_events,
                "skipped_mbo_rows": report.skipped_mbo_rows,
                "diagnostic_count": report.diagnostic_count,
                "diagnostics_truncated": report.diagnostics_truncated,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
