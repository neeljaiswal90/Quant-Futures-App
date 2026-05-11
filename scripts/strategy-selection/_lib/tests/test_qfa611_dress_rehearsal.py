from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
RUNNER = REPO_ROOT / "scripts" / "strategy-selection" / "qfa-611-dress-rehearsal.py"
OUTPUT_DIR = REPO_ROOT / ".tmp" / "qfa611-dress-rehearsal"
RUN_3 = OUTPUT_DIR / "run-3strat.json"
RUN_4 = OUTPUT_DIR / "run-4strat.json"


class Qfa611DressRehearsalTests(unittest.TestCase):
    def test_g1_dress_rehearsal_matches_frozen_expected_outputs(self) -> None:
        first = subprocess.run(
            [sys.executable, str(RUNNER)],
            cwd=REPO_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        run3_first = RUN_3.read_bytes()
        run4_first = RUN_4.read_bytes()

        run3 = json.loads(run3_first.decode("utf-8"))
        run4 = json.loads(run4_first.decode("utf-8"))
        self.assertEqual(run3["run_status"], "complete")
        self.assertTrue(run3["summary"]["phase_6_dispatch_authorized"])
        self.assertEqual(run3["summary"], {
            "advance_count": 1,
            "phase_6_dispatch_authorized": True,
            "reject_count": 1,
            "research_further_count": 1,
        })
        self.assertEqual(run4["run_status"], "partial_evidence")
        self.assertFalse(run4["summary"]["phase_6_dispatch_authorized"])
        self.assertEqual(run4["summary"], {
            "advance_count": 1,
            "phase_6_dispatch_authorized": False,
            "reject_count": 1,
            "research_further_count": 2,
        })

        second = subprocess.run(
            [sys.executable, str(RUNNER)],
            cwd=REPO_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertEqual(run3_first, RUN_3.read_bytes())
        self.assertEqual(run4_first, RUN_4.read_bytes())


if __name__ == "__main__":
    unittest.main()
