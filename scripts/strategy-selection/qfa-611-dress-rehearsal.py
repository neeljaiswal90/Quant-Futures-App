#!/usr/bin/env python3
"""QFA-611 G1 dress rehearsal runner.

Runs the production QFA-611 driver against a synthetic verdict cohort and
compares the deterministic outputs to frozen expected fixtures.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Sequence

REPO_ROOT = Path(__file__).resolve().parents[2]
DRIVER = REPO_ROOT / "scripts" / "strategy-selection" / "qfa-611-strategy-selection.py"
FIXTURE_DIR = REPO_ROOT / "apps" / "backtester" / "tests" / "fixtures" / "qfa611-dress-rehearsal"
EXPECTED_DIR = FIXTURE_DIR / "expected"
OUTPUT_DIR = REPO_ROOT / ".tmp" / "qfa611-dress-rehearsal"
REGIME_LABELS = REPO_ROOT / "artifacts" / "regime" / "regime-labels.json"
FIDELITY = REPO_ROOT / "artifacts" / "regime-fidelity" / "qfa-402c-stratified-cells-v1.json"
LOCK_MANIFEST = FIXTURE_DIR / "lock-manifest.json"

RUN_3_STRATEGIES = [
    "dress_rehearsal_advance",
    "dress_rehearsal_reject",
    "dress_rehearsal_research",
]
RUN_4_STRATEGIES = RUN_3_STRATEGIES + ["dress_rehearsal_incomplete"]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run_driver(name: str, strategy_ids: Sequence[str]) -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    json_out = OUTPUT_DIR / f"{name}.json"
    md_out = OUTPUT_DIR / f"{name}.md"
    subprocess.run(
        [
            sys.executable,
            str(DRIVER),
            "--held-out-dir",
            str(FIXTURE_DIR),
            "--regime-labels",
            str(REGIME_LABELS),
            "--fidelity",
            str(FIDELITY),
            "--lock-manifest",
            str(LOCK_MANIFEST),
            "--bootstrap-seed",
            "42",
            "--json-out",
            str(json_out),
            "--md-out",
            str(md_out),
            "--strategy-ids",
            *strategy_ids,
            "--skip-runtime-parameter-hash",
        ],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json_out


def assert_expected(name: str, actual_path: Path) -> dict:
    expected_path = EXPECTED_DIR / f"{name}.json"
    actual_bytes = actual_path.read_bytes()
    expected_bytes = expected_path.read_bytes()
    if actual_bytes != expected_bytes:
        actual = json.loads(actual_bytes.decode("utf-8"))
        expected = json.loads(expected_bytes.decode("utf-8"))
        print(
            json.dumps(
                {
                    "error": "dress_rehearsal_expected_mismatch",
                    "run": name,
                    "actual_summary": actual.get("summary"),
                    "expected_summary": expected.get("summary"),
                    "actual_run_status": actual.get("run_status"),
                    "expected_run_status": expected.get("run_status"),
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        raise SystemExit(1)
    return json.loads(actual_bytes.decode("utf-8"))


def main() -> int:
    run3_path = run_driver("run-3strat", RUN_3_STRATEGIES)
    run4_path = run_driver("run-4strat", RUN_4_STRATEGIES)
    run3 = assert_expected("run-3strat", run3_path)
    run4 = assert_expected("run-4strat", run4_path)
    print(
        json.dumps(
            {
                "status": "pass",
                "run_3strat_sha256": sha256_bytes(run3_path.read_bytes()),
                "run_4strat_sha256": sha256_bytes(run4_path.read_bytes()),
                "run_3strat_summary": run3["summary"],
                "run_4strat_summary": run4["summary"],
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
