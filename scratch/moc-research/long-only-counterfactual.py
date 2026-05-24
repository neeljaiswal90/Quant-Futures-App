from __future__ import annotations

import dataclasses
import hashlib
import importlib.util
import json
import math
import os
import sys
from collections import Counter
from pathlib import Path
from statistics import NormalDist
from typing import Any

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT / "scratch" / "moc-research"
OUT_DIR = Path(os.environ.get("MOC_LO_OUTPUT_DIR", SRC_DIR)).resolve()
OUT_DIR.mkdir(parents=True, exist_ok=True)

TRIGGERED_PATH = SRC_DIR / "triggered-events.parquet"
EXPECTANCY_PATH = SRC_DIR / "expectancy-tables.parquet"
EVENT_STREAM_PATH = SRC_DIR / "event-stream.parquet"
EVENT_STREAM_SHA_PATH = SRC_DIR / "event-stream.sha256.txt"
MANIFEST_PATH = SRC_DIR / "event-day-manifest.json"
R7_REPORT_PATH = ROOT / "docs" / "research" / "moc-family-a-descriptive-report.md"
GRID_MANIFEST_PATH = SRC_DIR / "research-grid-manifest.json"
OUTPUT_PARQUET = OUT_DIR / "long-only-counterfactual.parquet"
OUTPUT_MEMO = OUT_DIR / "long-only-vs-bilateral-comparison.md"

PT_GRID = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0]
STOP_GRID = [1.0, 1.5, 2.0, 2.5, 3.0, 4.0]
COST_SCENARIOS = {
    "mnq_low": {"commission_round_trip_usd": 0.60, "slippage_per_side_ticks": 0.25},
    "mnq_mid": {"commission_round_trip_usd": 1.00, "slippage_per_side_ticks": 0.50},
    "mnq_high": {"commission_round_trip_usd": 1.50, "slippage_per_side_ticks": 1.00},
}
COST_ORDER = {name: idx for idx, name in enumerate(COST_SCENARIOS)}
REFERENCE_GRID = ["bid_ask", "microprice", "mid"]
REFERENCE_ORDER = {name: idx for idx, name in enumerate(REFERENCE_GRID)}
PROTECTION_ORDER = {"null": 0, "0.5": 1, "1.0": 2, "1.5": 3}
EXPECTED_ROWS = 90_720
SESSION_COUNT = 30
POINT_VALUE_USD = 2.00
TICK_VALUE_USD = 0.50
CANCEL_AFTER_NS = 300_000_000_000
BOOTSTRAP_REPLICATIONS = 10_000
BOOTSTRAP_SEED = int(
    hashlib.sha256(b"MOC-LO-COUNTERFACTUAL:bootstrap:sim03_corpus:2026-03-16:2026-04-27").hexdigest()[:8],
    16,
)

R4_COLUMNS = [
    "pt_pts",
    "stop_pts",
    "cost_scenario",
    "latency_bucket_ms",
    "instrument",
    "arm_time_s",
    "trigger_offset_pts",
    "reference",
    "stop_limit_protection_pts",
    "n_events_total",
    "n_triggered_one_side",
    "n_triggered_both_sides",
    "n_triggered_neither",
    "p_triggered_one_side",
    "p_both_side_false_trigger",
    "p_pt_hit_before_stop",
    "p_stop_hit_before_pt",
    "p_time_stop",
    "p_stop_limit_miss",
    "expectancy_per_trade_usd",
    "expectancy_per_trade_pts",
    "trade_frequency_per_session",
    "expected_daily_pnl_usd",
]
OUTPUT_COLUMNS = R4_COLUMNS + ["n_long_entered", "p_long_entered", "exit_reason_share"]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def stable(value: float | int | None, digits: int = 10) -> float | None:
    if value is None:
        return None
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return round(float(value), digits)


def protection_label(value: Any) -> str:
    if value is None or pd.isna(value):
        return "null"
    return f"{float(value):.1f}"


def protection_value(label: str) -> float | None:
    return None if label == "null" else float(label)


def maybe_int(value: Any) -> int | None:
    if value is None or pd.isna(value):
        return None
    return int(value)


