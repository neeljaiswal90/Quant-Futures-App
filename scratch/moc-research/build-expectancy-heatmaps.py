#!/usr/bin/env python3
"""Build MOC-R4 expectancy tables, heatmaps, and research-grid manifest."""

from __future__ import annotations

import hashlib
import json
import os
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

REPO_ROOT = Path(__file__).resolve().parents[2]
MOC_ROOT = REPO_ROOT / "scratch/moc-research"
OUTPUT_DIR = Path(os.environ.get("MOC_R4_OUTPUT_DIR", str(MOC_ROOT)))
EVENT_STREAM_PATH = MOC_ROOT / "event-stream.parquet"
EVENT_STREAM_ATTESTATION_PATH = MOC_ROOT / "event-stream.sha256.txt"
TRIGGERED_EVENTS_PATH = MOC_ROOT / "triggered-events.parquet"
MANIFEST_INPUT_PATH = MOC_ROOT / "event-day-manifest.json"
EXPECTANCY_TABLE_PATH = OUTPUT_DIR / "expectancy-tables.parquet"
MANIFEST_PATH = OUTPUT_DIR / "research-grid-manifest.json"
METHODOLOGY_PATH = OUTPUT_DIR / "expectancy-tables-methodology.md"
HEATMAP_DIR = OUTPUT_DIR / "expectancy-heatmaps"

TRIGGERED_EVENTS_SHA = "7da601066b958e484238a7fe767f6aead80df83ea38d54bbba1616b6b5dead3f"
EVENT_STREAM_SHA = "f9effd810b609c03394e96c69e473e9d388eec82accdcbf8975494a307c330cb"

PT_GRID = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0]
STOP_GRID = [1.0, 1.5, 2.0, 2.5, 3.0, 4.0]
COST_SCENARIOS = {
    "mnq_low": {"commission_round_trip_usd": 0.60, "slippage_per_side_ticks": 0.25},
    "mnq_mid": {"commission_round_trip_usd": 1.00, "slippage_per_side_ticks": 0.50},
    "mnq_high": {"commission_round_trip_usd": 1.50, "slippage_per_side_ticks": 1.00},
}
LATENCY_GRID = [0, 100, 500, 1000]
ARM_GRID = [5, 10, 15]
TRIGGER_OFFSET_GRID = [0.5, 1.0, 1.5, 2.0, 3.0]
REFERENCE_GRID = ["bid_ask", "microprice", "mid"]
PROTECTION_GRID = [None, 0.5, 1.0, 1.5]
INSTRUMENT = "MNQ"
POINT_VALUE_USD = 2.0
TICK_VALUE_USD = 0.50
EXPECTED_ROWS = 90720
EXPECTED_HEATMAPS = 108
NS_PER_SECOND = 1_000_000_000
ROW_COLUMNS = [
    "pt_pts", "stop_pts", "cost_scenario", "latency_bucket_ms", "instrument",
    "arm_time_s", "trigger_offset_pts", "reference", "stop_limit_protection_pts",
    "n_events_total", "n_triggered_one_side", "n_triggered_both_sides",
    "n_triggered_neither", "p_triggered_one_side", "p_both_side_false_trigger",
    "p_pt_hit_before_stop", "p_stop_hit_before_pt", "p_time_stop",
    "p_stop_limit_miss", "expectancy_per_trade_usd", "expectancy_per_trade_pts",
    "trade_frequency_per_session", "expected_daily_pnl_usd",
]

@dataclass(frozen=True)
class TradeArrays:
    ts: np.ndarray
    price: np.ndarray

@dataclass(frozen=True)
class TriggerCell:
    session_date: str
    arm_time_s: int
    trigger_offset_pts: float
    reference: str
    stop_limit_protection_pts: float | None
    latency_bucket_ms: int
    outcome: str
    buy_triggered_ts_offset_ns: int | None
    sell_triggered_ts_offset_ns: int | None
    stop_limit_filled: bool | None
    stop_limit_fill_price_pts: float | None

