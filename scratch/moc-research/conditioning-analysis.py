#!/usr/bin/env python3
"""Build MOC-R5 conditioning tables and top-10 summary."""

from __future__ import annotations

import hashlib
import json
import math
import os
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

REPO_ROOT = Path(__file__).resolve().parents[2]
MOC_ROOT = REPO_ROOT / "scratch/moc-research"
OUTPUT_DIR = Path(os.environ.get("MOC_R5_OUTPUT_DIR", str(MOC_ROOT)))
EVENT_STREAM_PATH = MOC_ROOT / "event-stream.parquet"
EVENT_STREAM_ATTESTATION_PATH = MOC_ROOT / "event-stream.sha256.txt"
TRIGGERED_EVENTS_PATH = MOC_ROOT / "triggered-events.parquet"
EXPECTANCY_TABLE_PATH = MOC_ROOT / "expectancy-tables.parquet"
EVENT_AGGREGATES_PATH = MOC_ROOT / "event-aggregates.parquet"
MANIFEST_INPUT_PATH = MOC_ROOT / "event-day-manifest.json"
CONDITIONING_TABLE_PATH = OUTPUT_DIR / "conditioning-tables.parquet"
SUMMARY_PATH = OUTPUT_DIR / "conditioning-summary.md"

EVENT_STREAM_SHA = "f9effd810b609c03394e96c69e473e9d388eec82accdcbf8975494a307c330cb"
TRIGGERED_EVENTS_SHA = "7da601066b958e484238a7fe767f6aead80df83ea38d54bbba1616b6b5dead3f"
EXPECTANCY_TABLE_SHA = "4341c862047b23414218c92ce56c9ae299f6cef496de304aa767feedd87b75cd"

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
NS_PER_SECOND = 1_000_000_000
R4_ROWS_PER_BUCKET = 90720
MIN_EVENTS = 20

R4_COLUMNS = [
    "pt_pts", "stop_pts", "cost_scenario", "latency_bucket_ms", "instrument",
    "arm_time_s", "trigger_offset_pts", "reference", "stop_limit_protection_pts",
    "n_events_total", "n_triggered_one_side", "n_triggered_both_sides",
    "n_triggered_neither", "p_triggered_one_side", "p_both_side_false_trigger",
    "p_pt_hit_before_stop", "p_stop_hit_before_pt", "p_time_stop",
    "p_stop_limit_miss", "expectancy_per_trade_usd", "expectancy_per_trade_pts",
    "trade_frequency_per_session", "expected_daily_pnl_usd",
]
ROW_COLUMNS = ["stratification_dimension", "stratification_bucket", *R4_COLUMNS]
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
BUCKET_ORDER = {
    "vix_quartile": ["Q1_low", "Q2", "Q3", "Q4_high"],
    "regime_label": ["high", "mid", "low", "transition_pending"],
    "day_of_week": ["Mon", "Tue", "Wed", "Thu", "Fri"],
    "is_roll_week": ["true", "false"],
    "is_macro_day": ["true", "false"],
    "pre_event_spread_ticks_t_minus_10s": ["1", "2", ">=3"],
    "pre_event_imbalance_t_minus_10s": ["strong_bid", "neutral", "strong_ask"],
    "pre_event_volume_z_score": ["low", "normal", "high"],
}


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
    session_date: str
    outcome: str
    entry_side: str | None
    entry_ts_ns: int | None
    entry_price_pts: float | None
    stop_limit_miss: bool
    close_pnl_pts_at_300s: float | None
    exits: dict[tuple[float, float], str]


@dataclass(frozen=True)
class BuildStats:
    observed_bucket_counts: dict[str, dict[str, int]]
    surviving_bucket_counts: dict[str, dict[str, int]]
    no_surviving_dimensions: list[str]
    filtered_tuple_count: int
    emitted_tuple_count: int
    input_hashes: dict[str, str]


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    input_hashes = verify_input_hashes()
    anchors = read_i0_anchors()
    session_buckets = build_session_buckets()
    trades_by_session = read_trade_arrays_by_session()
    triggered = read_triggered_events()
    summaries = [
        summarize_trigger(cell, anchors[cell.session_date], trades_by_session[cell.session_date])
        for cell in triggered
    ]
    rows, stats = build_conditioning_rows(triggered, summaries, session_buckets, input_hashes)
    write_conditioning_table(rows, input_hashes)
    write_summary(rows, stats)
    print(
        f"MOC-R5 wrote {len(rows)} conditioning rows; "
        f"filtered {stats.filtered_tuple_count} n<20 tuples under {OUTPUT_DIR}"
    )
    return 0