def load_stats_modules() -> tuple[Any, Any]:
    lib_dir = ROOT / "scripts" / "strategy-selection" / "_lib"
    sys.path.insert(0, str(lib_dir))
    try:
        loaded: dict[str, Any] = {}
        for name, rel in [
            ("block_bootstrap", "scripts/strategy-selection/_lib/block_bootstrap.py"),
            ("psr_dsr", "scripts/strategy-selection/_lib/psr_dsr.py"),
        ]:
            spec = importlib.util.spec_from_file_location(name, ROOT / rel)
            if spec is None or spec.loader is None:
                raise RuntimeError(f"unable to load {rel}")
            mod = importlib.util.module_from_spec(spec)
            sys.modules[name] = mod
            spec.loader.exec_module(mod)
            loaded[name] = mod
        return loaded["block_bootstrap"], loaded["psr_dsr"]
    finally:
        if str(lib_dir) in sys.path:
            sys.path.remove(str(lib_dir))


def load_i0_by_session() -> dict[str, int]:
    payload = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return {
        str(row["session_date"]): int(row["i0_ts_ns"])
        for row in payload["sessions"]
        if row.get("data_present")
    }


def read_trade_paths() -> dict[str, dict[str, np.ndarray]]:
    schema_names = set(pq.read_schema(EVENT_STREAM_PATH).names)
    cols = ["session_date", "ts_event_ns", "record_kind", "trade_price_pts"]
    if "source_seq" in schema_names:
        cols.append("source_seq")
    missing = [col for col in cols if col not in schema_names]
    if missing:
        raise RuntimeError(f"event-stream missing expected columns: {missing}")
    df = pq.read_table(EVENT_STREAM_PATH, columns=cols).to_pandas()
    df = df[df["trade_price_pts"].notna()].copy()
    sort_cols = ["session_date", "ts_event_ns"] + (["source_seq"] if "source_seq" in df.columns else [])
    df = df.sort_values(sort_cols, kind="mergesort")
    return {
        str(session): {
            "ts": group["ts_event_ns"].to_numpy(dtype=np.int64),
            "px": group["trade_price_pts"].to_numpy(dtype=np.float64),
        }
        for session, group in df.groupby("session_date", sort=True)
    }


def compute_long_entry(path: dict[str, np.ndarray], trigger_ts: int, cancel_after_ts: int, stop_price: float, protection: float | None) -> dict[str, Any]:
    ts = path["ts"]
    px = path["px"]
    start = int(np.searchsorted(ts, trigger_ts, side="left"))
    end = int(np.searchsorted(ts, cancel_after_ts, side="right"))
    if start >= end:
        return {"attempted": True, "filled": False, "miss": True, "outcomes": {}}

    if protection is None:
        fill_idx = start
    else:
        eligible = np.flatnonzero(px[start:end] <= stop_price + protection)
        if len(eligible) == 0:
            return {"attempted": True, "filled": False, "miss": True, "outcomes": {}}
        fill_idx = start + int(eligible[0])

    entry_px = float(px[fill_idx])
    path_px = px[fill_idx:end]
    if len(path_px) == 0:
        path_px = np.array([entry_px], dtype=np.float64)

    outcomes: dict[tuple[float, float], tuple[str, float]] = {}
    for pt in PT_GRID:
        pt_hits = np.flatnonzero(path_px >= entry_px + pt)
        pt_idx = int(pt_hits[0]) if len(pt_hits) else None
        for stop in STOP_GRID:
            stop_hits = np.flatnonzero(path_px <= entry_px - stop)
            stop_idx = int(stop_hits[0]) if len(stop_hits) else None
            if stop_idx is not None and (pt_idx is None or stop_idx <= pt_idx):
                outcomes[(pt, stop)] = ("stop", -float(stop))
            elif pt_idx is not None:
                outcomes[(pt, stop)] = ("pt", float(pt))
            else:
                outcomes[(pt, stop)] = ("time_stop", float(path_px[-1] - entry_px))
    return {"attempted": True, "filled": True, "miss": False, "outcomes": outcomes}


