#!/usr/bin/env python3
"""Verify MOC-R7 descriptive report."""

from __future__ import annotations

import argparse
import csv
import hashlib
import math
import re
from pathlib import Path

import pyarrow.parquet as pq

REPO = Path(__file__).resolve().parents[2]
MOC = REPO / "scratch/moc-research"
REPORT = REPO / "docs/research/moc-family-a-descriptive-report.md"
BACKLOG = REPO / "docs/plan/new_app_v1_ticket_backlog_v6.csv"
EXPECTED_ROW = [
    "MOC-R7",
    "P2",
    "1.5",
    "MOC-R6",
    "Plan A three-state verdict synthesis: descriptive research memo + mathematical sample-power gate + top-3 candidate parameter-lock baselines + verdict (FULL-GO/RESEARCH-GO+NEEDS-NQ/NO-GO); aggregates R1-R6 outputs; emits docs/research/moc-family-a-descriptive-report.md",
    "new_in_v6_appendix_a",
]
SECTIONS = [
    "## 1. Executive summary",
    "## 2. Event definition + corpus inventory",
    "## 3. Family taxonomy reminder",
    "## 4. Eight descriptive tables",
    "## 5. Conditioning section",
    "## 6. Robustness verdict",
    "## 7. Top-3 candidate parameter-lock baselines",
    "## 8. Mathematical sample-power gate",
    "## 9. Three-state verdict",
    "## 10. Risks & open questions",
]
ARTIFACTS = [
    "event-day-manifest.json",
    "event-paths-methodology.md",
    "event-aggregates.parquet",
    "event-stream.sha256.txt",
    "triggered-events.parquet",
    "triggered-events-methodology.md",
    "expectancy-tables.parquet",
    "expectancy-tables-methodology.md",
    "research-grid-manifest.json",
    "conditioning-tables.parquet",
    "conditioning-summary.md",
    "robustness-report.md",
]


def main() -> int:
    args = parse_args()
    text = REPORT.read_text(encoding="utf-8")
    verify_backlog()
    verify_sections(text)
    verify_family_taxonomy(text)
    verify_shas(text)
    verify_descriptive_tables(text)
    verify_sample_power(text)
    verify_verdict(text)
    verify_anti_near_miss(text)
    if args.compare_file:
        compare_hash(REPORT, Path(args.compare_file))
    print("MOC-R7 descriptive report checks passed")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--compare-file", default=None)
    return parser.parse_args()


def verify_backlog() -> None:
    text = BACKLOG.read_text(encoding="utf-8")
    if not text.endswith("\n"):
        raise AssertionError("backlog CSV must end with LF")
    rows = list(csv.reader(text.splitlines()))
    if any(len(row) != 6 for row in rows):
        raise AssertionError("all backlog rows must have 6 columns")
    found = [row for row in rows if row and row[0] == "MOC-R7"]
    if found != [EXPECTED_ROW]:
        raise AssertionError(f"MOC-R7 backlog row mismatch: {found}")


def verify_sections(text: str) -> None:
    for section in SECTIONS:
        if section not in text:
            raise AssertionError(f"missing section {section}")


def verify_family_taxonomy(text: str) -> None:
    required = "Family A breakout-capture verdict only. This report does NOT claim directional MOC prediction."
    if required not in text or "Predictive strategies (Family C)" not in text:
        raise AssertionError("family taxonomy reminder missing")


def verify_shas(text: str) -> None:
    for name in ARTIFACTS:
        digest = hashlib.sha256((MOC / name).read_bytes()).hexdigest()
        if digest not in text:
            raise AssertionError(f"SHA for {name} missing")


def verify_descriptive_tables(text: str) -> None:
    section = between(text, "## 4. Eight descriptive tables", "## 5. Conditioning section")
    for idx in range(1, 9):
        if f"### Table {idx}" not in section:
            raise AssertionError(f"descriptive table {idx} missing")


def verify_sample_power(text: str) -> None:
    exp = pq.read_table(MOC / "expectancy-tables.parquet").to_pandas()
    mid100 = exp[(exp.cost_scenario == "mnq_mid") & (exp.latency_bucket_ms == 100)].sort_values(
        ["expected_daily_pnl_usd", "pt_pts", "stop_pts", "arm_time_s", "trigger_offset_pts", "reference", "stop_limit_protection_pts"],
        ascending=[False, True, True, True, True, True, True],
        na_position="first",
    )
    observed = float(mid100.iloc[0]["trade_frequency_per_session"])
    required = math.ceil(300 / observed)
    section = between(text, "## 8. Mathematical sample-power gate", "## 9. Three-state verdict")
    if f"{observed:.10f}" not in section:
        raise AssertionError("observed_trades_per_session missing")
    if f"{required}" not in section:
        raise AssertionError("required_sessions missing")
    if "Sample-power gate verdict: **FAIL**" not in section:
        raise AssertionError("sample-power FAIL missing")


def verify_verdict(text: str) -> None:
    section = between(text, "## 9. Three-state verdict", "## 10. Risks & open questions")
    full_criteria = [
        "Primary expectancy >= $1.50 at mnq_mid/100ms",
        "Stress expectancy > $0 at mnq_high/500ms",
        "Hit rate p_pt_hit_before_stop >= 0.45",
        "Both-side false-trigger <= 0.20",
        "Stop-limit miss-rate <= 0.10",
        "Walk-forward stability >=4/6",
        "Bootstrap CI lower bound > 0",
        "Multiple-testing correction survives",
        "Parameter perturbation within 30% in all 12",
        "Latency monotonicity",
        "Trade frequency >=0.5 and required_sessions <= available",
        "NQ confirmation mandatory",
    ]
    nogo = [
        "expectancy_per_trade_usd < $0.50 at mnq_mid/100ms",
        "Bootstrap 95% CI lower bound <= 0",
        "Walk-forward stability actual fail",
        "Latency monotonicity fails",
        "Multiple-testing correction kills leading cell",
    ]
    for criterion in full_criteria + nogo:
        if criterion not in section:
            raise AssertionError(f"criterion missing: {criterion}")
    if "Verdict: **NO-GO**" not in text and "verdict is **NO-GO**" not in section:
        raise AssertionError("NO-GO verdict missing")
    if "NO-GO triggers fire" not in section:
        raise AssertionError("NO-GO trigger rationale missing")


def verify_anti_near_miss(text: str) -> None:
    required = [
        "NO-GO",
        "failed bootstrap",
        "failed DSR",
        "does not override failed bootstrap and failed DSR criteria",
        "not authorized for MOC-A1",
    ]
    for item in required:
        if item not in text:
            raise AssertionError(f"anti-near-miss/verdict language missing: {item}")


def between(text: str, start: str, end: str) -> str:
    return text.split(start, 1)[1].split(end, 1)[0]


def compare_hash(left: Path, right: Path) -> None:
    left_hash = hashlib.sha256(left.read_bytes()).hexdigest()
    right_hash = hashlib.sha256(right.read_bytes()).hexdigest()
    if left_hash != right_hash:
        raise AssertionError(f"hash mismatch: {left_hash} != {right_hash}")


if __name__ == "__main__":
    raise SystemExit(main())
