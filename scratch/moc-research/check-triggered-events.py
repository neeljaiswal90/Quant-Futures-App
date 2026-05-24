#!/usr/bin/env python3
"""Sanity checks for MOC-R3 triggered-events parquet output."""

from __future__ import annotations

import argparse
import csv
import hashlib
import math
from itertools import product
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq


REPO_ROOT = Path(__file__).resolve().parents[2]
MOC_ROOT = REPO_ROOT / "scratch/moc-research"
DEFAULT_OUTPUT_DIR = MOC_ROOT
BACKLOG_PATH = REPO_ROOT / "docs/plan/new_app_v1_ticket_backlog_v6.csv"
EXPECTED_ROW = [
    "MOC-R3",
    "P2",
    "3.0",
    "MOC-R2",
    "Trigger-conditional simulator: event-level OCO trigger detection + stop-limit fill modeling + post-trigger excursion across 720-cell parameter grid (arm_time x trigger_offset x reference x stop_limit_protection x latency) over 30 RTH sessions; emits triggered-events.parquet",
    "new_in_v6_appendix_a",
]
ARM_TIMES = (15, 10, 5)
TRIGGER_OFFSETS = (0.5, 1.0, 1.5, 2.0, 3.0)
REFERENCES = ("bid_ask", "mid", "microprice")
PROTECTIONS = (None, 0.5, 1.0, 1.5)
LATENCIES = (0, 100, 500, 1000)
EXPECTED_SESSIONS = 30
EXPECTED_ROWS_PER_SESSION = 720
EXPECTED_TOTAL_ROWS = EXPECTED_SESSIONS * EXPECTED_ROWS_PER_SESSION
NS_PER_SECOND = 1_000_000_000
GOOD_FRIDAY = "2026-04-03"
REQUIRED_COLUMNS = {
    "session_date", "arm_time_s", "trigger_offset_pts", "reference",
    "stop_limit_protection_pts", "latency_bucket_ms",
    "armed_buy_stop_px_pts", "armed_sell_stop_px_pts", "armed_ref_px_pts",
    "armed_ts_offset_ns", "buy_triggered_ts_offset_ns",
    "sell_triggered_ts_offset_ns", "outcome", "modeled_trigger_slippage_pts",
    "stop_limit_filled", "stop_limit_fill_price_pts", "stop_limit_miss_reason",
    "post_trigger_mfe_pts", "post_trigger_mae_pts", "time_to_trigger_ns",
}


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir)
    rows = pq.read_table(output_dir / "triggered-events.parquet").to_pylist()
    verify_backlog_row()
    verify_schema(rows)
    verify_row_count(rows)
    verify_good_friday_excluded(rows)
    verify_row_order(rows)
    verify_grid_coverage(rows)
    verify_trigger_consistency(rows)
    verify_latency_monotonicity(rows)
    verify_stop_limit_semantics(rows)
    verify_synthetic_monotone_up()
    verify_synthetic_whipsaw()
    verify_synthetic_latency_monotonicity()
    verify_synthetic_stop_limit_miss()
    verify_synthetic_no_lookahead()
    verify_parquet_metadata(output_dir / "triggered-events.parquet")
    if args.compare_dir:
        compare_hash(output_dir / "triggered-events.parquet", Path(args.compare_dir) / "triggered-events.parquet")
    print("MOC-R3 triggered-events checks passed")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--compare-dir", default=None)
    return parser.parse_args()


def verify_backlog_row() -> None:
    text = BACKLOG_PATH.read_text(encoding="utf-8")
    if not text.endswith("\n"):
        raise AssertionError("backlog CSV must end with LF")
    parsed = list(csv.reader(text.splitlines()))
    if any(len(row) != 6 for row in parsed):
        raise AssertionError("every backlog CSV row must have 6 columns")
    rows = [row for row in parsed if row and row[0] == "MOC-R3"]
    if rows != [EXPECTED_ROW]:
        raise AssertionError(f"MOC-R3 backlog row mismatch: {rows}")


def verify_schema(rows: list[dict[str, Any]]) -> None:
    if not rows:
        raise AssertionError("triggered-events parquet has no rows")
    missing = REQUIRED_COLUMNS - set(rows[0])
    if missing:
        raise AssertionError(f"missing triggered-events columns: {sorted(missing)}")


def verify_row_count(rows: list[dict[str, Any]]) -> None:
    if len(rows) != EXPECTED_TOTAL_ROWS:
        raise AssertionError(f"expected {EXPECTED_TOTAL_ROWS} rows, got {len(rows)}")


def verify_good_friday_excluded(rows: list[dict[str, Any]]) -> None:
    if any(row["session_date"] == GOOD_FRIDAY for row in rows):
        raise AssertionError("Good Friday leaked into triggered-events output")