def build_event_exit_table(triggered: pd.DataFrame, trade_paths: dict[str, dict[str, np.ndarray]], i0_by_session: dict[str, int]) -> tuple[pd.DataFrame, dict[str, int]]:
    rows: list[dict[str, Any]] = []
    stats = {
        "both_buy_first": 0,
        "both_sell_first": 0,
        "both_equal": 0,
        "buy_attempt_count": 0,
        "sell_only_no_entry": 0,
    }
    for row in triggered.itertuples(index=False):
        session = str(getattr(row, "session_date"))
        path = trade_paths.get(session)
        if path is None:
            raise RuntimeError(f"missing trade path for session {session}")
        i0_ts = i0_by_session[session]

        outcome = str(getattr(row, "outcome"))
        buy_ts = maybe_int(getattr(row, "buy_triggered_ts_offset_ns"))
        sell_ts = maybe_int(getattr(row, "sell_triggered_ts_offset_ns"))
        prot_label = protection_label(getattr(row, "stop_limit_protection_pts"))
        protection = protection_value(prot_label)
        stop_price = float(getattr(row, "armed_buy_stop_px_pts"))

        if outcome == "both_sides" and buy_ts is not None and sell_ts is not None:
            if buy_ts < sell_ts:
                stats["both_buy_first"] += 1
            elif sell_ts < buy_ts:
                stats["both_sell_first"] += 1
            else:
                stats["both_equal"] += 1
        if outcome == "sell_only":
            stats["sell_only_no_entry"] += 1

        if buy_ts is None:
            event = {"attempted": False, "filled": False, "miss": False, "outcomes": {}}
        else:
            stats["buy_attempt_count"] += 1
            event = compute_long_entry(path, i0_ts + buy_ts, i0_ts + CANCEL_AFTER_NS, stop_price, protection)

        for pt in PT_GRID:
            for stop in STOP_GRID:
                exit_reason = "no_entry"
                pnl_pts = 0.0
                if event["filled"]:
                    exit_reason, pnl_pts = event["outcomes"][(pt, stop)]
                elif event["miss"]:
                    exit_reason = "miss"
                rows.append(
                    {
                        "session_date": session,
                        "pt_pts": float(pt),
                        "stop_pts": float(stop),
                        "latency_bucket_ms": int(getattr(row, "latency_bucket_ms")),
                        "instrument": "MNQ",
                        "arm_time_s": int(getattr(row, "arm_time_s")),
                        "trigger_offset_pts": float(getattr(row, "trigger_offset_pts")),
                        "reference": str(getattr(row, "reference")),
                        "protection_label": prot_label,
                        "buy_attempted": bool(event["attempted"]),
                        "long_filled": bool(event["filled"]),
                        "stop_limit_miss": bool(event["miss"]),
                        "exit_reason": exit_reason,
                        "pnl_pts": float(pnl_pts),
                    }
                )

    both_total = stats["both_buy_first"] + stats["both_sell_first"] + stats["both_equal"]
    if stats["both_equal"] > 0 and stats["both_equal"] / max(1, both_total) > 0.01:
        raise RuntimeError(f"ambiguous both-side equal-timestamp rate exceeds 1%: {stats['both_equal']}")
    return pd.DataFrame(rows), stats


