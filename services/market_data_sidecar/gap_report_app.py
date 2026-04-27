"""DATA-07A L1/trade gap report CLI."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path

from services.market_data_sidecar.gap_detection import (
    GapThresholds,
    analyze_l1_trade_gaps_from_probe,
    write_gap_report,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DATA-07A L1/trade-only gap report")
    parser.add_argument("--input", required=True, help="Rich Rithmic probe/provider JSONL input")
    parser.add_argument("--report", required=True, help="DATA-07A gap report JSON output")
    parser.add_argument("--quote-warning-ms", type=int, default=1_000)
    parser.add_argument("--quote-fail-ms", type=int, default=5_000)
    parser.add_argument("--trade-warning-ms", type=int, default=60_000)
    parser.add_argument("--trade-fail-ms", type=int, default=300_000)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = analyze_l1_trade_gaps_from_probe(
        input_path=Path(args.input),
        thresholds=GapThresholds(
            l1_quote_warning_ms=args.quote_warning_ms,
            l1_quote_fail_ms=args.quote_fail_ms,
            last_trade_warning_ms=args.trade_warning_ms,
            last_trade_fail_ms=args.trade_fail_ms,
        ),
    )
    write_gap_report(Path(args.report), report)
    print(
        json.dumps(
            {
                "status": report.status,
                "partial_parity_status": report.partial_parity_status,
                "data01_full_gate_status": report.data01_full_gate_status,
                "data01b_status": report.data01b_status,
                "quote_gap_count": report.quote_gap_count,
                "trade_gap_count": report.trade_gap_count,
                "max_quote_gap_ms": report.max_quote_gap_ms,
                "max_trade_gap_ms": report.max_trade_gap_ms,
                "warning_count": report.warning_count,
                "fail_count": report.fail_count,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
