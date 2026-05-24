#!/usr/bin/env python3
"""Sanity checks for MOC-R5 conditioning outputs."""

from __future__ import annotations

import argparse
import csv
import hashlib
import math
import re
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq

REPO_ROOT = Path(__file__).resolve().parents[2]
MOC_ROOT = REPO_ROOT / "scratch/moc-research"
DEFAULT_OUTPUT_DIR = MOC_ROOT
BACKLOG_PATH = REPO_ROOT / "docs/plan/new_app_v1_ticket_backlog_v6.csv"
EXPECTANCY_TABLE_PATH = MOC_ROOT / "expectancy-tables.parquet"
EXPECTED_ROW = [
    "MOC-R5",
    "P2",
    "2.5",
    "MOC-R4",
    "Conditioning analysis: stratify expectancy by R1 calendar flags (vix_quartile/regime/day_of_week/roll/macro/triple_witching/month_end/quarter_end) and R2 pre-event microstructure (spread/imbalance/volume_z) buckets; emit conditioning-tables.parquet + conditioning-summary.md (top-10 ranked by expected_daily_pnl_usd)",
    "new_in_v6_appendix_a",
]
DIMENSION_ORDER = [
    "vix_quartile",
    "regime_label",
    "day_of_week",
    "is_roll_week",
    "is_macro_day",
    "calendar_combinatorial",
    "pre_event_spread_ticks_t_minus_10s",
    "pre_event_imbalance_t_minus_10s",
    "pre_event_volume_z_score",
]
R4_COLUMNS = [
    "pt_pts", "stop_pts", "cost_scenario", "latency_bucket_ms", "instrument",
    "arm_time_s", "trigger_offset_pts", "reference", "stop_limit_protection_pts",
    "n_events_total", "n_triggered_one_side", "n_triggered_both_sides",
    "n_triggered_neither", "p_triggered_one_side", "p_both_side_false_trigger",
    "p_pt_hit_before_stop", "p_stop_hit_before_pt", "p_time_stop",
    "p_stop_limit_miss", "expectancy_per_trade_usd", "expectancy_per_trade_pts",
    "trade_frequency_per_session", "expected_daily_pnl_usd",
]
REQUIRED_COLUMNS = ["stratification_dimension", "stratification_bucket", *R4_COLUMNS]
BUCKET_SETS = {
    "vix_quartile": {"Q1_low", "Q2", "Q3", "Q4_high"},
    "regime_label": {"high", "mid", "low", "transition_pending"},
    "day_of_week": {"Mon", "Tue", "Wed", "Thu", "Fri"},
    "is_roll_week": {"true", "false"},
    "is_macro_day": {"true", "false"},
    "pre_event_spread_ticks_t_minus_10s": {"1", "2", ">=3"},
    "pre_event_imbalance_t_minus_10s": {"strong_bid", "neutral", "strong_ask"},
    "pre_event_volume_z_score": {"low", "normal", "high"},
}
COST_SCENARIOS = {
    "mnq_low": {"commission_round_trip_usd": 0.60, "slippage_per_side_ticks": 0.25},
    "mnq_mid": {"commission_round_trip_usd": 1.00, "slippage_per_side_ticks": 0.50},
    "mnq_high": {"commission_round_trip_usd": 1.50, "slippage_per_side_ticks": 1.00},
}
POINT_VALUE_USD = 2.0
TICK_VALUE_USD = 0.50
MIN_EVENTS = 20


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir)
    rows = pq.read_table(output_dir / "conditioning-tables.parquet").to_pylist()
    summary = (output_dir / "conditioning-summary.md").read_text(encoding="utf-8")
    verify_backlog_row()
    verify_schema(rows)
    verify_min_events(rows)
    verify_dimension_coverage(rows, summary)
    verify_bucket_values(rows)
    verify_calendar_combo(rows, summary)
    verify_sort_order(rows)
    verify_top10(rows, summary)
    verify_expectancy_formula(rows)
    verify_r4_consistency(rows)
    verify_metadata(output_dir / "conditioning-tables.parquet")
    verify_summary_complete(summary)
    if args.compare_dir:
        compare_outputs(output_dir, Path(args.compare_dir))
    print("MOC-R5 conditioning checks passed")
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
    rows = [row for row in parsed if row and row[0] == "MOC-R5"]
    if rows != [EXPECTED_ROW]:
        raise AssertionError(f"MOC-R5 backlog row mismatch: {rows}")


