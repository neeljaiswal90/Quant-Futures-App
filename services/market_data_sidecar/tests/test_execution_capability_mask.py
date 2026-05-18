"""Tests for the ADR-0018 execution capability mask mirror."""

from __future__ import annotations

import json
import subprocess
import sys
import unittest

from services.market_data_sidecar.execution.execution_capability_mask import (
    EXECUTION_CAPABILITY_MASK,
    EXECUTION_CAPABILITY_MASK_ID,
    EXECUTION_CAPABILITY_MASK_VERSION,
    build_execution_capability_mask,
    execution_capability_values,
    tier_of_execution_capability,
)

CURRENT_EXECUTION_MASK_HASH = (
    "sha256:394afbad12e98d306005cd9f5823144d3e6c8deddd834eb00f17628b73dd556d"
)


class ExecutionCapabilityMaskTest(unittest.TestCase):
    def test_builder_publishes_v1_mask_identity_and_hash(self) -> None:
        mask = build_execution_capability_mask()

        self.assertEqual(mask["schema_version"], 1)
        self.assertEqual(mask["mask_version"], EXECUTION_CAPABILITY_MASK_VERSION)
        self.assertEqual(mask["mask_id"], EXECUTION_CAPABILITY_MASK_ID)
        self.assertEqual(mask["mask_hash"], CURRENT_EXECUTION_MASK_HASH)
        self.assertEqual(mask["capabilities"][0], "order_plant_paper")
        self.assertEqual(mask["capabilities"][-1], "killswitch_tripped")
        self.assertEqual(
            tier_of_execution_capability(mask, "order_plant_live", "live"),
            "enabled_with_vault_evidence",
        )
        self.assertEqual(
            tier_of_execution_capability(mask, "submit", "live"),
            "enabled_with_health_gates_satisfied",
        )

    def test_scalar_publication_matches_built_mask(self) -> None:
        self.assertEqual(
            execution_capability_values(),
            {
                "execution_mask_version": EXECUTION_CAPABILITY_MASK_VERSION,
                "execution_mask_id": EXECUTION_CAPABILITY_MASK_ID,
                "execution_mask_hash": EXECUTION_CAPABILITY_MASK["mask_hash"],
            },
        )

    def test_cli_outputs_canonical_json_mask(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "services.market_data_sidecar.execution.execution_capability_mask",
            ],
            check=True,
            capture_output=True,
            text=True,
        )

        self.assertEqual(json.loads(result.stdout), build_execution_capability_mask())


if __name__ == "__main__":
    unittest.main()