@dataclass(frozen=True)
class PathSummary:
    outcome: str
    entry_side: str | None
    entry_ts_ns: int | None
    entry_price_pts: float | None
    stop_limit_miss: bool
    close_pnl_pts_at_300s: float | None
    exits: dict[tuple[float, float], str]


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    HEATMAP_DIR.mkdir(parents=True, exist_ok=True)
    verify_input_hashes()
    anchors = read_i0_anchors()
    trades_by_session = read_trade_arrays_by_session()
    triggered = read_triggered_events()
    summaries = [summarize_trigger(cell, anchors[cell.session_date], trades_by_session[cell.session_date]) for cell in triggered]
    rows = build_expectancy_rows(triggered, summaries)
    write_expectancy_table(rows)
    write_research_grid_manifest()
    write_heatmaps(rows)
    write_methodology()
    print(f"MOC-R4 wrote {len(rows)} expectancy rows and {EXPECTED_HEATMAPS} heatmaps under {OUTPUT_DIR}")
    return 0


def verify_input_hashes() -> None:
    expected_stream = EVENT_STREAM_ATTESTATION_PATH.read_text(encoding="utf-8").strip().split()[0]
    actual_stream = sha256(EVENT_STREAM_PATH)
    if expected_stream != EVENT_STREAM_SHA or actual_stream != expected_stream:
        raise AssertionError(f"event-stream SHA mismatch: {actual_stream} != {expected_stream}")
    actual_triggered = sha256(TRIGGERED_EVENTS_PATH)
    if actual_triggered != TRIGGERED_EVENTS_SHA:
        raise AssertionError(f"triggered-events SHA mismatch: {actual_triggered} != {TRIGGERED_EVENTS_SHA}")


def read_i0_anchors() -> dict[str, int]:
    manifest = json.loads(MANIFEST_INPUT_PATH.read_text(encoding="utf-8"))
    return {
        str(row["session_date"]): int(row["imbalance_anchor_ts_ns_i0"])
        for row in manifest["sessions"]
        if row["data_present"] is True and row["is_rth"] is True
    }


def read_triggered_events() -> list[TriggerCell]:
    rows = pq.read_table(TRIGGERED_EVENTS_PATH).to_pylist()
    output: list[TriggerCell] = []
    for row in rows:
        output.append(TriggerCell(
            session_date=str(row["session_date"]),
            arm_time_s=int(row["arm_time_s"]),
            trigger_offset_pts=float(row["trigger_offset_pts"]),
            reference=str(row["reference"]),
            stop_limit_protection_pts=None if row["stop_limit_protection_pts"] is None else float(row["stop_limit_protection_pts"]),
            latency_bucket_ms=int(row["latency_bucket_ms"]),
            outcome=str(row["outcome"]),
            buy_triggered_ts_offset_ns=None if row["buy_triggered_ts_offset_ns"] is None else int(row["buy_triggered_ts_offset_ns"]),
            sell_triggered_ts_offset_ns=None if row["sell_triggered_ts_offset_ns"] is None else int(row["sell_triggered_ts_offset_ns"]),
            stop_limit_filled=None if row["stop_limit_filled"] is None else bool(row["stop_limit_filled"]),
            stop_limit_fill_price_pts=None if row["stop_limit_fill_price_pts"] is None else float(row["stop_limit_fill_price_pts"]),
        ))
    return output


def read_trade_arrays_by_session() -> dict[str, TradeArrays]:
    table = pq.read_table(EVENT_STREAM_PATH, columns=["session_date", "ts_event_ns", "record_kind", "trade_price_pts"])
    grouped_ts: dict[str, list[int]] = defaultdict(list)
    grouped_price: dict[str, list[float]] = defaultdict(list)
    for row in table.to_pylist():
        if row["record_kind"] != "tbbo_trade":
            continue
        session = str(row["session_date"])
        grouped_ts[session].append(int(row["ts_event_ns"]))
        grouped_price[session].append(float(row["trade_price_pts"]))
    return {
        session: TradeArrays(np.array(grouped_ts[session], dtype=np.int64), np.array(grouped_price[session], dtype=np.float64))
        for session in grouped_ts
    }