def verify_input_hashes() -> dict[str, str]:
    expected_stream = EVENT_STREAM_ATTESTATION_PATH.read_text(encoding="utf-8").strip().split()[0]
    input_hashes = {
        "event_stream": sha256(EVENT_STREAM_PATH),
        "triggered_events": sha256(TRIGGERED_EVENTS_PATH),
        "expectancy_tables": sha256(EXPECTANCY_TABLE_PATH),
        "event_aggregates": sha256(EVENT_AGGREGATES_PATH),
        "event_day_manifest": sha256(MANIFEST_INPUT_PATH),
    }
    if expected_stream != EVENT_STREAM_SHA or input_hashes["event_stream"] != expected_stream:
        raise AssertionError(f"event-stream SHA mismatch: {input_hashes['event_stream']} != {expected_stream}")
    if input_hashes["triggered_events"] != TRIGGERED_EVENTS_SHA:
        raise AssertionError("triggered-events SHA mismatch")
    if input_hashes["expectancy_tables"] != EXPECTANCY_TABLE_SHA:
        raise AssertionError("expectancy-tables SHA mismatch")
    return input_hashes


def read_i0_anchors() -> dict[str, int]:
    manifest = json.loads(MANIFEST_INPUT_PATH.read_text(encoding="utf-8"))
    return {
        str(row["session_date"]): int(row["imbalance_anchor_ts_ns_i0"])
        for row in manifest["sessions"]
        if row["data_present"] is True and row["is_rth"] is True
    }


def build_session_buckets() -> dict[str, dict[str, str]]:
    manifest = json.loads(MANIFEST_INPUT_PATH.read_text(encoding="utf-8"))
    session_rows = {
        str(row["session_date"]): row
        for row in manifest["sessions"]
        if row["data_present"] is True and row["is_rth"] is True
    }
    aggregate_rows = {
        str(row["session_date"]): row
        for row in pq.read_table(EVENT_AGGREGATES_PATH).to_pylist()
    }
    output: dict[str, dict[str, str]] = {}
    for session, row in session_rows.items():
        agg = aggregate_rows[session]
        buckets: dict[str, str] = {
            "vix_quartile": str(row["vix_quartile"]),
            "regime_label": str(row["regime_label"]),
            "day_of_week": str(row["day_of_week"]),
            "is_roll_week": bool_bucket(row["is_roll_week"]),
            "is_macro_day": bool_bucket(row["is_macro_day"]),
            "calendar_combinatorial": calendar_combo(row),
            "pre_event_spread_ticks_t_minus_10s": spread_bucket(int(agg["pre_event_spread_ticks_t_minus_10s"])),
            "pre_event_imbalance_t_minus_10s": imbalance_bucket(float(agg["pre_event_imbalance_t_minus_10s"])),
        }
        volume_z = agg["pre_event_volume_z_score"]
        if volume_z is not None and not (isinstance(volume_z, float) and math.isnan(volume_z)):
            buckets["pre_event_volume_z_score"] = volume_bucket(float(volume_z))
        output[session] = buckets
    return output


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
        return empty_summary(cell.session_date, cell.outcome, False)
    if cell.stop_limit_filled is False:
        return empty_summary(cell.session_date, cell.outcome, True)
    if cell.stop_limit_fill_price_pts is None:
        return empty_summary(cell.session_date, cell.outcome, False)
    candidates: list[tuple[int, str]] = []
    if cell.buy_triggered_ts_offset_ns is not None:
        candidates.append((cell.buy_triggered_ts_offset_ns, "buy"))
    if cell.sell_triggered_ts_offset_ns is not None:
        candidates.append((cell.sell_triggered_ts_offset_ns, "sell"))
    if not candidates:
        return empty_summary(cell.session_date, cell.outcome, False)
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
    return PathSummary(cell.session_date, cell.outcome, side, entry_ts_ns, cell.stop_limit_fill_price_pts, False, close_pnl, exits)


def empty_summary(session_date: str, outcome: str, miss: bool) -> PathSummary:
    return PathSummary(session_date, outcome, None, None, None, miss, None, {(pt, stop): "none" for pt in PT_GRID for stop in STOP_GRID})


def first_touch_outcome(trades: TradeArrays, side: str, entry_ts_ns: int, end_ts_ns: int, entry_price: float, pt: float, stop: float) -> str:
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