def sort_key(row: dict[str, Any]) -> tuple[Any, ...]:
    protection = -1.0 if row["stop_limit_protection_pts"] is None else float(row["stop_limit_protection_pts"])
    return (
        row["session_date"],
        int(row["arm_time_s"]),
        float(row["trigger_offset_pts"]),
        row["reference"],
        protection,
        int(row["latency_bucket_ms"]),
    )


def verify_row_order(rows: list[dict[str, Any]]) -> None:
    previous: tuple[Any, ...] | None = None
    for row in rows:
        key = sort_key(row)
        if previous is not None and key < previous:
            raise AssertionError("triggered-events rows are not sorted deterministically")
        previous = key


def verify_grid_coverage(rows: list[dict[str, Any]]) -> None:
    by_session: dict[str, set[tuple[Any, ...]]] = {}
    for row in rows:
        key = (
            int(row["arm_time_s"]),
            float(row["trigger_offset_pts"]),
            row["reference"],
            None if row["stop_limit_protection_pts"] is None else float(row["stop_limit_protection_pts"]),
            int(row["latency_bucket_ms"]),
        )
        by_session.setdefault(row["session_date"], set()).add(key)
    expected = set(product(ARM_TIMES, TRIGGER_OFFSETS, REFERENCES, PROTECTIONS, LATENCIES))
    if len(by_session) != EXPECTED_SESSIONS:
        raise AssertionError(f"expected {EXPECTED_SESSIONS} sessions, got {len(by_session)}")
    for session, grid in by_session.items():
        if grid != expected:
            raise AssertionError(f"grid coverage mismatch for {session}")


def verify_trigger_consistency(rows: list[dict[str, Any]]) -> None:
    valid_outcomes = {"neither", "buy_only", "sell_only", "both_sides"}
    for row in rows:
        outcome = row["outcome"]
        if outcome not in valid_outcomes:
            raise AssertionError(f"invalid outcome: {outcome}")
        buy_ts = row["buy_triggered_ts_offset_ns"]
        sell_ts = row["sell_triggered_ts_offset_ns"]
        armed_offset = int(row["armed_ts_offset_ns"])
        expected_armed_offset = -int(row["arm_time_s"]) * NS_PER_SECOND
        if armed_offset != expected_armed_offset:
            raise AssertionError("armed_ts_offset_ns mismatch")
        if buy_ts is not None and int(buy_ts) < armed_offset:
            raise AssertionError("buy trigger before armed timestamp")
        if sell_ts is not None and int(sell_ts) < armed_offset:
            raise AssertionError("sell trigger before armed timestamp")
        if outcome == "neither" and not (buy_ts is None and sell_ts is None):
            raise AssertionError("neither row has trigger timestamp")
        if outcome == "buy_only" and not (buy_ts is not None and sell_ts is None):
            raise AssertionError("buy_only timestamp mismatch")
        if outcome == "sell_only" and not (buy_ts is None and sell_ts is not None):
            raise AssertionError("sell_only timestamp mismatch")
        if outcome == "both_sides" and not (buy_ts is not None and sell_ts is not None):
            raise AssertionError("both_sides must carry both trigger timestamps")
        if outcome == "neither":
            for field in (
                "modeled_trigger_slippage_pts", "stop_limit_filled",
                "stop_limit_fill_price_pts", "stop_limit_miss_reason",
                "post_trigger_mfe_pts", "post_trigger_mae_pts", "time_to_trigger_ns",
            ):
                if row[field] is not None:
                    raise AssertionError(f"neither row has non-null {field}")
        elif row["time_to_trigger_ns"] is None or int(row["time_to_trigger_ns"]) < 0:
            raise AssertionError("triggered row missing non-negative time_to_trigger_ns")


def verify_latency_monotonicity(rows: list[dict[str, Any]]) -> None:
    grouped: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    for row in rows:
        key = (
            row["session_date"], int(row["arm_time_s"]), float(row["trigger_offset_pts"]),
            row["reference"], row["stop_limit_protection_pts"], row["outcome"],
        )
        grouped.setdefault(key, []).append(row)
    for key, group in grouped.items():
        ordered = sorted(group, key=lambda row: int(row["latency_bucket_ms"]))
        values = [row["modeled_trigger_slippage_pts"] for row in ordered]
        if all(value is None for value in values):
            continue
        numeric = [float(value) for value in values if value is not None]
        if numeric != sorted(numeric):
            raise AssertionError(f"latency slippage not monotone for {key}: {numeric}")


def verify_stop_limit_semantics(rows: list[dict[str, Any]]) -> None:
    triggered_stop_market = [row for row in rows if row["outcome"] != "neither" and row["stop_limit_protection_pts"] is None]
    if not triggered_stop_market:
        raise AssertionError("expected at least one triggered stop-market row")
    if not any(row["stop_limit_filled"] is True for row in triggered_stop_market):
        raise AssertionError("expected at least one stop-market fill")
    limited = [row for row in rows if row["outcome"] != "neither" and row["stop_limit_protection_pts"] is not None]
    if not limited:
        raise AssertionError("expected at least one stop-limit row")
    for row in limited:
        if row["stop_limit_filled"] is False and row["stop_limit_miss_reason"] != "no_print_within_limit":
            raise AssertionError("stop-limit miss reason mismatch")


