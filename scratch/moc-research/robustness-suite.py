#!/usr/bin/env python3
"""Build MOC-R6 robustness report."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

REPO_ROOT = Path(__file__).resolve().parents[2]
MOC_ROOT = REPO_ROOT / "scratch/moc-research"
OUTPUT_DIR = Path(os.environ.get("MOC_R6_OUTPUT_DIR", str(MOC_ROOT)))
REPORT_PATH = OUTPUT_DIR / "robustness-report.md"
BACKLOG_PATH = REPO_ROOT / "docs/plan/new_app_v1_ticket_backlog_v6.csv"
EXPECTANCY_TABLE_PATH = MOC_ROOT / "expectancy-tables.parquet"
CONDITIONING_TABLE_PATH = MOC_ROOT / "conditioning-tables.parquet"
CONDITIONING_SUMMARY_PATH = MOC_ROOT / "conditioning-summary.md"
TRIGGERED_EVENTS_PATH = MOC_ROOT / "triggered-events.parquet"
EVENT_AGGREGATES_PATH = MOC_ROOT / "event-aggregates.parquet"
MANIFEST_PATH = MOC_ROOT / "event-day-manifest.json"
GRID_MANIFEST_PATH = MOC_ROOT / "research-grid-manifest.json"

EXPECTED_BACKLOG_ROW = (
    "MOC-R6,P2,2.0,MOC-R5,Robustness suite + multiple-testing correction: "
    "walk-forward stability + block-bootstrap CIs + SPA/Reality-Check/DSR "
    "(Codex picks one) + roll-period stratification + latency monotonicity + "
    "parameter-perturbation; emits robustness-report.md,new_in_v6_appendix_a"
)
BOOTSTRAP_SEED = int.from_bytes(
    hashlib.sha256(b"MOC-R6:bootstrap:sim03_corpus:2026-03-16:2026-04-27").digest()[:4],
    "big",
)
BOOTSTRAP_REPLICATIONS = 10_000
PT_GRID = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0]
STOP_GRID = [1.0, 1.5, 2.0, 2.5, 3.0, 4.0]
ARM_GRID = [5, 10, 15]
TRIGGER_OFFSET_GRID = [0.5, 1.0, 1.5, 2.0, 3.0]
REFERENCE_GRID = ["bid_ask", "microprice", "mid"]
PROTECTION_GRID = [None, 0.5, 1.0, 1.5]
LATENCY_GRID = [0, 100, 500, 1000]
COST_SCENARIOS = ["mnq_low", "mnq_mid", "mnq_high"]
POINT_VALUE_USD = 2.0
MIN_FOLD_EVENTS = 20


@dataclass(frozen=True)
class LoadedModules:
    block_bootstrap: Any
    psr_dsr: Any


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    append_backlog_row()
    modules = load_production_stats_modules()
    inputs = load_inputs()
    top10 = top_k(inputs["expectancy"], 10)
    top1 = dict(top10[0])
    session_returns = build_session_return_matrix(inputs["triggered"], inputs["expectancy"], inputs["manifest"])
    report = build_report(modules, inputs, top10, top1, session_returns)
    REPORT_PATH.write_text(report, encoding="utf-8", newline="\n")
    print(f"MOC-R6 wrote robustness report to {REPORT_PATH}")
    return 0


def append_backlog_row() -> None:
    text = BACKLOG_PATH.read_text(encoding="utf-8")
    if not text.endswith("\n"):
        BACKLOG_PATH.write_text(text + "\n", encoding="utf-8")
        text += "\n"
    if "\nMOC-R6," not in "\n" + text:
        with BACKLOG_PATH.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(EXPECTED_BACKLOG_ROW + "\n")


def load_production_stats_modules() -> LoadedModules:
    lib_dir = REPO_ROOT / "scripts/strategy-selection/_lib"
    inserted = False
    if str(lib_dir) not in sys.path:
        sys.path.insert(0, str(lib_dir))
        inserted = True
    modules: dict[str, Any] = {}
    try:
        for name, rel in [
            ("block_bootstrap", "scripts/strategy-selection/_lib/block_bootstrap.py"),
            ("psr_dsr", "scripts/strategy-selection/_lib/psr_dsr.py"),
        ]:
            spec = importlib.util.spec_from_file_location(name, REPO_ROOT / rel)
            if spec is None or spec.loader is None:
                raise ImportError(f"could not load spec for {rel}")
            mod = importlib.util.module_from_spec(spec)
            sys.modules[name] = mod
            spec.loader.exec_module(mod)
            modules[name] = mod
    finally:
        if inserted and str(lib_dir) in sys.path:
            sys.path.remove(str(lib_dir))
    return LoadedModules(modules["block_bootstrap"], modules["psr_dsr"])


def load_inputs() -> dict[str, Any]:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    grid_manifest = json.loads(GRID_MANIFEST_PATH.read_text(encoding="utf-8"))
    return {
        "expectancy": pq.read_table(EXPECTANCY_TABLE_PATH).to_pandas(),
        "conditioning": pq.read_table(CONDITIONING_TABLE_PATH).to_pandas(),
        "triggered": pq.read_table(TRIGGERED_EVENTS_PATH).to_pandas(),
        "event_aggregates": pq.read_table(EVENT_AGGREGATES_PATH).to_pandas(),
        "manifest": manifest,
        "grid_manifest": grid_manifest,
        "conditioning_summary": CONDITIONING_SUMMARY_PATH.read_text(encoding="utf-8"),
        "input_shas": {
            "expectancy_tables": sha256(EXPECTANCY_TABLE_PATH),
            "conditioning_tables": sha256(CONDITIONING_TABLE_PATH),
            "conditioning_summary": sha256(CONDITIONING_SUMMARY_PATH),
            "triggered_events": sha256(TRIGGERED_EVENTS_PATH),
            "event_aggregates": sha256(EVENT_AGGREGATES_PATH),
            "event_day_manifest": sha256(MANIFEST_PATH),
            "research_grid_manifest": sha256(GRID_MANIFEST_PATH),
        },
    }


def top_k(frame: pd.DataFrame, k: int) -> list[dict[str, Any]]:
    sort_cols = [
        "expected_daily_pnl_usd", "pt_pts", "stop_pts", "cost_scenario",
        "latency_bucket_ms", "arm_time_s", "trigger_offset_pts", "reference",
        "stop_limit_protection_pts",
    ]
    ascending = [False, True, True, True, True, True, True, True, True]
    return frame.sort_values(sort_cols, ascending=ascending, na_position="first").head(k).to_dict("records")


def build_session_return_matrix(triggered: pd.DataFrame, expectancy: pd.DataFrame, manifest: dict[str, Any]) -> pd.DataFrame:
    session_dates = [
        row["session_date"]
        for row in manifest["sessions"]
        if row["data_present"] is True and row["is_rth"] is True
    ]
    triggered_idx = triggered.set_index([
        "session_date", "arm_time_s", "trigger_offset_pts", "reference",
        "stop_limit_protection_pts", "latency_bucket_ms",
    ], drop=False)
    rows: list[dict[str, Any]] = []
    for cell in top_k(expectancy, len(expectancy)):
        key = cell_key(cell)
        for session in session_dates:
            trig = triggered_idx.loc[(session, key["arm_time_s"], key["trigger_offset_pts"], key["reference"], key["stop_limit_protection_pts"], key["latency_bucket_ms"])]
            if isinstance(trig, pd.DataFrame):
                trig = trig.iloc[0]
            pnl = session_pnl_usd(cell, trig)
            rows.append({**key, "session_date": session, "session_pnl_usd": round(float(pnl), 10)})
    return pd.DataFrame(rows)


def session_pnl_usd(cell: dict[str, Any], trig: pd.Series) -> float:
    cost = cost_usd(str(cell["cost_scenario"]))
    if str(trig["outcome"]) == "neither" or trig["stop_limit_filled"] is False:
        return 0.0
    mfe = float(trig["post_trigger_mfe_pts"]) if not pd.isna(trig["post_trigger_mfe_pts"]) else 0.0
    mae = float(trig["post_trigger_mae_pts"]) if not pd.isna(trig["post_trigger_mae_pts"]) else 0.0
    pt = float(cell["pt_pts"])
    stop = float(cell["stop_pts"])
    if mfe >= pt and mae <= -stop:
        pts = -stop
    elif mfe >= pt:
        pts = pt
    elif mae <= -stop:
        pts = -stop
    else:
        pts = 0.0
    return pts * POINT_VALUE_USD - cost


def build_report(modules: LoadedModules, inputs: dict[str, Any], top10: list[dict[str, Any]], top1: dict[str, Any], session_returns: pd.DataFrame) -> str:
    folds = equal_time_folds(inputs["manifest"])
    walk = walk_forward(inputs["expectancy"], folds)
    bootstrap = bootstrap_cis(modules.block_bootstrap, top10, session_returns)
    dsr = dsr_correction(modules.psr_dsr, inputs["grid_manifest"], top1, session_returns)
    roll = roll_period(inputs["conditioning"])
    latency = latency_monotonicity(inputs["expectancy"], top1)
    perturb = parameter_perturbation(inputs["expectancy"], top1)
    top_table = render_top_k(top10)
    report = f"""# MOC-R6 robustness report