def verify_schema(rows: list[dict[str, Any]]) -> None:
    if not rows:
        raise AssertionError("conditioning table has no rows")
    columns = list(rows[0].keys())
    if columns != REQUIRED_COLUMNS:
        raise AssertionError(f"conditioning schema mismatch: {columns}")


def verify_min_events(rows: list[dict[str, Any]]) -> None:
    if any(int(row["n_events_total"]) < MIN_EVENTS for row in rows):
        raise AssertionError("n<20 row emitted")
    for row in rows:
        if int(row["n_events_total"]) > 30:
            raise AssertionError("conditioning subset exceeds underlying session count")


def verify_dimension_coverage(rows: list[dict[str, Any]], summary: str) -> None:
    emitted = {str(row["stratification_dimension"]) for row in rows}
    missing = [dimension for dimension in DIMENSION_ORDER if dimension not in emitted]
    for dimension in missing:
        if "No surviving rows:" not in summary or dimension not in summary:
            raise AssertionError(f"dimension {dimension} missing without summary note")


def verify_bucket_values(rows: list[dict[str, Any]]) -> None:
    combo_pattern = re.compile(r"^is_friday=(true|false)\|is_month_end=(true|false)\|is_quarter_end=(true|false)\|is_triple_witching=(true|false)$")
    for row in rows:
        dimension = str(row["stratification_dimension"])
        bucket = str(row["stratification_bucket"])
        if dimension == "calendar_combinatorial":
            if combo_pattern.match(bucket) is None:
                raise AssertionError(f"unexpected calendar combo bucket: {bucket}")
        elif bucket not in BUCKET_SETS[dimension]:
            raise AssertionError(f"unexpected bucket for {dimension}: {bucket}")


def verify_calendar_combo(rows: list[dict[str, Any]], summary: str) -> None:
    combos = sorted({str(row["stratification_bucket"]) for row in rows if row["stratification_dimension"] == "calendar_combinatorial"})
    if combos and "Calendar combinatorial buckets use observed combinations only" not in summary:
        raise AssertionError("calendar combinatorial enumeration missing from summary")


def sort_key(row: dict[str, Any]) -> tuple[Any, ...]:
    protection = row["stop_limit_protection_pts"]
    return (
        row["stratification_dimension"], row["stratification_bucket"], float(row["pt_pts"]), float(row["stop_pts"]),
        row["cost_scenario"], int(row["latency_bucket_ms"]), int(row["arm_time_s"]), float(row["trigger_offset_pts"]),
        row["reference"], -1.0 if protection is None else float(protection), row["instrument"],
    )


def verify_sort_order(rows: list[dict[str, Any]]) -> None:
    previous: tuple[Any, ...] | None = None
    seen = set()
    for row in rows:
        key = sort_key(row)
        if previous is not None and key < previous:
            raise AssertionError("conditioning rows not sorted")
        if key in seen:
            raise AssertionError("duplicate conditioning row key")
        seen.add(key)
        previous = key


def verify_top10(rows: list[dict[str, Any]], summary: str) -> None:
    section = summary.split("## Top 10 by expected_daily_pnl_usd", 1)[1]
    data_lines = [line for line in section.splitlines() if line.startswith("| ") and not line.startswith("| rank") and not line.startswith("|---")]
    if len(data_lines) != 10:
        raise AssertionError(f"expected 10 top rows, found {len(data_lines)}")
    expected = sorted(rows, key=lambda row: (-float(row["expected_daily_pnl_usd"]), sort_key(row)))[:10]
    for idx, row in enumerate(expected, start=1):
        line = data_lines[idx - 1]
        if f"| {idx} | {row['stratification_dimension']} | {row['stratification_bucket']} |" not in line:
            raise AssertionError("top-10 ordering mismatch")


