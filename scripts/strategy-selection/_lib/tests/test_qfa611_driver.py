from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
DRIVER = REPO_ROOT / "scripts" / "strategy-selection" / "qfa-611-strategy-selection.py"
FIXTURE = REPO_ROOT / "apps" / "backtester" / "tests" / "fixtures" / "qfa410-fixture.json"
FIDELITY = REPO_ROOT / "artifacts" / "regime-fidelity" / "qfa-402c-stratified-cells-v1.json"
REGIME_LABELS = REPO_ROOT / "artifacts" / "regime" / "regime-labels.json"
STRATEGIES = [
    "trend_pullback_long",
    "trend_pullback_short",
    "breakout_retest_long",
    "breakdown_retest_short",
]


class Qfa611DriverTests(unittest.TestCase):
    def test_complete_threshold_failure_is_reject_and_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            held_out_dir, lock_manifest = write_case(root)
            first = run_driver(root, held_out_dir, lock_manifest, seed=42)
            first_bytes = first.read_bytes()
            second = run_driver(root, held_out_dir, lock_manifest, seed=42)
            self.assertEqual(first_bytes, second.read_bytes())
            third = run_driver(root, held_out_dir, lock_manifest, seed=43)
            self.assertNotEqual(first_bytes, third.read_bytes())

            selection = json.loads(first.read_text(encoding="utf-8"))
            self.assertEqual(selection["run_status"], "complete")
            self.assertFalse(selection["summary"]["phase_6_dispatch_authorized"])
            self.assertEqual(selection["summary"]["reject_count"], 4)
            self.assertEqual(selection["summary"]["research_further_count"], 0)
            self.assertTrue(all(item["verdict"] == "REJECT" for item in selection["per_strategy"]))
            self.assertIn("annualized_sharpe", selection["per_strategy"][0]["held_out_evidence"])
            self.assertIn("hac_standard_error_of_mean", selection["per_strategy"][0]["held_out_evidence"])
            self.assertIn("hac_t_stat", selection["per_strategy"][0]["held_out_evidence"])
            self.assertIn("dsr_statistic", selection["per_strategy"][0]["held_out_evidence"])
            self.assertIn("dsr_probability", selection["per_strategy"][0]["held_out_evidence"])
            self.assertIn("psr_zero_null", selection["per_strategy"][0]["held_out_evidence"])
            self.assertIn("psr_hurdle_null", selection["per_strategy"][0]["held_out_evidence"])

    def test_gross_pnl_basis_is_research_further_not_reject(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            held_out_dir, lock_manifest = write_case(root, mutate=lambda artifact, index: artifact.update({"gating_pnl_basis": "gross"}) if index == 0 else None)
            selection = json.loads(run_driver(root, held_out_dir, lock_manifest).read_text(encoding="utf-8"))
            first = selection["per_strategy"][0]
            self.assertEqual(first["verdict"], "RESEARCH_FURTHER")
            self.assertEqual(first["evidence_package_status"], "incomplete")
            self.assertEqual(first["verdict_reason"], "missing_or_wrong_pnl_basis")
            self.assertEqual(selection["run_status"], "partial_evidence")
            self.assertFalse(selection["summary"]["phase_6_dispatch_authorized"])

    def test_lock_hash_mismatch_is_research_further_not_reject(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            held_out_dir, lock_manifest = write_case(root, manifest_hash_for_first="f" * 64)
            selection = json.loads(run_driver(root, held_out_dir, lock_manifest).read_text(encoding="utf-8"))
            first = selection["per_strategy"][0]
            self.assertEqual(first["verdict"], "RESEARCH_FURTHER")
            self.assertEqual(first["verdict_reason"], "parameter_lock_violation")

    def test_runtime_parameter_hash_mismatch_is_research_further_not_reject(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            held_out_dir, lock_manifest = write_case(root)
            selection = json.loads(
                run_driver(root, held_out_dir, lock_manifest, skip_runtime_parameter_hash=False).read_text(
                    encoding="utf-8"
                )
            )
            first = selection["per_strategy"][0]
            self.assertEqual(first["verdict"], "RESEARCH_FURTHER")
            self.assertEqual(first["verdict_reason"], "parameter_lock_violation")

    def test_missing_trade_metadata_is_research_further_not_reject(self) -> None:
        def mutate(artifact: dict, index: int) -> None:
            if index == 0:
                del artifact["trades"][0]["queue_ahead_bucket"]

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            held_out_dir, lock_manifest = write_case(root, mutate=mutate)
            selection = json.loads(run_driver(root, held_out_dir, lock_manifest).read_text(encoding="utf-8"))
            first = selection["per_strategy"][0]
            self.assertEqual(first["verdict"], "RESEARCH_FURTHER")
            self.assertEqual(first["verdict_reason"], "missing_per_trade_metadata")


def write_case(
    root: Path,
    *,
    mutate=None,
    manifest_hash_for_first: str | None = None,
) -> tuple[Path, Path]:
    held_out_dir = root / "held-out"
    held_out_dir.mkdir()
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    strategies = []
    for index, strategy_id in enumerate(STRATEGIES):
        artifact = copy.deepcopy(fixture)
        lock_hash = f"{index + 1:064x}"
        artifact["strategy_id"] = strategy_id
        artifact["parameter_lock_hash"] = lock_hash
        artifact["strategy_fingerprint_sha256"] = f"{index + 11:064x}"
        artifact["windows"][0]["strategy_id"] = strategy_id
        artifact["windows"][0]["fingerprint_sha256"] = artifact["strategy_fingerprint_sha256"]
        if mutate is not None:
            mutate(artifact, index)
        (held_out_dir / f"{strategy_id}-feb-mar-apr-2026.json").write_text(
            json.dumps(artifact, sort_keys=True),
            encoding="utf-8",
        )
        strategies.append({
            "strategy_id": strategy_id,
            "parameter_lock_hash": manifest_hash_for_first if index == 0 and manifest_hash_for_first else lock_hash,
        })
    manifest = {
        "schema_version": 1,
        "cycle_id": "qfa611-cycle1-test",
        "strategies": strategies,
    }
    lock_manifest = root / "lock-manifest.json"
    lock_manifest.write_text(json.dumps(manifest, sort_keys=True), encoding="utf-8")
    return held_out_dir, lock_manifest


def run_driver(
    root: Path,
    held_out_dir: Path,
    lock_manifest: Path,
    seed: int = 42,
    skip_runtime_parameter_hash: bool = True,
) -> Path:
    json_out = root / f"selection-{seed}.json"
    md_out = root / f"selection-{seed}.md"
    command = [
        sys.executable,
        str(DRIVER),
        "--held-out-dir",
        str(held_out_dir),
        "--regime-labels",
        str(REGIME_LABELS),
        "--fidelity",
        str(FIDELITY),
        "--lock-manifest",
        str(lock_manifest),
        "--bootstrap-seed",
        str(seed),
        "--json-out",
        str(json_out),
        "--md-out",
        str(md_out),
        "--strategy-ids",
        *STRATEGIES,
    ]
    if skip_runtime_parameter_hash:
        command.append("--skip-runtime-parameter-hash")
    subprocess.run(command, cwd=REPO_ROOT, check=True, capture_output=True, text=True)
    return json_out


if __name__ == "__main__":
    unittest.main()
