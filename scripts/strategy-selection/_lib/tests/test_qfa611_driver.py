from __future__ import annotations

import copy
import importlib.util
import json
import math
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
LIB_DIR = REPO_ROOT / "scripts" / "strategy-selection" / "_lib"
sys.path.insert(0, str(LIB_DIR))
STRATEGIES = [
    "trend_pullback_long",
    "trend_pullback_short",
    "breakout_retest_long",
    "breakdown_retest_short",
]
EMITTER = REPO_ROOT / "scripts" / "strategy-selection" / "qfa-611-emit-lock-manifest.py"


def load_driver_module():
    spec = importlib.util.spec_from_file_location("qfa611_strategy_selection", DRIVER)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load QFA-611 driver module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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
            self.assertFalse(selection["execution_fragility"])
            self.assertEqual(selection["execution_fragility_reasons"], [])

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

    def test_canonical_json_writes_lf_only_bytes(self) -> None:
        from artifact_writer import write_canonical_json

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "out.json"
            write_canonical_json({"b": 2, "a": [1, 2, 3]}, path)
            raw = path.read_bytes()
            self.assertNotIn(b"\r", raw)
            self.assertEqual(raw, b'{"a":[1,2,3],"b":2}\n')

    def test_canonicalize_floats_rounds_to_ten_decimals(self) -> None:
        from artifact_writer import canonicalize_floats

        self.assertEqual(canonicalize_floats(1.234567890123), 1.2345678901)
        self.assertEqual(canonicalize_floats(-1.234567890123), -1.2345678901)

    def test_canonicalize_floats_preserves_non_float_scalars(self) -> None:
        from artifact_writer import canonicalize_floats

        value = {"flag": True, "count": 3, "label": "alpha", "missing": None}
        self.assertEqual(canonicalize_floats(value), value)

    def test_canonicalize_floats_recurses_nested_values(self) -> None:
        from artifact_writer import canonicalize_floats

        value = {"outer": [1.234567890123, {"inner": (2.345678901234, False)}]}
        self.assertEqual(
            canonicalize_floats(value),
            {"outer": [1.2345678901, {"inner": (2.3456789012, False)}]},
        )

    def test_canonicalize_floats_rejects_non_finite_values(self) -> None:
        from artifact_writer import canonicalize_floats

        for value in (math.nan, math.inf, -math.inf):
            with self.assertRaises(ValueError):
                canonicalize_floats(value)

    def test_canonical_json_collapses_sub_rounding_float_drift(self) -> None:
        from artifact_writer import write_canonical_json

        with tempfile.TemporaryDirectory() as tmp:
            path_a = Path(tmp) / "a.json"
            path_b = Path(tmp) / "b.json"
            write_canonical_json({"sharpe": 1.234567890123 + 0.000000000001}, path_a)
            write_canonical_json({"sharpe": 1.234567890123 - 0.000000000001}, path_b)
            self.assertEqual(path_a.read_bytes(), path_b.read_bytes())
            self.assertEqual(path_a.read_bytes(), b'{"sharpe":1.2345678901}\n')
            self.assertNotIn(b"\r", path_a.read_bytes())

    def test_lf_text_writer_normalizes_trailing_newline(self) -> None:
        from artifact_writer import write_lf_text

        with tempfile.TemporaryDirectory() as tmp:
            path_a = Path(tmp) / "with_trailing.txt"
            path_b = Path(tmp) / "no_trailing.txt"
            write_lf_text("alpha\nbeta\n", path_a)
            write_lf_text("alpha\nbeta", path_b)
            self.assertEqual(path_a.read_bytes(), b"alpha\nbeta\n")
            self.assertEqual(path_b.read_bytes(), b"alpha\nbeta\n")
            self.assertNotIn(b"\r", path_a.read_bytes())
            self.assertNotIn(b"\r", path_b.read_bytes())

    def test_execution_fragility_true_when_any_complete_strategy_has_sensitivity_flag(self) -> None:
        driver = load_driver_module()
        result = driver.compute_execution_fragility([
            {
                "strategy_id": "alpha",
                "evidence_package_status": "complete",
                "sensitivity_audit": {"flag": True, "reason": "missing_cell_concentration"},
                "verdict_reason": "one_or_two_thresholds_failed_within_20pct",
            },
            {
                "strategy_id": "beta",
                "evidence_package_status": "complete",
                "sensitivity_audit": {"flag": False, "reason": "clean"},
                "verdict_reason": "all_stage1_thresholds_passed",
            },
        ])
        self.assertTrue(result["execution_fragility"])
        self.assertEqual(result["execution_fragility_reasons"], [
            "alpha:sensitivity_audit_flag:missing_cell_concentration",
        ])

    def test_execution_fragility_false_when_complete_strategies_are_clean(self) -> None:
        driver = load_driver_module()
        result = driver.compute_execution_fragility([
            {
                "strategy_id": "alpha",
                "evidence_package_status": "complete",
                "sensitivity_audit": {"flag": False, "reason": "clean"},
                "verdict_reason": "all_stage1_thresholds_passed",
            },
        ])
        self.assertFalse(result["execution_fragility"])
        self.assertEqual(result["execution_fragility_reasons"], [])

    def test_execution_fragility_skips_incomplete_entries(self) -> None:
        driver = load_driver_module()
        result = driver.compute_execution_fragility([
            {
                "strategy_id": "alpha",
                "evidence_package_status": "incomplete",
                "sensitivity_audit": {"flag": True, "reason": "missing_cell_concentration"},
                "verdict_reason": "missing_cell_concentration",
            },
        ])
        self.assertFalse(result["execution_fragility"])
        self.assertEqual(result["execution_fragility_reasons"], [])

    def test_execution_fragility_supports_forward_compatible_reason_markers(self) -> None:
        driver = load_driver_module()
        result = driver.compute_execution_fragility([
            {
                "strategy_id": "alpha",
                "evidence_package_status": "complete",
                "sensitivity_audit": {"flag": False, "reason": "clean"},
                "verdict_reason": "high_residual_cell_trade_fraction_exceeded",
            },
        ])
        self.assertTrue(result["execution_fragility"])
        self.assertEqual(result["execution_fragility_reasons"], [
            "alpha:verdict_reason:high_residual_cell_trade_fraction",
        ])
    def test_cycle1_lock_manifest_emitter_uses_shared_parameter_hash(self) -> None:
        from parameter_lock import PARAMETER_LOCK_ALGORITHM, compute_runtime_parameter_hash

        module = load_emitter_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_dir = root / "strategies"
            config_dir.mkdir()
            (config_dir / "alpha.yaml").write_text(
                "parameters:\n  threshold: 1.25\n  enabled: true\n",
                encoding="utf-8",
            )
            manifest = module.build_manifest(["alpha"], config_dir, "qfa611-cycle1-test")
            self.assertEqual(manifest["parameter_lock_algorithm"], PARAMETER_LOCK_ALGORITHM)
            self.assertEqual(manifest["cycle_id"], "qfa611-cycle1-test")
            self.assertEqual(
                manifest["strategies"],
                [{
                    "strategy_id": "alpha",
                    "parameter_lock_hash": compute_runtime_parameter_hash("alpha", config_dir),
                }],
            )

    def test_lock_manifest_emitter_accepts_explicit_cycle2_id(self) -> None:
        module = load_emitter_module()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_dir = root / "strategies"
            config_dir.mkdir()
            (config_dir / "beta.yaml").write_text(
                "parameters:\n  threshold: 2.5\n  enabled: true\n",
                encoding="utf-8",
            )
            manifest = module.build_manifest(["beta"], config_dir, "qfa611-cycle2-test")

        self.assertEqual(manifest["cycle_id"], "qfa611-cycle2-test")
        self.assertEqual(manifest["strategies"][0]["strategy_id"], "beta")


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


def load_emitter_module():
    spec = importlib.util.spec_from_file_location("qfa611_cycle1_emit_lock_manifest", EMITTER)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load {EMITTER}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


if __name__ == "__main__":
    unittest.main()