def summarize_trigger(cell: TriggerCell, i0_ns: int, trades: TradeArrays) -> PathSummary:
    if cell.outcome == "neither":
        return empty_summary(cell.outcome, False)
    if cell.stop_limit_filled is False:
        return empty_summary(cell.outcome, True)
    if cell.stop_limit_fill_price_pts is None:
        return empty_summary(cell.outcome, False)
    candidates: list[tuple[int, str]] = []
    if cell.buy_triggered_ts_offset_ns is not None:
        candidates.append((cell.buy_triggered_ts_offset_ns, "buy"))
    if cell.sell_triggered_ts_offset_ns is not None:
        candidates.append((cell.sell_triggered_ts_offset_ns, "sell"))
    if not candidates:
        return empty_summary(cell.outcome, False)
    trigger_offset_ns, side = sorted(candidates, key=lambda item: (item[0], 0 if item[1] == "buy" else 1))[0]
    entry_ts_ns = i0_ns + trigger_offset_ns
    end_ts_ns = i0_ns + 300 * NS_PER_SECOND
    close_price = latest_price_at_or_before(trades, end_ts_ns)
    close_pnl = None if close_price is None else pnl_points(side, cell.stop_limit_fill_price_pts, close_price)
    exits = {
        (pt, stop): first_touch_outcome(trades, side, entry_ts_ns, end_ts_ns, cell.stop_limit_fill_price_pts, pt, stop)
        for pt in PT_GRID
        for stop in STOP_GRID
    }
    return PathSummary(cell.outcome, side, entry_ts_ns, cell.stop_limit_fill_price_pts, False, close_pnl, exits)


def empty_summary(outcome: str, miss: bool) -> PathSummary:
    return PathSummary(outcome, None, None, None, miss, None, {(pt, stop): "none" for pt in PT_GRID for stop in STOP_GRID})


def first_touch_outcome(
    trades: TradeArrays,
    side: str,
    entry_ts_ns: int,
    end_ts_ns: int,
    entry_price: float,
    pt: float,
    stop: float,
) -> str:
    start = int(np.searchsorted(trades.ts, entry_ts_ns, side="left"))
    end = int(np.searchsorted(trades.ts, end_ts_ns, side="right"))
    if start >= end:
        return "time"
    prices = trades.price[start:end]
    if side == "buy":
        pt_hits = np.flatnonzero(prices >= entry_price + pt)
        stop_hits = np.flatnonzero(prices <= entry_price - stop)
    else:
        pt_hits = np.flatnonzero(prices <= entry_price - pt)
        stop_hits = np.flatnonzero(prices >= entry_price + stop)
    first_pt = None if pt_hits.size == 0 else int(pt_hits[0])
    first_stop = None if stop_hits.size == 0 else int(stop_hits[0])
    if first_pt is None and first_stop is None:
        return "time"
    if first_pt is None:
        return "stop"
    if first_stop is None:
        return "pt"
    return "stop" if first_stop <= first_pt else "pt"


def build_expectancy_rows(triggered: list[TriggerCell], summaries: list[PathSummary]) -> list[dict[str, Any]]:
    grouped: dict[tuple[Any, ...], list[PathSummary]] = defaultdict(list)
    for cell, summary in zip(triggered, summaries, strict=True):
        grouped[(cell.latency_bucket_ms, cell.arm_time_s, cell.trigger_offset_pts, cell.reference, cell.stop_limit_protection_pts)].append(summary)
    rows: list[dict[str, Any]] = []
    for pt in PT_GRID:
        for stop in STOP_GRID:
            for cost_name, cost in COST_SCENARIOS.items():
                for latency in LATENCY_GRID:
                    for arm in ARM_GRID:
                        for offset in TRIGGER_OFFSET_GRID:
                            for reference in REFERENCE_GRID:
                                for protection in PROTECTION_GRID:
                                    rows.append(compute_row(pt, stop, cost_name, cost, latency, arm, offset, reference, protection, grouped[(latency, arm, offset, reference, protection)]))
    if len(rows) != EXPECTED_ROWS:
        raise AssertionError(f"expected {EXPECTED_ROWS} rows, got {len(rows)}")
    return sorted(rows, key=expectancy_sort_key)