def build_conditioning_rows(
    triggered: list[TriggerCell],
    summaries: list[PathSummary],
    session_buckets: dict[str, dict[str, str]],
    input_hashes: dict[str, str],
) -> tuple[list[dict[str, Any]], BuildStats]:
    observed: dict[str, dict[str, set[str]]] = {dimension: defaultdict(set) for dimension in DIMENSION_ORDER}
    for session, buckets in session_buckets.items():
        for dimension, bucket in buckets.items():
            observed[dimension][bucket].add(session)

    rows: list[dict[str, Any]] = []
    filtered_tuple_count = 0
    surviving_bucket_counts: dict[str, dict[str, int]] = {dimension: {} for dimension in DIMENSION_ORDER}
    no_surviving_dimensions: list[str] = []
    observed_counts: dict[str, dict[str, int]] = {
        dimension: {bucket: len(sessions) for bucket, sessions in sorted_bucket_items(dimension, bucket_map)}
        for dimension, bucket_map in observed.items()
    }
    pairs = list(zip(triggered, summaries, strict=True))
    for dimension in DIMENSION_ORDER:
        dimension_emitted = False
        for bucket, sessions in sorted_bucket_items(dimension, observed[dimension]):
            selected_sessions = set(sessions)
            if len(selected_sessions) < MIN_EVENTS:
                filtered_tuple_count += R4_ROWS_PER_BUCKET
                continue
            grouped: dict[tuple[Any, ...], list[PathSummary]] = defaultdict(list)
            for cell, summary in pairs:
                if cell.session_date in selected_sessions:
                    grouped[(cell.latency_bucket_ms, cell.arm_time_s, cell.trigger_offset_pts, cell.reference, cell.stop_limit_protection_pts)].append(summary)
            before = len(rows)
            rows.extend(build_rows_for_bucket(dimension, bucket, grouped))
            emitted = len(rows) - before
            if emitted:
                dimension_emitted = True
                surviving_bucket_counts[dimension][bucket] = len(selected_sessions)
        if not dimension_emitted:
            no_surviving_dimensions.append(dimension)
    rows = sorted(rows, key=conditioning_sort_key)
    stats = BuildStats(observed_counts, surviving_bucket_counts, no_surviving_dimensions, filtered_tuple_count, len(rows), input_hashes)
    return rows, stats