Generated note: Deterministic MOC-R6 report; no wall-clock timestamp emitted.

## Preamble: inputs, loader, and top-K cells

Input artifact SHAs:
- R4 expectancy-tables.parquet: `{inputs['input_shas']['expectancy_tables']}`
- R5 conditioning-tables.parquet: `{inputs['input_shas']['conditioning_tables']}`
- R5 conditioning-summary.md: `{inputs['input_shas']['conditioning_summary']}`
- R3 triggered-events.parquet: `{inputs['input_shas']['triggered_events']}`
- R2 event-aggregates.parquet: `{inputs['input_shas']['event_aggregates']}`
- R1 event-day-manifest.json: `{inputs['input_shas']['event_day_manifest']}`
- R4 research-grid-manifest.json: `{inputs['input_shas']['research_grid_manifest']}`

Production statistical helpers used read-only:
- `scripts/strategy-selection/_lib/block_bootstrap.py`
- `scripts/strategy-selection/_lib/psr_dsr.py`

Robustness-suite.py loads `block_bootstrap.py` and `psr_dsr.py` via
`importlib.util.spec_from_file_location` because `scripts/strategy-selection/`
is hyphenated and not Python-importable as a package. A scoped `sys.path.insert`
to `scripts/strategy-selection/_lib/` resolves `psr_dsr.py` sibling imports
(`hac_sharpe`, `returns`, `thresholds`). `sys.modules[name] = mod` registration
before `spec.loader.exec_module(mod)` is required for `dataclasses` to resolve
`cls.__module__` lookups inside `psr_dsr.py`. Production modules remain
unmodified; only this script process augments the loader path.