def expectancy_sort_key(row: dict[str, Any]) -> tuple[Any, ...]:
    protection = row["stop_limit_protection_pts"]
    return (
        row["pt_pts"], row["stop_pts"], row["cost_scenario"], row["latency_bucket_ms"],
        row["instrument"], row["arm_time_s"], row["trigger_offset_pts"], row["reference"],
        -1.0 if protection is None else protection,
    )


def compute_row(pt: float, stop: float, cost_name: str, cost: dict[str, float], latency: int, arm: int, offset: float, reference: str, protection: float | None, summaries: list[PathSummary]) -> dict[str, Any]:
    total = len(summaries)
    one_side = sum(1 for summary in summaries if summary.outcome in {"buy_only", "sell_only"})
    both_sides = sum(1 for summary in summaries if summary.outcome == "both_sides")
    neither = sum(1 for summary in summaries if summary.outcome == "neither")
    misses = sum(1 for summary in summaries if summary.stop_limit_miss)
    pt_hits = sum(1 for summary in summaries if summary.exits[(pt, stop)] == "pt")
    stop_hits = sum(1 for summary in summaries if summary.exits[(pt, stop)] == "stop")
    time_summaries = [summary for summary in summaries if summary.exits[(pt, stop)] == "time"]
    time_stops = len(time_summaries)
    avg_time_close = sum(summary.close_pnl_pts_at_300s or 0.0 for summary in time_summaries) / time_stops if time_stops else 0.0
    p_pt = pt_hits / total
    p_stop = stop_hits / total
    p_time = time_stops / total
    expectancy_pts = p_pt * pt + p_stop * (-stop) + p_time * avg_time_close
    round_trip_cost_usd = cost["commission_round_trip_usd"] + cost["slippage_per_side_ticks"] * 2 * TICK_VALUE_USD
    expectancy_usd = expectancy_pts * POINT_VALUE_USD - round_trip_cost_usd
    frequency = one_side / 30
    return {
        "pt_pts": fp(pt),
        "stop_pts": fp(stop),
        "cost_scenario": cost_name,
        "latency_bucket_ms": latency,
        "instrument": INSTRUMENT,
        "arm_time_s": arm,
        "trigger_offset_pts": fp(offset),
        "reference": reference,
        "stop_limit_protection_pts": None if protection is None else fp(protection),
        "n_events_total": total,
        "n_triggered_one_side": one_side,
        "n_triggered_both_sides": both_sides,
        "n_triggered_neither": neither,
        "p_triggered_one_side": fp(one_side / total),
        "p_both_side_false_trigger": fp(both_sides / total),
        "p_pt_hit_before_stop": fp(p_pt),
        "p_stop_hit_before_pt": fp(p_stop),
        "p_time_stop": fp(p_time),
        "p_stop_limit_miss": fp(misses / total),
        "expectancy_per_trade_usd": fp(expectancy_usd),
        "expectancy_per_trade_pts": fp(expectancy_pts),
        "trade_frequency_per_session": fp(frequency),
        "expected_daily_pnl_usd": fp(expectancy_usd * frequency),
    }


def latest_price_at_or_before(trades: TradeArrays, ts_ns: int) -> float | None:
    idx = int(np.searchsorted(trades.ts, ts_ns, side="right")) - 1
    return None if idx < 0 else float(trades.price[idx])


def pnl_points(side: str, entry: float, exit_price: float) -> float:
    return exit_price - entry if side == "buy" else entry - exit_price