def build_rows_for_bucket(dimension: str, bucket: str, grouped: dict[tuple[Any, ...], list[PathSummary]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for pt in PT_GRID:
        for stop in STOP_GRID:
            for cost_name, cost in COST_SCENARIOS.items():
                for latency in LATENCY_GRID:
                    for arm in ARM_GRID:
                        for offset in TRIGGER_OFFSET_GRID:
                            for reference in REFERENCE_GRID:
                                for protection in PROTECTION_GRID:
                                    summaries = grouped[(latency, arm, offset, reference, protection)]
                                    if len(summaries) < MIN_EVENTS:
                                        continue
                                    base = compute_row(pt, stop, cost_name, cost, latency, arm, offset, reference, protection, summaries)
                                    rows.append({"stratification_dimension": dimension, "stratification_bucket": bucket, **base})
    return rows


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


def write_conditioning_table(rows: list[dict[str, Any]], input_hashes: dict[str, str]) -> None:
    frame = pd.DataFrame(rows, columns=ROW_COLUMNS)
    schema = pa.schema([
        ("stratification_dimension", pa.string()), ("stratification_bucket", pa.string()),
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
        b"moc_ticket": b"MOC-R5",
        b"generated_at_note": b"Deterministic MOC-R5 parquet; no wall-clock timestamp emitted.",
        b"expectancy_tables_sha256": input_hashes["expectancy_tables"].encode("ascii"),
        b"triggered_events_sha256": input_hashes["triggered_events"].encode("ascii"),
        b"event_stream_sha256": input_hashes["event_stream"].encode("ascii"),
        b"event_aggregates_sha256": input_hashes["event_aggregates"].encode("ascii"),
        b"event_day_manifest_sha256": input_hashes["event_day_manifest"].encode("ascii"),
    }
    pq.write_table(table.replace_schema_metadata(metadata), CONDITIONING_TABLE_PATH, compression="snappy", version="2.6", use_dictionary=False)


def write_summary(rows: list[dict[str, Any]], stats: BuildStats) -> None:
    top10 = sorted(rows, key=top10_sort_key)[:10]
    observed_lines = []
    for dimension in DIMENSION_ORDER:
        bucket_text = ", ".join(f"{bucket}:{count}" for bucket, count in stats.observed_bucket_counts.get(dimension, {}).items()) or "none"
        observed_lines.append(f"- {dimension}: {bucket_text}")
    surviving_lines = []
    for dimension in DIMENSION_ORDER:
        bucket_text = ", ".join(f"{bucket}:{count}" for bucket, count in stats.surviving_bucket_counts.get(dimension, {}).items()) or "none"
        surviving_lines.append(f"- {dimension}: {bucket_text}")
    top_lines = [
        "| rank | dimension | bucket | pt | stop | cost | latency | arm | offset | ref | protection | n | expected_daily_pnl_usd | p_pt | p_stop |",
        "|---:|---|---|---:|---:|---|---:|---:|---:|---|---|---:|---:|---:|---:|",
    ]
    for idx, row in enumerate(top10, start=1):
        protection = "null" if row["stop_limit_protection_pts"] is None else str(row["stop_limit_protection_pts"])
        top_lines.append(
            f"| {idx} | {row['stratification_dimension']} | {row['stratification_bucket']} | "
            f"{row['pt_pts']} | {row['stop_pts']} | {row['cost_scenario']} | {row['latency_bucket_ms']} | "
            f"{row['arm_time_s']} | {row['trigger_offset_pts']} | {row['reference']} | {protection} | "
            f"{row['n_events_total']} | {row['expected_daily_pnl_usd']:.10f} | "
            f"{row['p_pt_hit_before_stop']:.10f} | {row['p_stop_hit_before_pt']:.10f} |"
        )
    no_surviving = ", ".join(stats.no_surviving_dimensions) or "none"
    text = f"""# MOC-R5 conditioning summary

MOC-R5 recomputes R4 expectancy on bucket-restricted event subsets. It does not
filter R4's aggregate table directly; it joins R3 trigger cells to R1 calendar
attributes and R2 pre-event aggregates, then reruns the R4 first-touch math per
(stratification_dimension, stratification_bucket) subset.

Input SHAs: R4 expectancy `{stats.input_hashes['expectancy_tables']}`; R3
triggered `{stats.input_hashes['triggered_events']}`; R2 event-stream
`{stats.input_hashes['event_stream']}`; R2 event-aggregates
`{stats.input_hashes['event_aggregates']}`; R1 manifest
`{stats.input_hashes['event_day_manifest']}`.

Both-sides carry-forward: rows with R3 `outcome=both_sides` use the earliest
trigger side for first-touch, matching MOC-R3 and MOC-R4 methodology.

Calendar combinatorial buckets use observed combinations only, encoded as
`is_friday=<bool>|is_month_end=<bool>|is_quarter_end=<bool>|is_triple_witching=<bool>`.
No Cartesian product of unobserved combinations is emitted.

Observed bucket session counts:
{chr(10).join(observed_lines)}

Surviving buckets after n<20 filter:
{chr(10).join(surviving_lines)}

No surviving rows: {no_surviving}. Filtered tuple count: {stats.filtered_tuple_count}.
Emitted row count: {stats.emitted_tuple_count}. Every emitted row has n_events_total >= 20.

## Top 10 by expected_daily_pnl_usd

{chr(10).join(top_lines)}
"""
    SUMMARY_PATH.write_text(text, encoding="utf-8", newline="\n")


def top10_sort_key(row: dict[str, Any]) -> tuple[Any, ...]:
    return (-float(row["expected_daily_pnl_usd"]), conditioning_sort_key(row))


def conditioning_sort_key(row: dict[str, Any]) -> tuple[Any, ...]:
    protection = row["stop_limit_protection_pts"]
    return (
        row["stratification_dimension"], row["stratification_bucket"], row["pt_pts"], row["stop_pts"],
        row["cost_scenario"], row["latency_bucket_ms"], row["arm_time_s"], row["trigger_offset_pts"],
        row["reference"], -1.0 if protection is None else protection, row["instrument"],
    )


def sorted_bucket_items(dimension: str, bucket_map: dict[str, Any]) -> list[tuple[str, Any]]:
    order = BUCKET_ORDER.get(dimension)
    if order is None:
        return sorted(bucket_map.items())
    rank = {bucket: idx for idx, bucket in enumerate(order)}
    return sorted(bucket_map.items(), key=lambda item: (rank.get(item[0], 999), item[0]))


def bool_bucket(value: Any) -> str:
    return "true" if bool(value) else "false"


def calendar_combo(row: dict[str, Any]) -> str:
    return "|".join([
        f"is_friday={bool_bucket(row['is_friday'])}",
        f"is_month_end={bool_bucket(row['is_month_end'])}",
        f"is_quarter_end={bool_bucket(row['is_quarter_end'])}",
        f"is_triple_witching={bool_bucket(row['is_triple_witching'])}",
    ])


def spread_bucket(value: int) -> str:
    if value <= 1:
        return "1"
    if value == 2:
        return "2"
    return ">=3"


def imbalance_bucket(value: float) -> str:
    if value < -0.3:
        return "strong_bid"
    if value > 0.3:
        return "strong_ask"
    return "neutral"


def volume_bucket(value: float) -> str:
    if value < -1:
        return "low"
    if value > 1:
        return "high"
    return "normal"


def latest_price_at_or_before(trades: TradeArrays, ts_ns: int) -> float | None:
    idx = int(np.searchsorted(trades.ts, ts_ns, side="right")) - 1
    return None if idx < 0 else float(trades.price[idx])


def pnl_points(side: str, entry: float, exit_price: float) -> float:
    return exit_price - entry if side == "buy" else entry - exit_price


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fp(value: float) -> float:
    return round(float(value), 10)


if __name__ == "__main__":
    raise SystemExit(main())
