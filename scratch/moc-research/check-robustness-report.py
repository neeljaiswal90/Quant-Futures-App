#!/usr/bin/env python3
"""Verify MOC-R6 robustness report structure and determinism hooks."""

from __future__ import annotations

import argparse
import csv
import hashlib
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MOC_ROOT = REPO_ROOT / "scratch/moc-research"
BACKLOG_PATH = REPO_ROOT / "docs/plan/new_app_v1_ticket_backlog_v6.csv"
REPORT_PATH = MOC_ROOT / "robustness-report.md"
EXPECTED_ROW = [
    "MOC-R6",
    "P2",
    "2.0",
    "MOC-R5",
    "Robustness suite + multiple-testing correction: walk-forward stability + block-bootstrap CIs + SPA/Reality-Check/DSR (Codex picks one) + roll-period stratification + latency monotonicity + parameter-perturbation; emits robustness-report.md",
    "new_in_v6_appendix_a",
]
REQUIRED_SECTIONS = [
    "## Preamble: inputs, loader, and top-K cells",
    "## Check 1: Walk-forward stability",
    "## Check 2: Block-bootstrap on event days",
    "## Check 3: Multiple-testing correction",
    "## Check 4: Roll-period stratification",
    "## Check 5: Latency monotonicity",
    "## Check 6: Parameter perturbation",
    "## Implications for R7",
]


def main() -> int:
    args = parse_args()
    text = REPORT_PATH.read_text(encoding="utf-8")
    verify_backlog_row()
    verify_sections(text)
    verify_top_k(text)
    verify_walk_forward(text)
    verify_bootstrap(text)
    verify_dsr(text)
    verify_roll_period(text)
    verify_latency(text)
    verify_parameter_perturbation(text)
    verify_anti_near_miss(text)
    verify_loader_note(text)
    if args.compare_dir:
        compare_hash(REPORT_PATH, Path(args.compare_dir) / "robustness-report.md")
    print("MOC-R6 robustness report checks passed")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--compare-dir", default=None)
    return parser.parse_args()


def verify_backlog_row() -> None:
    text = BACKLOG_PATH.read_text(encoding="utf-8")
    if not text.endswith("\n"):
        raise AssertionError("backlog CSV must end with LF")
    rows = list(csv.reader(text.splitlines()))
    if any(len(row) != 6 for row in rows):
        raise AssertionError("every backlog row must have 6 columns")
    moc = [row for row in rows if row and row[0] == "MOC-R6"]
    if moc != [EXPECTED_ROW]:
        raise AssertionError(f"MOC-R6 backlog row mismatch: {moc}")


def verify_sections(text: str) -> None:
    for section in REQUIRED_SECTIONS:
        if section not in text:
            raise AssertionError(f"missing report section: {section}")


def verify_top_k(text: str) -> None:
    preamble = text.split("## Check 1:", 1)[0]
    lines = [line for line in preamble.splitlines() if line.startswith("| ") and not line.startswith("| rank") and not line.startswith("|---")]
    if len(lines) != 10:
        raise AssertionError(f"expected 10 top-K rows, found {len(lines)}")
    for line in lines:
        if line.count("|") < 24:
            raise AssertionError("top-K row does not cite all expected fields")


def verify_walk_forward(text: str) -> None:
    section = between(text, "## Check 1:", "## Check 2:")
    if "six equal-time folds" not in section or "indicative only" not in section:
        raise AssertionError("walk-forward adaptation not documented")
    fold_lines = [line for line in section.splitlines() if re.match(r"^\| [1-6] \|", line)]
    if len(fold_lines) != 6:
        raise AssertionError("expected six walk-forward fold rows")
    if "n<20" not in section:
        raise AssertionError("walk-forward n<20 caveat missing")


def verify_bootstrap(text: str) -> None:
    section = between(text, "## Check 2:", "## Check 3:")
    if "10,000 replications" not in section or "deterministic seed" not in section:
        raise AssertionError("bootstrap deterministic configuration missing")
    rows = [line for line in section.splitlines() if re.match(r"^\| [0-9]+ \|", line)]
    if not rows:
        raise AssertionError("bootstrap CI rows missing")
    if "ci_low" not in section or "ci_high" not in section:
        raise AssertionError("bootstrap CI bounds missing")


def verify_dsr(text: str) -> None:
    section = between(text, "## Check 3:", "## Check 4:")
    required = ["Deflated Sharpe Ratio", "effective_trial_count: 90720", "corrected_p_value", "corrected_CI_note"]
    for item in required:
        if item not in section:
            raise AssertionError(f"DSR section missing {item}")


def verify_roll_period(text: str) -> None:
    section = between(text, "## Check 4:", "## Check 5:")
    if "N/A" not in section or "no roll-week" not in section:
        raise AssertionError("roll-period N/A rationale missing")


def verify_latency(text: str) -> None:
    section = between(text, "## Check 5:", "## Check 6:")
    for latency in ["0", "100", "500", "1000"]:
        if f"| {latency} |" not in section:
            raise AssertionError(f"latency {latency} missing")
    if "Verdict:" not in section:
        raise AssertionError("latency verdict missing")


def verify_parameter_perturbation(text: str) -> None:
    section = between(text, "## Check 6:", "## Implications for R7")
    rows = [line for line in section.splitlines() if re.match(r"^\| [a-z_]+", line)]
    if len(rows) < 12:
        raise AssertionError("parameter perturbation rows missing")
    if "30%" not in section:
        raise AssertionError("parameter perturbation threshold missing")


def verify_anti_near_miss(text: str) -> None:
    if "does not attempt to engineer a FULL-GO outcome" not in text:
        raise AssertionError("anti-near-miss language missing")
    if "RESEARCH-GO/NEEDS-NQ" not in text:
        raise AssertionError("R7 implication language missing")


def verify_loader_note(text: str) -> None:
    required = ["spec_from_file_location", "sys.path.insert", "sys.modules[name] = mod", "Production modules remain"]
    for item in required:
        if item not in text:
            raise AssertionError(f"loader note missing {item}")


def between(text: str, start: str, end: str) -> str:
    return text.split(start, 1)[1].split(end, 1)[0]


def compare_hash(left: Path, right: Path) -> None:
    left_hash = hashlib.sha256(left.read_bytes()).hexdigest()
    right_hash = hashlib.sha256(right.read_bytes()).hexdigest()
    if left_hash != right_hash:
        raise AssertionError(f"hash mismatch: {left_hash} != {right_hash}")


if __name__ == "__main__":
    raise SystemExit(main())