def write_expectancy_table(rows: list[dict[str, Any]]) -> None:
    frame = pd.DataFrame(rows, columns=ROW_COLUMNS)
    schema = pa.schema([
        ("pt_pts", pa.float64()), ("stop_pts", pa.float64()), ("cost_scenario", pa.string()),
        ("latency_bucket_ms", pa.int32()), ("instrument", pa.string()), ("arm_time_s", pa.int32()),
        ("trigger_offset_pts", pa.float64()), ("reference", pa.string()),
        ("stop_limit_protection_pts", pa.float64()), ("n_events_total", pa.int32()),
        ("n_triggered_one_side", pa.int32()), ("n_triggered_both_sides", pa.int32()),
        ("n_triggered_neither", pa.int32()), ("p_triggered_one_side", pa.float64()),
        ("p_both_side_false_trigger", pa.float64()), ("p_pt_hit_before_stop", pa.float64()),
        ("p_stop_hit_before_pt", pa.float64()), ("p_time_stop", pa.float64()),
        ("p_stop_limit_miss", pa.float64()), ("expectancy_per_trade_usd", pa.float64()),
        ("expectancy_per_trade_pts", pa.float64()), ("trade_frequency_per_session", pa.float64()),
        ("expected_daily_pnl_usd", pa.float64()),
    ])
    table = pa.Table.from_pandas(frame, schema=schema, preserve_index=False)
    metadata = {
        b"moc_ticket": b"MOC-R4",
        b"generated_at_note": b"Deterministic MOC-R4 parquet; no wall-clock timestamp emitted.",
        b"triggered_events_sha256": TRIGGERED_EVENTS_SHA.encode("ascii"),
        b"event_stream_sha256": EVENT_STREAM_SHA.encode("ascii"),
    }
    pq.write_table(table.replace_schema_metadata(metadata), EXPECTANCY_TABLE_PATH, compression="snappy", version="2.6", use_dictionary=False)