def aggregate_expectancy(event_df: pd.DataFrame) -> pd.DataFrame:
    group_cols = [
        "pt_pts",
        "stop_pts",
        "latency_bucket_ms",
        "instrument",
        "arm_time_s",
        "trigger_offset_pts",
        "reference",
        "protection_label",
    ]
    output_rows: list[dict[str, Any]] = []
    for key, group in event_df.groupby(group_cols, sort=False):
        pt, stop, latency, instrument, arm, offset, reference, prot_label = key
        n_events_total = int(group["session_date"].nunique())
        if n_events_total != SESSION_COUNT:
            raise RuntimeError(f"unexpected session coverage for {key}: {n_events_total}")
        buy_attempts = int(group["buy_attempted"].sum())
        long_filled = int(group["long_filled"].sum())
        misses = int(group["stop_limit_miss"].sum())
        pt_hits = int((group["exit_reason"] == "pt").sum())
        stop_hits = int((group["exit_reason"] == "stop").sum())
        time_stops = int((group["exit_reason"] == "time_stop").sum())
        filled = group[group["long_filled"]]
        expectancy_pts = float(filled["pnl_pts"].mean()) if long_filled else 0.0
        trade_frequency = long_filled / SESSION_COUNT
        share = {
            "pt": stable(pt_hits / SESSION_COUNT),
            "stop": stable(stop_hits / SESSION_COUNT),
            "time_stop": stable(time_stops / SESSION_COUNT),
            "miss": stable(misses / SESSION_COUNT),
        }
        for cost_name, cost in COST_SCENARIOS.items():
            cost_usd = cost["commission_round_trip_usd"] + 2.0 * cost["slippage_per_side_ticks"] * TICK_VALUE_USD
            expectancy_usd = expectancy_pts * POINT_VALUE_USD - cost_usd if long_filled else 0.0
            output_rows.append(
                {
                    "pt_pts": float(pt),
                    "stop_pts": float(stop),
                    "cost_scenario": cost_name,
                    "latency_bucket_ms": int(latency),
                    "instrument": str(instrument),
                    "arm_time_s": int(arm),
                    "trigger_offset_pts": float(offset),
                    "reference": str(reference),
                    "stop_limit_protection_pts": protection_value(str(prot_label)),
                    "n_events_total": SESSION_COUNT,
                    "n_triggered_one_side": buy_attempts,
                    "n_triggered_both_sides": 0,
                    "n_triggered_neither": SESSION_COUNT - buy_attempts,
                    "p_triggered_one_side": stable(buy_attempts / SESSION_COUNT),
                    "p_both_side_false_trigger": 0.0,
                    "p_pt_hit_before_stop": stable(pt_hits / long_filled if long_filled else 0.0),
                    "p_stop_hit_before_pt": stable(stop_hits / long_filled if long_filled else 0.0),
                    "p_time_stop": stable(time_stops / long_filled if long_filled else 0.0),
                    "p_stop_limit_miss": stable(misses / buy_attempts if buy_attempts else 0.0),
                    "expectancy_per_trade_usd": stable(expectancy_usd),
                    "expectancy_per_trade_pts": stable(expectancy_pts),
                    "trade_frequency_per_session": stable(trade_frequency),
                    "expected_daily_pnl_usd": stable(expectancy_usd * trade_frequency),
                    "n_long_entered": long_filled,
                    "p_long_entered": stable(trade_frequency),
                    "exit_reason_share": share,
                    "cost_rank": COST_ORDER[cost_name],
                    "reference_rank": REFERENCE_ORDER[str(reference)],
                    "protection_rank": PROTECTION_ORDER[str(prot_label)],
                }
            )
    df = pd.DataFrame(output_rows)
    df = df.sort_values(
        [
            "pt_pts",
            "stop_pts",
            "cost_rank",
            "latency_bucket_ms",
            "arm_time_s",
            "trigger_offset_pts",
            "reference_rank",
            "protection_rank",
            "instrument",
        ],
        kind="mergesort",
    ).reset_index(drop=True)
    return df[OUTPUT_COLUMNS + ["cost_rank", "reference_rank", "protection_rank"]]


def parquet_schema() -> pa.Schema:
    return pa.schema(
        [
            pa.field("pt_pts", pa.float64()),
            pa.field("stop_pts", pa.float64()),
            pa.field("cost_scenario", pa.string()),
            pa.field("latency_bucket_ms", pa.int64()),
            pa.field("instrument", pa.string()),
            pa.field("arm_time_s", pa.int64()),
            pa.field("trigger_offset_pts", pa.float64()),
            pa.field("reference", pa.string()),
            pa.field("stop_limit_protection_pts", pa.float64()),
            pa.field("n_events_total", pa.int64()),
            pa.field("n_triggered_one_side", pa.int64()),
            pa.field("n_triggered_both_sides", pa.int64()),
            pa.field("n_triggered_neither", pa.int64()),
            pa.field("p_triggered_one_side", pa.float64()),
            pa.field("p_both_side_false_trigger", pa.float64()),
            pa.field("p_pt_hit_before_stop", pa.float64()),
            pa.field("p_stop_hit_before_pt", pa.float64()),
            pa.field("p_time_stop", pa.float64()),
            pa.field("p_stop_limit_miss", pa.float64()),
            pa.field("expectancy_per_trade_usd", pa.float64()),
            pa.field("expectancy_per_trade_pts", pa.float64()),
            pa.field("trade_frequency_per_session", pa.float64()),
            pa.field("expected_daily_pnl_usd", pa.float64()),
            pa.field("n_long_entered", pa.int64()),
            pa.field("p_long_entered", pa.float64()),
            pa.field(
                "exit_reason_share",
                pa.struct(
                    [
                        pa.field("pt", pa.float64()),
                        pa.field("stop", pa.float64()),
                        pa.field("time_stop", pa.float64()),
                        pa.field("miss", pa.float64()),
                    ]
                ),
            ),
        ]
    )