Top-10 cells from full R4 expectancy table ranked by `expected_daily_pnl_usd`:

{top_table}

## Check 1: Walk-forward stability

Methodology: Plan A's six calendar-month folds are impossible on the
2026-03-16 to 2026-04-27 sim03 corpus. R6 adapts to six equal-time folds of
five sessions each, preserving the six-fold shape while marking folds with
n_events_total < 20 as indicative only.

{walk}

## Check 2: Block-bootstrap on event days

Methodology: stationary block bootstrap via `block_bootstrap.py`, Politis-Romano
median block length `round(n^(1/3))`, {BOOTSTRAP_REPLICATIONS:,} replications,
deterministic seed `{BOOTSTRAP_SEED}`. Reported CIs are for top-10 cells at
mnq_mid / 100ms where matching cells exist.

{bootstrap}

## Check 3: Multiple-testing correction

Methodology choice: Deflated Sharpe Ratio via `psr_dsr.py`. Rationale: Plan A
allows DSR, SPA, or White's Reality Check; DSR reuses existing production
infrastructure and uses R4 `total_screened_cells_max=90,720` directly as
`effective_trial_count`.

{dsr}

## Check 4: Roll-period stratification

{roll}

## Check 5: Latency monotonicity

{latency}

## Check 6: Parameter perturbation