def verify_expectancy_formula(rows: list[dict[str, Any]]) -> None:
    sample = next(row for row in rows if row["cost_scenario"] == "mnq_mid" and float(row["pt_pts"]) == 2.0 and float(row["stop_pts"]) == 2.0)
    cost = COST_SCENARIOS["mnq_mid"]
    cost_usd = cost["commission_round_trip_usd"] + cost["slippage_per_side_ticks"] * 2 * TICK_VALUE_USD
    expected_usd = float(sample["expectancy_per_trade_pts"]) * POINT_VALUE_USD - cost_usd
    assert_close(float(sample["expectancy_per_trade_usd"]), expected_usd, "expectancy usd")
    expected_daily = float(sample["expectancy_per_trade_usd"]) * float(sample["trade_frequency_per_session"])
    assert_close(float(sample["expected_daily_pnl_usd"]), expected_daily, "daily pnl")


def verify_r4_consistency(rows: list[dict[str, Any]]) -> None:
    r4_rows = {r4_key(row): row for row in pq.read_table(EXPECTANCY_TABLE_PATH).to_pylist()}
    candidates = [row for row in rows if int(row["n_events_total"]) == 30]
    if not candidates:
        raise AssertionError("no degenerate all-session bucket available for R4 consistency check")
    sample = candidates[0]
    r4 = r4_rows[r4_key(sample)]
    for column in R4_COLUMNS:
        left = sample[column]
        right = r4[column]
        if isinstance(left, float) or isinstance(right, float):
            if (left is None) != (right is None):
                raise AssertionError(f"R4 consistency null mismatch for {column}")
            if left is not None:
                assert_close(float(left), float(right), f"R4 consistency {column}")
        else:
            if left != right:
                raise AssertionError(f"R4 consistency {column}: {left} != {right}")


def r4_key(row: dict[str, Any]) -> tuple[Any, ...]:
    protection = row["stop_limit_protection_pts"]
    return (
        float(row["pt_pts"]), float(row["stop_pts"]), row["cost_scenario"], int(row["latency_bucket_ms"]),
        row["instrument"], int(row["arm_time_s"]), float(row["trigger_offset_pts"]), row["reference"],
        -1.0 if protection is None else float(protection),
    )


def verify_metadata(path: Path) -> None:
    metadata = pq.read_metadata(path).metadata or {}
    for key_bytes, value_bytes in metadata.items():
        text = (key_bytes + value_bytes).decode("utf-8", errors="ignore").lower()
        if "generated_at_utc" in text:
            raise AssertionError("wall-clock metadata detected")


def verify_summary_complete(summary: str) -> None:
    required = [
        "Input SHAs", "Both-sides carry-forward", "Observed bucket session counts",
        "Surviving buckets after n<20 filter", "Filtered tuple count", "MOC-R5 recomputes R4 expectancy",
    ]
    for text in required:
        if text not in summary:
            raise AssertionError(f"summary missing required text: {text}")


def compare_outputs(left: Path, right: Path) -> None:
    compare_hash(left / "conditioning-tables.parquet", right / "conditioning-tables.parquet")
    compare_hash(left / "conditioning-summary.md", right / "conditioning-summary.md")


def compare_hash(left: Path, right: Path) -> None:
    left_hash = sha256(left)
    right_hash = sha256(right)
    if left_hash != right_hash:
        raise AssertionError(f"hash mismatch for {left.name}: {left_hash} != {right_hash}")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def assert_close(actual: float, expected: float, label: str) -> None:
    if not math.isclose(actual, expected, rel_tol=0, abs_tol=1e-9):
        raise AssertionError(f"{label}: {actual} != {expected}")


if __name__ == "__main__":
    raise SystemExit(main())