def write_parquet(df: pd.DataFrame) -> None:
    table = pa.Table.from_pandas(df[OUTPUT_COLUMNS], schema=parquet_schema(), preserve_index=False)
    pq.write_table(table, OUTPUT_PARQUET, compression="zstd", use_dictionary=False, write_statistics=False)


def select_top_mid_100(df: pd.DataFrame) -> pd.Series:
    subset = df[(df["cost_scenario"] == "mnq_mid") & (df["latency_bucket_ms"] == 100)].copy()
    subset = subset.sort_values(
        [
            "expected_daily_pnl_usd",
            "pt_pts",
            "stop_pts",
            "arm_time_s",
            "trigger_offset_pts",
            "reference",
            "stop_limit_protection_pts",
        ],
        ascending=[False, True, True, True, True, True, True],
        kind="mergesort",
    )
    return subset.iloc[0]


def session_returns_for_top(event_df: pd.DataFrame, top: pd.Series, cost_name: str) -> list[float]:
    prot_lbl = protection_label(top["stop_limit_protection_pts"])
    mask = (
        (event_df["pt_pts"] == float(top["pt_pts"]))
        & (event_df["stop_pts"] == float(top["stop_pts"]))
        & (event_df["latency_bucket_ms"] == int(top["latency_bucket_ms"]))
        & (event_df["arm_time_s"] == int(top["arm_time_s"]))
        & (event_df["trigger_offset_pts"] == float(top["trigger_offset_pts"]))
        & (event_df["reference"] == str(top["reference"]))
        & (event_df["protection_label"] == prot_lbl)
    )
    cost = COST_SCENARIOS[cost_name]
    cost_usd = cost["commission_round_trip_usd"] + 2.0 * cost["slippage_per_side_ticks"] * TICK_VALUE_USD
    rows = event_df[mask].sort_values("session_date", kind="mergesort")
    returns = []
    for row in rows.itertuples(index=False):
        returns.append(float(getattr(row, "pnl_pts")) * POINT_VALUE_USD - cost_usd if bool(getattr(row, "long_filled")) else 0.0)
    if len(returns) != SESSION_COUNT:
        raise RuntimeError(f"top-cell return vector length {len(returns)} != {SESSION_COUNT}")
    return returns


def bootstrap_ci(values: list[float], block_bootstrap: Any) -> dict[str, Any]:
    block_len = int(block_bootstrap.politis_white_median_block_length(len(values)))
    matrix = block_bootstrap.stationary_bootstrap_matrix(
        values,
        replications=BOOTSTRAP_REPLICATIONS,
        seed=BOOTSTRAP_SEED,
        mean_block_length=block_len,
    )
    means = [sum(sample) / len(sample) for sample in matrix]
    return {
        "seed": BOOTSTRAP_SEED,
        "replications": BOOTSTRAP_REPLICATIONS,
        "block_length": block_len,
        "mean": stable(sum(values) / len(values)),
        "ci_low": stable(block_bootstrap.percentile(means, 0.025)),
        "ci_high": stable(block_bootstrap.percentile(means, 0.975)),
    }


def dsr_check(values: list[float], psr_dsr: Any) -> dict[str, Any]:
    try:
        decimal_returns = [value / 1000.0 for value in values]
        result = psr_dsr.compute_psr_dsr(decimal_returns, effective_trial_count=90_720)
        return {
            "status": "computed",
            **{
                key: stable(value) if isinstance(value, float) else value
                for key, value in dataclasses.asdict(result).items()
            },
        }
    except Exception as exc:  # noqa: BLE001 - honest statistical failure mode is reported
        return {"status": "failed", "reason": f"{type(exc).__name__}: {exc}"}


def fmt_protection(value: Any) -> str:
    return "null" if value is None or pd.isna(value) else f"{float(value):.1f}"


def top_table(df: pd.DataFrame, limit: int = 10) -> pd.DataFrame:
    return df.sort_values(
        [
            "expected_daily_pnl_usd",
            "pt_pts",
            "stop_pts",
            "cost_scenario",
            "latency_bucket_ms",
            "arm_time_s",
            "trigger_offset_pts",
            "reference",
            "stop_limit_protection_pts",
        ],
        ascending=[False, True, True, True, True, True, True, True, True],
        kind="mergesort",
    ).head(limit)


