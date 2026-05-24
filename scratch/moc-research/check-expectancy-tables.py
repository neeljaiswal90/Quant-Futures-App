#!/usr/bin/env python3
"""Sanity checks for MOC-R4 expectancy tables, heatmaps, and manifest."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
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
    "MOC-R4",
    "P2",
    "2.0",
    "MOC-R3",
    "Hit-curve + expectancy heatmaps + research-grid manifest: event-level PT-vs-stop first-touch ordering across exit grid (pt_pts x stop_pts) x cost scenarios x R3 trigger grid; emits expectancy-tables.parquet + PNG heatmaps + research-grid-manifest.json",
    "new_in_v6_appendix_a",
]
PT_GRID = (0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0)
STOP_GRID = (1.0, 1.5, 2.0, 2.5, 3.0, 4.0)
COST_SCENARIOS = {
    "mnq_low": {"commission_round_trip_usd": 0.60, "slippage_per_side_ticks": 0.25},
    "mnq_mid": {"commission_round_trip_usd": 1.00, "slippage_per_side_ticks": 0.50},
    "mnq_high": {"commission_round_trip_usd": 1.50, "slippage_per_side_ticks": 1.00},
}
LATENCY_GRID = (0, 100, 500, 1000)
ARM_GRID = (5, 10, 15)
TRIGGER_OFFSET_GRID = (0.5, 1.0, 1.5, 2.0, 3.0)
REFERENCE_GRID = ("bid_ask", "microprice", "mid")
PROTECTION_GRID = (None, 0.5, 1.0, 1.5)
EXPECTED_ROWS = 90720
EXPECTED_HEATMAPS = 108
POINT_VALUE_USD = 2.0
TICK_VALUE_USD = 0.50
REQUIRED_MANIFEST_FIELDS = {
    "trigger_cells", "exit_cells", "cost_cells", "total_screened_cells_max",
    "primary_selection_metric", "multiple_testing_control", "notes",
}
REQUIRED_COLUMNS = {
    "pt_pts", "stop_pts", "cost_scenario", "latency_bucket_ms", "instrument",
    "arm_time_s", "trigger_offset_pts", "reference", "stop_limit_protection_pts",
    "n_events_total", "n_triggered_one_side", "n_triggered_both_sides",
    "n_triggered_neither", "p_triggered_one_side", "p_both_side_false_trigger",
    "p_pt_hit_before_stop", "p_stop_hit_before_pt", "p_time_stop",
    "p_stop_limit_miss", "expectancy_per_trade_usd", "expectancy_per_trade_pts",
    "trade_frequency_per_session", "expected_daily_pnl_usd",
}


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir)
    table_path = output_dir / "expectancy-tables.parquet"
    rows = pq.read_table(table_path).to_pylist()
    verify_backlog_row()
    verify_schema(rows)
    verify_row_count(rows)
    verify_grid_coverage(rows)
    verify_manifest(output_dir / "research-grid-manifest.json")
    verify_png_count(output_dir / "expectancy-heatmaps")
    verify_expectancy_formula(rows)
    verify_stop_limit_miss(rows)
    verify_low_count_rows_present(rows)
    verify_metadata(table_path)
    if args.compare_dir:
        compare_outputs(output_dir, Path(args.compare_dir))
    print("MOC-R4 expectancy-table checks passed")
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
    rows = [row for row in parsed if row and row[0] == "MOC-R4"]
    if rows != [EXPECTED_ROW]:
        raise AssertionError(f"MOC-R4 backlog row mismatch: {rows}")


def verify_schema(rows: list[dict[str, Any]]) -> None:
    if not rows:
        raise AssertionError("expectancy table has no rows")
    missing = REQUIRED_COLUMNS - set(rows[0])
    if missing:
        raise AssertionError(f"missing expectancy columns: {sorted(missing)}")


def verify_row_count(rows: list[dict[str, Any]]) -> None:
    if len(rows) != EXPECTED_ROWS:
        raise AssertionError(f"expected {EXPECTED_ROWS} rows, got {len(rows)}")


def key(row: dict[str, Any]) -> tuple[Any, ...]:
    protection = None if row["stop_limit_protection_pts"] is None else float(row["stop_limit_protection_pts"])
    return (
        float(row["pt_pts"]), float(row["stop_pts"]), row["cost_scenario"], int(row["latency_bucket_ms"]),
        row["instrument"], int(row["arm_time_s"]), float(row["trigger_offset_pts"]), row["reference"],
        -1.0 if protection is None else protection,
    )


def verify_grid_coverage(rows: list[dict[str, Any]]) -> None:
    actual = {key(row) for row in rows}
    expected = {
        (pt, stop, cost, latency, "MNQ", arm, offset, reference, protection)
        for pt, stop, cost, latency, arm, offset, reference, protection in product(
            PT_GRID, STOP_GRID, tuple(COST_SCENARIOS), LATENCY_GRID, ARM_GRID,
            TRIGGER_OFFSET_GRID, REFERENCE_GRID, tuple(-1.0 if value is None else value for value in PROTECTION_GRID),
        )
    }
    if actual != expected:
        raise AssertionError(f"grid mismatch: missing={len(expected - actual)} extra={len(actual - expected)}")
    previous: tuple[Any, ...] | None = None
    for row in rows:
        row_key = key(row)
        if previous is not None and row_key < previous:
            raise AssertionError("expectancy table row order is not deterministic")
        previous = row_key


def verify_manifest(path: Path) -> None:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    missing = REQUIRED_MANIFEST_FIELDS - set(manifest)
    if missing:
        raise AssertionError(f"manifest missing fields: {sorted(missing)}")
    if manifest["cost_cells"] != 3:
        raise AssertionError("manifest cost_cells must be 3 for MNQ-only")
    if manifest["total_screened_cells_max"] != EXPECTED_ROWS:
        raise AssertionError("manifest total_screened_cells_max mismatch")
    if manifest["primary_selection_metric"] != "expected_daily_pnl_usd":
        raise AssertionError("manifest primary metric mismatch")


def verify_png_count(path: Path) -> None:
    files = sorted(path.glob("*.png"))
    if len(files) != EXPECTED_HEATMAPS:
        raise AssertionError(f"expected {EXPECTED_HEATMAPS} PNGs, got {len(files)}")
    if any(file.stat().st_size == 0 for file in files):
        raise AssertionError("empty PNG file detected")


def verify_expectancy_formula(rows: list[dict[str, Any]]) -> None:
    sample = next(row for row in rows if row["cost_scenario"] == "mnq_mid" and row["pt_pts"] == 2.0 and row["stop_pts"] == 2.0)
    cost = COST_SCENARIOS["mnq_mid"]
    cost_usd = cost["commission_round_trip_usd"] + cost["slippage_per_side_ticks"] * 2 * TICK_VALUE_USD
    # We cannot reconstruct the avg time-stop close component from the row alone;
    # instead verify that the USD/points/cost relationship is internally coherent.
    expected_usd = float(sample["expectancy_per_trade_pts"]) * POINT_VALUE_USD - cost_usd
    assert_close(float(sample["expectancy_per_trade_usd"]), expected_usd, "expectancy usd")
    expected_daily = float(sample["expectancy_per_trade_usd"]) * float(sample["trade_frequency_per_session"])
    assert_close(float(sample["expected_daily_pnl_usd"]), expected_daily, "daily pnl")


def verify_stop_limit_miss(rows: list[dict[str, Any]]) -> None:
    for row in rows:
        numerator = float(row["p_stop_limit_miss"]) * int(row["n_events_total"])
        if not math.isclose(numerator, round(numerator), rel_tol=0, abs_tol=1e-8):
            raise AssertionError("p_stop_limit_miss is not count-derived")


def verify_low_count_rows_present(rows: list[dict[str, Any]]) -> None:
    # Plan A says low-count cells are greyed in PNGs, not suppressed in data.
    if not all(int(row["n_events_total"]) == 30 for row in rows):
        raise AssertionError("R4 aggregate cells should retain all 30 session rows")


def verify_metadata(path: Path) -> None:
    metadata = pq.read_metadata(path).metadata or {}
    for key_bytes, value_bytes in metadata.items():
        text = (key_bytes + value_bytes).decode("utf-8", errors="ignore").lower()
        if "generated_at_utc" in text:
            raise AssertionError("wall-clock metadata detected")


def compare_outputs(left: Path, right: Path) -> None:
    compare_hash(left / "expectancy-tables.parquet", right / "expectancy-tables.parquet")
    compare_hash(left / "research-grid-manifest.json", right / "research-grid-manifest.json")
    left_png = sorted((left / "expectancy-heatmaps").glob("*.png"))
    right_png = sorted((right / "expectancy-heatmaps").glob("*.png"))
    if [p.name for p in left_png] != [p.name for p in right_png]:
        raise AssertionError("PNG filename set mismatch")
    for l_path, r_path in zip(left_png, right_png, strict=True):
        compare_hash(l_path, r_path)


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
