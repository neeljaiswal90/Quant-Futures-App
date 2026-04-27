"""DATA-06A L1/trade session and warmup report CLI."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from services.market_data_sidecar.session.session_clock import WarmupPolicy
from services.market_data_sidecar.session_warmup import (
    analyze_l1_trade_session_warmup_from_probe,
    write_session_warmup_report,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DATA-06A L1/trade session and warmup report")
    parser.add_argument("--input", required=True, help="Rich Rithmic probe/provider JSONL input")
    parser.add_argument("--report", required=True, help="DATA-06A session/warmup report JSON output")
    parser.add_argument("--warmup-sec", type=int, default=60, help="RTH warmup suppression window in seconds")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.warmup_sec < 0:
        raise ValueError("warmup-sec must be non-negative")
    report = analyze_l1_trade_session_warmup_from_probe(
        input_path=Path(args.input),
        warmup_policy=WarmupPolicy(warmup_seconds=args.warmup_sec),
    )
    write_session_warmup_report(Path(args.report), report)
    print(
        json.dumps(
            {
                "status": report.status,
                "partial_parity_status": report.partial_parity_status,
                "data01_full_gate_status": report.data01_full_gate_status,
                "data01b_status": report.data01b_status,
                "verified_l1_trade_rows": report.verified_l1_trade_rows,
                "candidate_eligible_count": report.candidate_eligible_count,
                "warmup_suppressed_count": report.warmup_suppressed_count,
                "transition_count": report.transition_count,
                "phase_counts": report.phase_counts,
                "block_reason_counts": report.block_reason_counts,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