def markdown_table(df: pd.DataFrame, columns: list[str]) -> list[str]:
    lines = ["| " + " | ".join(columns) + " |", "| " + " | ".join(["---"] * len(columns)) + " |"]
    for record in df[columns].to_dict(orient="records"):
        vals = []
        for col in columns:
            value = record[col]
            if col == "stop_limit_protection_pts":
                vals.append(fmt_protection(value))
            elif isinstance(value, float):
                vals.append(f"{value:.10f}".rstrip("0").rstrip("."))
            else:
                vals.append(str(value))
        lines.append("| " + " | ".join(vals) + " |")
    return lines


def build_memo(
    df: pd.DataFrame,
    event_df: pd.DataFrame,
    triggered: pd.DataFrame,
    baseline: pd.DataFrame,
    stats: dict[str, int],
    bootstrap: dict[str, Any],
    dsr: dict[str, Any],
    top: pd.Series,
) -> None:
    long_top10 = top_table(df)
    bilateral_top10 = top_table(baseline)
    compare_rows = []
    for row in long_top10.itertuples(index=False):
        mask = (
            (baseline["pt_pts"] == row.pt_pts)
            & (baseline["stop_pts"] == row.stop_pts)
            & (baseline["cost_scenario"] == row.cost_scenario)
            & (baseline["latency_bucket_ms"] == row.latency_bucket_ms)
            & (baseline["arm_time_s"] == row.arm_time_s)
            & (baseline["trigger_offset_pts"] == row.trigger_offset_pts)
            & (baseline["reference"] == row.reference)
        )
        mask &= baseline["stop_limit_protection_pts"].isna() if pd.isna(row.stop_limit_protection_pts) else baseline["stop_limit_protection_pts"] == row.stop_limit_protection_pts
        base = baseline[mask].iloc[0]
        compare_rows.append(
            {
                "pt_pts": row.pt_pts,
                "stop_pts": row.stop_pts,
                "cost_scenario": row.cost_scenario,
                "latency_bucket_ms": row.latency_bucket_ms,
                "arm_time_s": row.arm_time_s,
                "trigger_offset_pts": row.trigger_offset_pts,
                "reference": row.reference,
                "stop_limit_protection_pts": row.stop_limit_protection_pts,
                "long_only_daily_usd": row.expected_daily_pnl_usd,
                "bilateral_daily_usd": base["expected_daily_pnl_usd"],
                "delta_usd": row.expected_daily_pnl_usd - base["expected_daily_pnl_usd"],
            }
        )
    compare_df = pd.DataFrame(compare_rows)

    counts = Counter(triggered["outcome"])
    buy_only = int(counts.get("buy_only", 0))
    sell_only = int(counts.get("sell_only", 0))
    one_side = buy_only + sell_only
    expected_each = one_side / 2.0
    chi_square = ((buy_only - expected_each) ** 2 / expected_each) + ((sell_only - expected_each) ** 2 / expected_each)
    z = (buy_only - expected_each) / math.sqrt(one_side * 0.25)
    p_approx = 2.0 * NormalDist().cdf(-abs(z))

    stress = df[
        (df["pt_pts"] == top["pt_pts"])
        & (df["stop_pts"] == top["stop_pts"])
        & (df["cost_scenario"] == "mnq_high")
        & (df["latency_bucket_ms"] == 500)
        & (df["arm_time_s"] == top["arm_time_s"])
        & (df["trigger_offset_pts"] == top["trigger_offset_pts"])
        & (df["reference"] == top["reference"])
    ]
    stress = stress[stress["stop_limit_protection_pts"].isna()] if pd.isna(top["stop_limit_protection_pts"]) else stress[stress["stop_limit_protection_pts"] == top["stop_limit_protection_pts"]]
    stress_row = stress.iloc[0]

    bootstrap_pass = bool(bootstrap["ci_low"] is not None and bootstrap["ci_low"] > 0)
    dsr_pass = bool(dsr.get("status") == "computed" and float(dsr.get("dsr_probability", 0.0)) >= 0.95)
    verdict = "SCOPE FULL MOC-LO RESEARCH STREAM" if (bootstrap_pass and dsr_pass) else "ACCEPT LONG-ONLY ALSO FAILS"
    criteria = [
        ("Primary expectancy >= $1.50 at mnq_mid/100ms", "true", top["expectancy_per_trade_usd"] >= 1.50, f"${top['expectancy_per_trade_usd']:.10f}/trade"),
        ("Stress expectancy > $0 at mnq_high/500ms", "true", stress_row["expectancy_per_trade_usd"] > 0.0, f"${stress_row['expectancy_per_trade_usd']:.10f}/trade"),
        ("Hit rate >= 0.45", "true", top["p_pt_hit_before_stop"] >= 0.45, f"{top['p_pt_hit_before_stop']:.10f}"),
        ("Both-side false-trigger <= 0.20", "false", "N/A", "Long-only has no sell leg"),
        ("Stop-limit miss-rate <= 0.10", "true", top["p_stop_limit_miss"] <= 0.10, f"{top['p_stop_limit_miss']:.10f}"),
        ("Bootstrap CI lower bound > 0", "FAILED", bootstrap_pass, f"ci_low={bootstrap['ci_low']:.10f}"),
        ("Multiple-testing correction survives", "FAILED", dsr_pass, json.dumps(dsr, sort_keys=True)),
        ("Parameter perturbation within 30%", "FAILED", "not recomputed", "Counterfactual only; full stream would rerun R6"),
        ("Latency monotonicity", "PASS", "not recomputed", "Counterfactual memo does not rerun full R6"),
        ("Trade frequency >= 0.5 and sample-power", "FAILED", top["trade_frequency_per_session"] >= 0.5, f"freq={top['trade_frequency_per_session']:.10f}"),
        ("NQ confirmation", "N/A", "N/A", "No NQ corpus in this dispatch"),
    ]

    lines = [
        "# MOC-LO long-only counterfactual comparison",
        "",
        "## Verdict",
        "",
        f"**{verdict}.**",
        "",
        "The binary recommendation is driven by the exploratory load-bearing tests: bootstrap CI lower bound and DSR. Marginal improvements in other criteria are not enough under CF-44 anti-near-miss discipline.",
        "",
        "## Catalog provenance",
        "",
    ]
    provenance = {
        "triggered_events_sha": sha256_file(TRIGGERED_PATH),
        "expectancy_tables_sha": sha256_file(EXPECTANCY_PATH),
        "event_stream_sha": sha256_file(EVENT_STREAM_PATH),
        "event_stream_attestation_sha": EVENT_STREAM_SHA_PATH.read_text(encoding="utf-8").strip(),
        "r7_report_sha": sha256_file(R7_REPORT_PATH),
        "research_grid_manifest_sha": sha256_file(GRID_MANIFEST_PATH),
    }
    lines.extend([f"- `{key}`: `{value}`" for key, value in provenance.items()])
    lines.append("- Production statistical modules were loaded read-only using the MOC-R6 importlib + scoped sys.path + sys.modules registration pattern.")
    lines.extend(["", "## Long-only top 10 by expected_daily_pnl_usd", ""])
    long_cols = ["pt_pts", "stop_pts", "cost_scenario", "latency_bucket_ms", "arm_time_s", "trigger_offset_pts", "reference", "stop_limit_protection_pts", "n_long_entered", "expectancy_per_trade_usd", "expected_daily_pnl_usd"]
    lines.extend(markdown_table(long_top10, long_cols))
    lines.extend(["", "## Bilateral R4 top 10 by expected_daily_pnl_usd", ""])
    bilateral_cols = ["pt_pts", "stop_pts", "cost_scenario", "latency_bucket_ms", "arm_time_s", "trigger_offset_pts", "reference", "stop_limit_protection_pts", "expectancy_per_trade_usd", "expected_daily_pnl_usd"]
    lines.extend(markdown_table(bilateral_top10, bilateral_cols))
    lines.extend(["", "## Direct A/B at long-only top-10 coordinates", ""])
    compare_cols = ["pt_pts", "stop_pts", "cost_scenario", "latency_bucket_ms", "arm_time_s", "trigger_offset_pts", "reference", "stop_limit_protection_pts", "long_only_daily_usd", "bilateral_daily_usd", "delta_usd"]
    lines.extend(markdown_table(compare_df, compare_cols))
    lines.extend(["", "## Buy/sell asymmetry", ""])
    lines.append(f"Plan A R3 one-sided cells: buy_only={buy_only}, sell_only={sell_only}, ratio={buy_only / sell_only:.4f}. A simple one-sided-cell 50/50 chi-square diagnostic is {chi_square:.4f} with z={z:.4f}; normal-tail p is approximately {p_approx:.4e}. This is statistically large at cell level, but grid cells are not independent because each session contributes many parameter cells.")
    lines.extend(["", "## Both-sides buy-first resolution", ""])
    both_total = stats["both_buy_first"] + stats["both_sell_first"] + stats["both_equal"]
    lines.append(f"both_sides total={both_total}; buy-first={stats['both_buy_first']}; sell-first={stats['both_sell_first']}; equal-ts={stats['both_equal']}. The implementation recomputes every long-side entry from the buy trigger using event-stream prints, so sell-first both_sides rows never copy R3's short-side singular fields.")
    lines.extend(["", "## Bootstrap and DSR diagnostics", ""])
    lines.append(f"Top mnq_mid/100ms long-only cell: pt={top['pt_pts']}, stop={top['stop_pts']}, arm={top['arm_time_s']}, offset={top['trigger_offset_pts']}, reference={top['reference']}, protection={fmt_protection(top['stop_limit_protection_pts'])}.")
    lines.append(f"Bootstrap: seed={bootstrap['seed']}, replications={bootstrap['replications']}, block_length={bootstrap['block_length']}, mean={bootstrap['mean']:.10f}, ci_low={bootstrap['ci_low']:.10f}, ci_high={bootstrap['ci_high']:.10f}.")
    lines.append(f"DSR: `{json.dumps(dsr, sort_keys=True)}`.")
    lines.extend(["", "## Plan A R7 criterion comparison", ""])
    lines.append("| Criterion | Bilateral R7 | Long-only | Evidence |")
    lines.append("| --- | --- | --- | --- |")
    for name, bilateral, long_only, evidence in criteria:
        long_text = "PASS" if long_only is True else "FAIL" if long_only is False else str(long_only)
        lines.append(f"| {name} | {bilateral} | {long_text} | {evidence} |")
    lines.extend(["", "## Methodology notes", ""])
    lines.append("Rows preserve the R4 MNQ-only grid shape: 7 pt x 6 stop x 3 cost x 4 latency x 3 arm x 5 offset x 3 reference x 4 protection x 1 instrument = 90,720 rows. Long-only adds n_long_entered, p_long_entered, and exit_reason_share to the 23 R4-compatible columns.")
    lines.append("Stop-market cells fill at the first print at or after the buy trigger. Stop-limit cells fill at the first print at or below stop_price + protection before I0+300s; otherwise they are counted as missed entries. First-touch exits walk forward from the long fill timestamp only, preserving no-lookahead discipline.")
    lines.append("DSR decimal returns use per-session USD returns divided by a fixed $1,000 research notional. The scaling is deterministic and reported only for this exploratory screen; a full MOC-LO stream would restate the statistical protocol before production consideration.")
    lines.extend(["", "## Binary recommendation", "", verdict, ""])
    OUTPUT_MEMO.write_text("\n".join(lines), encoding="utf-8", newline="\n")