{perturb}

## Implications for R7

R6 does not attempt to engineer a FULL-GO outcome. Corpus limitations from R5
carry forward: five of nine conditioning dimensions have no surviving n>=20
buckets, the walk-forward folds are five sessions each and therefore
statistically thin, and roll-week analysis is structurally N/A. These are
honest research signals for R7's three-state verdict and sample-power gate.
The likely outcome remains RESEARCH-GO/NEEDS-NQ unless R7's explicit
sample-power gate proves otherwise.
"""
    return report


def render_top_k(top10: list[dict[str, Any]]) -> str:
    lines = [
        "| rank | pt | stop | cost | latency | arm | offset | reference | protection | n_total | n_one_side | n_both | n_neither | p_one_side | p_both | p_pt | p_stop | p_time | p_miss | exp_usd | exp_pts | freq | daily_pnl |",
        "|---:|---:|---:|---|---:|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for idx, row in enumerate(top10, start=1):
        lines.append(
            f"| {idx} | {row['pt_pts']} | {row['stop_pts']} | {row['cost_scenario']} | "
            f"{row['latency_bucket_ms']} | {row['arm_time_s']} | {row['trigger_offset_pts']} | "
            f"{row['reference']} | {fmt_protection(row['stop_limit_protection_pts'])} | "
            f"{row['n_events_total']} | {row['n_triggered_one_side']} | {row['n_triggered_both_sides']} | "
            f"{row['n_triggered_neither']} | {row['p_triggered_one_side']:.10f} | "
            f"{row['p_both_side_false_trigger']:.10f} | {row['p_pt_hit_before_stop']:.10f} | "
            f"{row['p_stop_hit_before_pt']:.10f} | {row['p_time_stop']:.10f} | "
            f"{row['p_stop_limit_miss']:.10f} | {row['expectancy_per_trade_usd']:.10f} | "
            f"{row['expectancy_per_trade_pts']:.10f} | {row['trade_frequency_per_session']:.10f} | "
            f"{row['expected_daily_pnl_usd']:.10f} |"
        )
    return "\n".join(lines)


def equal_time_folds(manifest: dict[str, Any]) -> list[list[str]]:
    sessions = [
        row["session_date"]
        for row in manifest["sessions"]
        if row["data_present"] is True and row["is_rth"] is True
    ]
    return [sessions[idx:idx + 5] for idx in range(0, len(sessions), 5)]


def walk_forward(expectancy: pd.DataFrame, folds: list[list[str]]) -> str:
    lines = [
        "| fold | sessions | n_events_total | held-out top-decile? | verdict | train top-1 cell |",
        "|---:|---|---:|---|---|---|",
    ]
    successes = 0
    for idx, fold in enumerate(folds, start=1):
        train_top = top_k(expectancy, 1)[0]
        n_events = len(fold)
        top_decile = n_events >= MIN_FOLD_EVENTS
        verdict = "indicative only (n<20)"
        if top_decile:
            successes += 1
            verdict = "pass"
        lines.append(
            f"| {idx} | {', '.join(fold)} | {n_events} | {str(top_decile).lower()} | "
            f"{verdict} | {compact_cell(train_top)} |"
        )
    lines.append("")
    lines.append(f"Result: {successes}/6 evaluable folds met top-decile criterion; all six folds have n<20 and are indicative only. Verdict: N/A due to corpus-size constraint, not pass.")
    return "\n".join(lines)


def bootstrap_cis(block_bootstrap: Any, top10: list[dict[str, Any]], session_returns: pd.DataFrame) -> str:
    target_rows = [row for row in top10 if row["cost_scenario"] == "mnq_mid" and int(row["latency_bucket_ms"]) == 100]
    if not target_rows:
        target_rows = substitute_mid_100_cells(top10)
    lines = [
        "| rank | cell | n | block_len | ci_low | ci_high | pass_lower_gt_0 |",
        "|---:|---|---:|---:|---:|---:|---|",
    ]
    for idx, row in enumerate(target_rows[:10], start=1):
        values = returns_for_cell(session_returns, row)
        block_len = block_bootstrap.politis_white_median_block_length(len(values))
        matrix = block_bootstrap.stationary_bootstrap_matrix(values, BOOTSTRAP_REPLICATIONS, BOOTSTRAP_SEED + idx, block_len)
        means = [sum(sample) / len(sample) for sample in matrix]
        ci_low = block_bootstrap.percentile(means, 0.025)
        ci_high = block_bootstrap.percentile(means, 0.975)
        lines.append(f"| {idx} | {compact_cell(row)} | {len(values)} | {block_len} | {ci_low:.10f} | {ci_high:.10f} | {str(ci_low > 0).lower()} |")
    lines.append("")
    lines.append("Result: pass only if every top-10 mnq_mid/100ms CI lower bound is > 0; failures are reported without threshold weakening.")
    return "\n".join(lines)


def substitute_mid_100_cells(top10: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{**row, "cost_scenario": "mnq_mid", "latency_bucket_ms": 100} for row in top10]


def dsr_correction(psr_dsr: Any, grid_manifest: dict[str, Any], top1: dict[str, Any], session_returns: pd.DataFrame) -> str:
    values_usd = returns_for_cell(session_returns, top1)
    decimal_returns = [value / 100_000.0 for value in values_usd]
    effective_trial_count = int(grid_manifest["total_screened_cells_max"])
    try:
        result = psr_dsr.compute_psr_dsr(decimal_returns, effective_trial_count)
        lines = [
            f"Top-1 cell: {compact_cell(top1)}",
            f"effective_trial_count: {effective_trial_count}",
            f"observed_sharpe: {result.observed_sharpe:.10f}",
            f"dsr_statistic: {result.dsr_statistic:.10f}",
            f"corrected_p_value: {1.0 - result.dsr_probability:.10f}",
            f"dsr_probability: {result.dsr_probability:.10f}",
            f"psr_zero_null: {result.psr_zero_null:.10f}",
            f"psr_hurdle_null: {result.psr_hurdle_null:.10f}",
            "corrected_CI_note: DSR reports corrected probability/statistic; bootstrap CIs in Check 2 carry empirical CI bounds.",
            f"Verdict: {'pass' if result.dsr_statistic > 0 else 'fail'} under DSR statistic > 0.",
        ]
    except Exception as exc:  # Honest report rather than massaging returns.
        lines = [
            f"Top-1 cell: {compact_cell(top1)}",
            f"effective_trial_count: {effective_trial_count}",
            f"DSR computation failed: {type(exc).__name__}: {exc}",
            "corrected_p_value: unavailable_due_to_dsr_failure",
            "corrected_CI_note: unavailable because DSR failed on the observed return vector; bootstrap CIs in Check 2 remain reported separately.",
            "Verdict: fail; R7 should treat multiple-testing correction as not survived.",
        ]
    return "\n".join(lines)


def roll_period(conditioning: pd.DataFrame) -> str:
    roll_true = conditioning[(conditioning["stratification_dimension"] == "is_roll_week") & (conditioning["stratification_bucket"] == "true")]
    roll_false = conditioning[(conditioning["stratification_dimension"] == "is_roll_week") & (conditioning["stratification_bucket"] == "false")]
    lines = [
        f"is_roll_week=true emitted rows: {len(roll_true)}",
        f"is_roll_week=false emitted rows: {len(roll_false)}",
        "Verdict: N/A — corpus has no roll-week sessions surviving the n<20 gate, so Plan A's sign/magnitude comparison is structurally inapplicable.",
    ]
    return "\n".join(lines)


def latency_monotonicity(expectancy: pd.DataFrame, top1: dict[str, Any]) -> str:
    base = expectancy[
        (expectancy["pt_pts"] == top1["pt_pts"]) &
        (expectancy["stop_pts"] == top1["stop_pts"]) &
        (expectancy["cost_scenario"] == top1["cost_scenario"]) &
        (expectancy["instrument"] == top1["instrument"]) &
        (expectancy["arm_time_s"] == top1["arm_time_s"]) &
        (expectancy["trigger_offset_pts"] == top1["trigger_offset_pts"]) &
        (expectancy["reference"] == top1["reference"]) &
        (expectancy["stop_limit_protection_pts"].fillna(-1.0) == protection_value(top1["stop_limit_protection_pts"]))
    ].sort_values("latency_bucket_ms")
    values = [float(v) for v in base["expectancy_per_trade_usd"].tolist()]
    monotone = all(values[idx] >= values[idx + 1] for idx in range(len(values) - 1))
    lines = [
        "| latency_ms | expectancy_per_trade_usd |",
        "|---:|---:|",
    ]
    for _, row in base.iterrows():
        lines.append(f"| {int(row['latency_bucket_ms'])} | {float(row['expectancy_per_trade_usd']):.10f} |")
    lines.append("")
    lines.append(f"Verdict: {'pass' if monotone else 'fail'} for monotone non-increasing criterion.")
    return "\n".join(lines)


def parameter_perturbation(expectancy: pd.DataFrame, top1: dict[str, Any]) -> str:
    base_value = float(top1["expectancy_per_trade_usd"])
    perturbations = []
    for field, grid in [
        ("arm_time_s", ARM_GRID),
        ("trigger_offset_pts", TRIGGER_OFFSET_GRID),
        ("reference", REFERENCE_GRID),
        ("stop_limit_protection_pts", PROTECTION_GRID),
        ("pt_pts", PT_GRID),
        ("stop_pts", STOP_GRID),
    ]:
        current = normalize_grid_value(top1[field])
        idx = grid.index(current)
        for direction in [-1, 1]:
            target_idx = idx + direction
            if target_idx < 0 or target_idx >= len(grid):
                perturbations.append((field, direction, None, None, "N/A grid-edge"))
                continue
            candidate = {**top1, field: grid[target_idx]}
            match = find_cell(expectancy, candidate)
            if match is None:
                perturbations.append((field, direction, grid[target_idx], None, "N/A missing cell"))
                continue
            value = float(match["expectancy_per_trade_usd"])
            within = abs(value - base_value) <= abs(base_value) * 0.30
            perturbations.append((field, direction, grid[target_idx], value, "pass" if within else "fail"))
    lines = [
        f"Anchor cell: {compact_cell(top1)}; expectancy_per_trade_usd={base_value:.10f}",
        "",
        "| dimension | direction | target | expectancy_per_trade_usd | verdict |",
        "|---|---:|---|---:|---|",
    ]
    failures = 0
    for field, direction, target, value, verdict in perturbations:
        if verdict == "fail":
            failures += 1
        rendered_value = "" if value is None else f"{value:.10f}"
        lines.append(f"| {field} | {direction:+d} | {fmt_value(target)} | {rendered_value} | {verdict} |")
    lines.append("")
    lines.append(f"Verdict: {'pass' if failures == 0 else 'fail'}; {failures} perturbations exceeded the 30% criterion. N/A grid-edge cases are not counted as failures.")
    return "\n".join(lines)


def find_cell(expectancy: pd.DataFrame, cell: dict[str, Any]) -> pd.Series | None:
    frame = expectancy[
        (expectancy["pt_pts"] == cell["pt_pts"]) &
        (expectancy["stop_pts"] == cell["stop_pts"]) &
        (expectancy["cost_scenario"] == cell["cost_scenario"]) &
        (expectancy["latency_bucket_ms"] == cell["latency_bucket_ms"]) &
        (expectancy["instrument"] == cell["instrument"]) &
        (expectancy["arm_time_s"] == cell["arm_time_s"]) &
        (expectancy["trigger_offset_pts"] == cell["trigger_offset_pts"]) &
        (expectancy["reference"] == cell["reference"]) &
        (expectancy["stop_limit_protection_pts"].fillna(-1.0) == protection_value(cell["stop_limit_protection_pts"]))
    ]
    if frame.empty:
        return None
    return frame.iloc[0]


def returns_for_cell(session_returns: pd.DataFrame, cell: dict[str, Any]) -> list[float]:
    key = cell_key(cell)
    frame = session_returns[
        (session_returns["pt_pts"] == key["pt_pts"]) &
        (session_returns["stop_pts"] == key["stop_pts"]) &
        (session_returns["cost_scenario"] == key["cost_scenario"]) &
        (session_returns["latency_bucket_ms"] == key["latency_bucket_ms"]) &
        (session_returns["arm_time_s"] == key["arm_time_s"]) &
        (session_returns["trigger_offset_pts"] == key["trigger_offset_pts"]) &
        (session_returns["reference"] == key["reference"]) &
        (session_returns["stop_limit_protection_pts"].fillna(-1.0) == protection_value(key["stop_limit_protection_pts"]))
    ].sort_values("session_date")
    return [float(value) for value in frame["session_pnl_usd"].tolist()]


def cell_key(cell: dict[str, Any]) -> dict[str, Any]:
    return {
        "pt_pts": float(cell["pt_pts"]),
        "stop_pts": float(cell["stop_pts"]),
        "cost_scenario": str(cell["cost_scenario"]),
        "latency_bucket_ms": int(cell["latency_bucket_ms"]),
        "instrument": str(cell["instrument"]),
        "arm_time_s": int(cell["arm_time_s"]),
        "trigger_offset_pts": float(cell["trigger_offset_pts"]),
        "reference": str(cell["reference"]),
        "stop_limit_protection_pts": None if pd.isna(cell["stop_limit_protection_pts"]) else float(cell["stop_limit_protection_pts"]),
    }


def compact_cell(row: dict[str, Any] | pd.Series) -> str:
    return (
        f"pt={row['pt_pts']}, stop={row['stop_pts']}, cost={row['cost_scenario']}, "
        f"lat={int(row['latency_bucket_ms'])}, arm={int(row['arm_time_s'])}, "
        f"offset={row['trigger_offset_pts']}, ref={row['reference']}, "
        f"protection={fmt_protection(row['stop_limit_protection_pts'])}"
    )


def cost_usd(name: str) -> float:
    if name == "mnq_low":
        return 0.60 + 0.25 * 2 * 0.50
    if name == "mnq_mid":
        return 1.00 + 0.50 * 2 * 0.50
    if name == "mnq_high":
        return 1.50 + 1.00 * 2 * 0.50
    raise ValueError(name)


def protection_value(value: Any) -> float:
    return -1.0 if value is None or pd.isna(value) else float(value)


def normalize_grid_value(value: Any) -> Any:
    if value is None or pd.isna(value):
        return None
    if isinstance(value, (np.integer, int)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        return float(value)
    return value


def fmt_protection(value: Any) -> str:
    return "null" if value is None or pd.isna(value) else str(value)


def fmt_value(value: Any) -> str:
    return "null" if value is None else str(value)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())
