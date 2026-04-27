"""DATA-01A L1/trade-only sidecar CLI.

This CLI converts rich Rithmic probe/provider JSONL into OBS-01 QUOTE/TRADE source events.
It is offline-safe and intentionally excludes MBP10/MBO until DATA-01B parity completes.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path

from services.market_data_sidecar.publish.snapshot_publisher import publish_l1_trade_journal_from_probe
from services.market_data_sidecar.session.session_clock import validate_session_id


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DATA-01A L1/trade-only journal publisher")
    parser.add_argument("--input", required=True, help="Rich Rithmic probe/provider JSONL input")
    parser.add_argument("--out", required=True, help="OBS-01 QUOTE/TRADE journal JSONL output")
    parser.add_argument("--report", required=True, help="DATA-01A conversion report JSON output")
    parser.add_argument("--run-id", required=True, help="Deterministic run_id for emitted events")
    parser.add_argument("--session-id", required=True, help="Deterministic session_id for emitted events")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    session_id = validate_session_id(args.session_id)
    report = publish_l1_trade_journal_from_probe(
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
                "partial_parity_status": report.partial_parity_status,
                "data01_full_gate_status": report.data01_full_gate_status,
                "data01b_status": report.data01b_status,
                "input_rows": report.input_rows,
                "emitted_events": report.emitted_events,
                "emitted_quote_events": report.emitted_quote_events,
                "emitted_trade_events": report.emitted_trade_events,
                "skipped_mbp10_rows": report.skipped_mbp10_rows,
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