def write_research_grid_manifest() -> None:
    manifest = {
        "schema_version": 1,
        "generated_at_note": "Deterministic MOC-R4 manifest; no wall-clock timestamp emitted.",
        "trigger_cells": {"arm_time_s": 3, "trigger_offset_pts": 5, "reference": 3, "stop_limit_protection_pts": 4, "latency_bucket_ms": 4, "subtotal": 720},
        "exit_cells": {"pt_pts": 7, "stop_pts": 6, "subtotal": 42},
        "cost_cells": 3,
        "conditioning_cells_max": "from R5 stratifications; placeholder documenting future R5 expansion",
        "total_screened_cells_max": 90720,
        "primary_selection_metric": "expected_daily_pnl_usd",
        "multiple_testing_control": {"deflated_stat_correction": True, "fold_count": 6, "method": "nested_walk_forward_plus_SPA_or_reality_check"},
        "scope_decision": "MNQ-only cost scenarios; nq_low/mid/high deferred to MOC-R4-NQ after QFA-119f.",
        "notes": "research_grid total_screened_cells is NOT QFA-611 Cycle3 effective_trial_count. Production trial count is 1 or 2; DSR / SPA / Reality-Check applies to research screening only.",
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_heatmaps(rows: list[dict[str, Any]]) -> None:
    for old in HEATMAP_DIR.glob("*.png"):
        old.unlink()
    frame = pd.DataFrame(rows)
    plt.rcParams.update({"figure.dpi": 100, "savefig.dpi": 100, "font.family": "DejaVu Sans", "axes.titlesize": 9, "axes.labelsize": 8, "xtick.labelsize": 7, "ytick.labelsize": 7})
    global_min = float(frame["expectancy_per_trade_usd"].min())
    global_max = float(frame["expectancy_per_trade_usd"].max())
    for cost in COST_SCENARIOS:
        for latency in LATENCY_GRID:
            for arm in ARM_GRID:
                for reference in REFERENCE_GRID:
                    subset = frame[(frame.cost_scenario == cost) & (frame.latency_bucket_ms == latency) & (frame.arm_time_s == arm) & (frame.reference == reference)]
                    matrix: list[list[float]] = []
                    mask: list[list[bool]] = []
                    for stop in STOP_GRID:
                        values: list[float] = []
                        masks: list[bool] = []
                        for pt in PT_GRID:
                            cell = subset[(subset.pt_pts == pt) & (subset.stop_pts == stop)]
                            best = cell.sort_values("expected_daily_pnl_usd", ascending=False).iloc[0]
                            values.append(float(best.expectancy_per_trade_usd))
                            masks.append(int(best.n_events_total) < 20)
                        matrix.append(values)
                        mask.append(masks)
                    fig, ax = plt.subplots(figsize=(7, 4.8), constrained_layout=True)
                    image = ax.imshow(matrix, cmap="RdYlGn", vmin=global_min, vmax=global_max, aspect="auto")
                    for y, row in enumerate(matrix):
                        for x, value in enumerate(row):
                            if mask[y][x]:
                                ax.add_patch(plt.Rectangle((x - 0.5, y - 0.5), 1, 1, color="#808080", alpha=0.55))
                            ax.text(x, y, f"{value:.2f}", ha="center", va="center", fontsize=6, color="black")
                    ax.set_xticks(range(len(PT_GRID)), [str(value) for value in PT_GRID])
                    ax.set_yticks(range(len(STOP_GRID)), [str(value) for value in STOP_GRID])
                    ax.set_xlabel("pt_pts")
                    ax.set_ylabel("stop_pts")
                    ax.set_title(f"{cost} latency={latency}ms arm={arm}s ref={reference}")
                    fig.colorbar(image, ax=ax, label="expectancy_per_trade_usd")
                    fig.savefig(HEATMAP_DIR / f"{cost}__lat{latency}__arm{arm}__ref_{reference}.png", metadata={"Software": "MOC-R4 deterministic matplotlib"})
                    plt.close(fig)
    count = len(list(HEATMAP_DIR.glob("*.png")))
    if count != EXPECTED_HEATMAPS:
        raise AssertionError(f"expected {EXPECTED_HEATMAPS} heatmaps, wrote {count}")


def write_methodology() -> None:
    METHODOLOGY_PATH.write_text("""# MOC-R4 expectancy-table methodology

MOC-R4 consumes R3 `triggered-events.parquet` and the locally regenerated R2
`event-stream.parquet`. Inputs are verified against their SHA attestations:
R3 `7da601066b958e484238a7fe767f6aead80df83ea38d54bbba1616b6b5dead3f`; R2
`f9effd810b609c03394e96c69e473e9d388eec82accdcbf8975494a307c330cb`.

Scope is MNQ-only: `mnq_low`, `mnq_mid`, and `mnq_high`. `nq_*` cost scenarios
are deferred to MOC-R4-NQ after QFA-119f supplies the NQ corpus. The emitted
research-grid manifest records `cost_cells=3` and `total_screened_cells_max=90,720`.

For R3 `outcome=both_sides`, R4 follows the MOC-R3 carry-forward: the
first-touch walk starts from the earliest trigger side. Aggregate both-fill cost
modeling is out of scope because Plan A R4 has singular fill/excursion fields.

Expectancy formula per row: `p_pt*pt_pts + p_stop*(-stop_pts) +
p_time*avg_close_pnl_at_300s`, converted to USD using MNQ point value $2.00,
then subtracting commission and two-sided slippage cost. `expected_daily_pnl_usd`
multiplies per-trade expectancy by `n_triggered_one_side / 30`.

Heatmaps fix `(cost_scenario, latency_bucket_ms, instrument, arm_time_s,
reference)`. The projection over `(trigger_offset_pts, stop_limit_protection)`
chooses the row with best `expected_daily_pnl_usd` for each `(pt_pts, stop_pts)`
cell. This best-of projection matches R4's screening purpose and is not a
production selection rule.

Matplotlib uses Agg, fixed figsize/DPI/font/cmap normalization, and explicit PNG
metadata. Parquet and JSON outputs carry deterministic no-wall-clock metadata;
PNG byte-equality is checked and documented in the PR test plan.
""", encoding="utf-8")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fp(value: float) -> float:
    return round(float(value), 10)


if __name__ == "__main__":
    raise SystemExit(main())