def main() -> None:
    triggered = pq.read_table(TRIGGERED_PATH).to_pandas()
    baseline = pq.read_table(EXPECTANCY_PATH).to_pandas()
    i0_by_session = load_i0_by_session()
    trade_paths = read_trade_paths()
    event_df, stats = build_event_exit_table(triggered, trade_paths, i0_by_session)
    result = aggregate_expectancy(event_df)
    if len(result) != EXPECTED_ROWS:
        raise RuntimeError(f"expected {EXPECTED_ROWS} rows, got {len(result)}")
    write_parquet(result)

    block_bootstrap, psr_dsr = load_stats_modules()
    top = select_top_mid_100(result)
    returns = session_returns_for_top(event_df, top, "mnq_mid")
    bootstrap = bootstrap_ci(returns, block_bootstrap)
    dsr = dsr_check(returns, psr_dsr)
    build_memo(result[OUTPUT_COLUMNS], event_df, triggered, baseline, stats, bootstrap, dsr, top)

    print(f"wrote {OUTPUT_PARQUET}")
    print(f"rows={len(result)} sha={sha256_file(OUTPUT_PARQUET)}")
    print(f"wrote {OUTPUT_MEMO} sha={sha256_file(OUTPUT_MEMO)}")


if __name__ == "__main__":
    main()