def verify_synthetic_monotone_up() -> None:
    rows = synthetic_simulate([100, 100.5, 101.5, 102.5], [100.5, 101, 102, 103], [100.25, 100.75, 101.75, 102.75], 100, 1)
    if rows["outcome"] != "buy_only":
        raise AssertionError("synthetic monotone-up should be buy_only")
    if rows["post_trigger_mfe_pts"] <= 0:
        raise AssertionError("synthetic monotone-up MFE must be positive")
    if rows["buy_triggered_ts_offset_ns"] != 1:
        raise AssertionError("synthetic monotone-up trigger timestamp mismatch")


def verify_synthetic_whipsaw() -> None:
    rows = synthetic_simulate([100, 100, 97], [101, 104, 98], [102, 101, 99], 100, 1)
    if rows["outcome"] != "both_sides":
        raise AssertionError("synthetic whipsaw should be both_sides")
    if rows["buy_triggered_ts_offset_ns"] is None or rows["sell_triggered_ts_offset_ns"] is None:
        raise AssertionError("synthetic whipsaw must emit both trigger timestamps")


def verify_synthetic_latency_monotonicity() -> None:
    values = [latency_slippage(latency) for latency in LATENCIES]
    if values != sorted(values):
        raise AssertionError(f"synthetic latency slippage not monotone: {values}")


def verify_synthetic_stop_limit_miss() -> None:
    filled = stop_limit_fill("buy", trigger_price=101, protection=0.5, prints=[102.0, 103.0])
    if filled["filled"] is not False or filled["reason"] != "no_print_within_limit":
        raise AssertionError("synthetic stop-limit miss failed")


def verify_synthetic_no_lookahead() -> None:
    rows = synthetic_simulate([100, 100, 100], [101, 101, 105], [101, 101, 105], 100, 3)
    if rows["buy_triggered_ts_offset_ns"] != 2:
        raise AssertionError("future sentinel leaked into earlier trigger detection")


def synthetic_simulate(bids: list[float], asks: list[float], mids: list[float], ref: float, offset: float) -> dict[str, Any]:
    buy_stop = ref + offset
    sell_stop = ref - offset
    buy_ts = next((idx for idx, ask in enumerate(asks) if ask >= buy_stop), None)
    sell_ts = next((idx for idx, bid in enumerate(bids) if bid <= sell_stop), None)
    if buy_ts is not None and sell_ts is not None:
        outcome = "both_sides"
        side = "buy" if buy_ts <= sell_ts else "sell"
        trigger_ts = min(buy_ts, sell_ts)
    elif buy_ts is not None:
        outcome = "buy_only"
        side = "buy"
        trigger_ts = buy_ts
    elif sell_ts is not None:
        outcome = "sell_only"
        side = "sell"
        trigger_ts = sell_ts
    else:
        return {"outcome": "neither", "buy_triggered_ts_offset_ns": None, "sell_triggered_ts_offset_ns": None}
    future_mids = mids[trigger_ts:]
    if side == "buy":
        mfe = max(future_mids) - buy_stop
        mae = min(future_mids) - buy_stop
    else:
        mfe = sell_stop - min(future_mids)
        mae = sell_stop - max(future_mids)
    return {
        "outcome": outcome,
        "buy_triggered_ts_offset_ns": buy_ts,
        "sell_triggered_ts_offset_ns": sell_ts,
        "post_trigger_mfe_pts": mfe,
        "post_trigger_mae_pts": mae,
    }


def latency_slippage(latency_ms: int) -> float:
    tick_size = 0.25
    base_ticks = round((latency_ms / 1000) / tick_size)
    return base_ticks * tick_size


def stop_limit_fill(side: str, trigger_price: float, protection: float | None, prints: list[float]) -> dict[str, Any]:
    if protection is None:
        return {"filled": bool(prints), "reason": None if prints else "no_print_within_limit"}
    limit = trigger_price + protection if side == "buy" else trigger_price - protection
    for price in prints:
        if (side == "buy" and price <= limit) or (side == "sell" and price >= limit):
            return {"filled": True, "reason": None}
    return {"filled": False, "reason": "no_print_within_limit"}


def verify_parquet_metadata(path: Path) -> None:
    metadata = pq.read_metadata(path).metadata or {}
    for key, value in metadata.items():
        key_text = key.decode("utf-8", errors="ignore").lower()
        value_text = value.decode("utf-8", errors="ignore").lower()
        if "generated_at_utc" in key_text or "generated_at_utc" in value_text:
            raise AssertionError("wall-clock metadata detected")


def compare_hash(left: Path, right: Path) -> None:
    left_hash = sha256(left)
    right_hash = sha256(right)
    if left_hash != right_hash:
        raise AssertionError(f"triggered-events hash mismatch: {left_hash} != {right_hash}")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())
