from __future__ import annotations

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

LIB_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LIB_DIR))

from sensitivity_audit import FidelityCell, compute_sensitivity_audit
from walk_forward_loader import load_held_out_artifact


def cell(
    regime: str,
    spread_bucket: str,
    queue_ahead_bucket: str,
    share_ppm: int,
    probe_count: int = 100,
) -> FidelityCell:
    return FidelityCell(
        regime=regime,
        spread_bucket=spread_bucket,
        queue_ahead_bucket=queue_ahead_bucket,
        share_ppm=share_ppm,
        probe_count=probe_count,
        within_tolerance_count=(share_ppm * probe_count) // 1_000_000,
    )


def trades(count: int, key: tuple[str, str, str]) -> list[dict[str, str]]:
    regime, spread_bucket, queue_ahead_bucket = key
    return [
        {
            "regime": regime,
            "spread_bucket": spread_bucket,
            "queue_ahead_bucket": queue_ahead_bucket,
        }
        for _ in range(count)
    ]


class Qfa611SensitivityAuditTests(unittest.TestCase):
    def test_low_fidelity_concentration_flags_at_35_percent(self) -> None:
        low = ("high", "1-tick", "21+")
        clean = ("high", "1-tick", "1-5")
        cells = {
            low: cell(*low, share_ppm=700_000),
            clean: cell(*clean, share_ppm=936_000),
        }
        result = compute_sensitivity_audit(trades(7, low) + trades(13, clean), cells)
        self.assertTrue(result["flag"])
        self.assertEqual(result["reason"], "low_fidelity_concentration")
        self.assertAlmostEqual(result["low_fidelity_trade_fraction"], 0.35)

    def test_low_fidelity_concentration_does_not_flag_at_25_percent(self) -> None:
        low = ("high", "2-tick", "21+")
        clean = ("high", "2-tick", "6-20")
        cells = {
            low: cell(*low, share_ppm=700_000),
            clean: cell(*clean, share_ppm=870_000),
        }
        result = compute_sensitivity_audit(trades(5, low) + trades(15, clean), cells)
        self.assertFalse(result["flag"])
        self.assertEqual(result["reason"], "clean")

    def test_zero_probe_cells_are_unknown_and_flag_at_35_percent(self) -> None:
        unknown = ("mid", "1-tick", "1-5")
        clean = ("high", "1-tick", "1-5")
        cells = {
            unknown: cell(*unknown, share_ppm=0, probe_count=0),
            clean: cell(*clean, share_ppm=936_000),
        }
        result = compute_sensitivity_audit(trades(7, unknown) + trades(13, clean), cells)
        self.assertTrue(result["flag"])
        self.assertEqual(result["reason"], "missing_cell_concentration")
        self.assertAlmostEqual(result["unknown_cell_trade_fraction"], 0.35)

    def test_unknown_cells_do_not_flag_at_25_percent(self) -> None:
        unknown = ("low", "3+ ticks", "21+")
        clean = ("high", "1-tick", "1-5")
        cells = {clean: cell(*clean, share_ppm=936_000)}
        result = compute_sensitivity_audit(trades(5, unknown) + trades(15, clean), cells)
        self.assertFalse(result["flag"])
        self.assertEqual(result["reason"], "clean")


class Qfa611WalkForwardLoaderTests(unittest.TestCase):
    def test_loader_accepts_net_artifact_with_matching_lock_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_path, manifest_path = write_artifact_pair(Path(tmp))
            artifact = load_held_out_artifact(artifact_path, manifest_path)
            self.assertEqual(artifact["gating_pnl_basis"], "net")

    def test_loader_rejects_gross_gating_basis(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_path, manifest_path = write_artifact_pair(Path(tmp), gating_pnl_basis="gross")
            with self.assertRaisesRegex(ValueError, "gating_pnl_basis"):
                load_held_out_artifact(artifact_path, manifest_path)

    def test_loader_rejects_parameter_lock_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_path, manifest_path = write_artifact_pair(Path(tmp), manifest_hash="f" * 64)
            with self.assertRaisesRegex(ValueError, "parameter_lock_hash mismatch"):
                load_held_out_artifact(artifact_path, manifest_path)


def write_artifact_pair(
    tmp: Path,
    *,
    gating_pnl_basis: str = "net",
    artifact_hash: str = "e" * 64,
    manifest_hash: str = "e" * 64,
) -> tuple[Path, Path]:
    fixture_path = Path(__file__).resolve().parents[4] / "apps" / "backtester" / "tests" / "fixtures" / "qfa410-fixture.json"
    artifact = json.loads(fixture_path.read_text(encoding="utf-8"))
    artifact = copy.deepcopy(artifact)
    artifact["gating_pnl_basis"] = gating_pnl_basis
    artifact["parameter_lock_hash"] = artifact_hash
    artifact_path = tmp / "artifact.json"
    artifact_path.write_text(json.dumps(artifact, sort_keys=True), encoding="utf-8")

    manifest = {
        "schema_version": 1,
        "strategies": [
            {
                "strategy_id": artifact["strategy_id"],
                "parameter_lock_hash": manifest_hash,
            }
        ],
    }
    manifest_path = tmp / "lock-manifest.json"
    manifest_path.write_text(json.dumps(manifest, sort_keys=True), encoding="utf-8")
    return artifact_path, manifest_path


if __name__ == "__main__":
    unittest.main()
