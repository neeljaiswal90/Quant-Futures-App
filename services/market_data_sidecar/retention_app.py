"""DATA-05A L1/trade retention CLI."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from services.market_data_sidecar.retention import (
    DiskPressureSnapshot,
    L1TradeRetentionPolicy,
    apply_l1_trade_retention,
    plan_l1_trade_retention,
    write_retention_report,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DATA-05A L1/trade journal retention planner")
    parser.add_argument("--journal-dir", required=True, help="Directory containing raw L1/trade JSONL journals")
    parser.add_argument("--archive-dir", required=True, help="Directory for compressed L1/trade journal archives")
    parser.add_argument("--report", required=True, help="Retention report JSON output")
    parser.add_argument("--reference-session-id", required=True, help="Deterministic YYYY-MM-DD-rth reference session")
    parser.add_argument("--keep-raw-rth-sessions", type=int, default=2)
    parser.add_argument("--compressed-hot-days", type=int, default=14)
    parser.add_argument("--disk-total-bytes", type=int)
    parser.add_argument("--disk-free-bytes", type=int)
    parser.add_argument("--disk-warning-used-pct", type=float, default=70.0)
    parser.add_argument("--disk-fail-used-pct", type=float, default=85.0)
    parser.add_argument("--apply", action="store_true", help="Apply compression/deletion actions; default is plan-only")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.keep_raw_rth_sessions < 1:
        raise ValueError("keep-raw-rth-sessions must be positive")
    if args.compressed_hot_days < 0:
        raise ValueError("compressed-hot-days must be non-negative")
    if args.disk_warning_used_pct < 0 or args.disk_warning_used_pct > 100:
        raise ValueError("disk-warning-used-pct must be between 0 and 100")
    if args.disk_fail_used_pct < 0 or args.disk_fail_used_pct > 100:
        raise ValueError("disk-fail-used-pct must be between 0 and 100")
    if args.disk_warning_used_pct >= args.disk_fail_used_pct:
        raise ValueError("disk-warning-used-pct must be less than disk-fail-used-pct")
    if (args.disk_total_bytes is None) != (args.disk_free_bytes is None):
        raise ValueError("disk-total-bytes and disk-free-bytes must be provided together")

    policy = L1TradeRetentionPolicy(
        keep_raw_rth_sessions=args.keep_raw_rth_sessions,
        compressed_hot_days=args.compressed_hot_days,
        disk_warning_used_pct=args.disk_warning_used_pct,
        disk_fail_used_pct=args.disk_fail_used_pct,
    )
    disk_pressure = (
        None
        if args.disk_total_bytes is None
        else DiskPressureSnapshot(total_bytes=args.disk_total_bytes, free_bytes=args.disk_free_bytes)
    )
    kwargs = {
        "journal_dir": Path(args.journal_dir),
        "archive_dir": Path(args.archive_dir),
        "reference_session_id": args.reference_session_id,
        "policy": policy,
        "disk_pressure": disk_pressure,
    }
    report = apply_l1_trade_retention(**kwargs) if args.apply else plan_l1_trade_retention(**kwargs)
    write_retention_report(Path(args.report), report)
    print(
        json.dumps(
            {
                "status": report.status,
                "mode": report.mode,
                "partial_parity_status": report.partial_parity_status,
                "data01_full_gate_status": report.data01_full_gate_status,
                "data01b_status": report.data01b_status,
                "keep_raw_count": report.keep_raw_count,
                "compress_raw_count": report.compress_raw_count,
                "delete_compressed_count": report.delete_compressed_count,
                "disk_pressure": report.disk_pressure,
                "diagnostic_count": len(report.diagnostics),
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
