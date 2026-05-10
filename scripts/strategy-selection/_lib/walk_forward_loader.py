"""Held-out artifact loader for QFA-611 Cycle1.

This loader enforces the evidence/anti-tuning checks that must be true before
the downstream decision driver computes Stage 1 statistics.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping


def load_held_out_artifact(path: str | Path, lock_manifest_path: str | Path) -> dict[str, Any]:
    artifact = json.loads(Path(path).read_text(encoding="utf-8"))
    if artifact.get("gating_pnl_basis") != "net":
        raise ValueError("held-out artifact gating_pnl_basis must be net")
    verify_parameter_lock(artifact, load_parameter_lock_manifest(lock_manifest_path))
    return artifact


def load_parameter_lock_manifest(path: str | Path) -> dict[str, str]:
    manifest = json.loads(Path(path).read_text(encoding="utf-8"))
    strategies = manifest.get("strategies")
    if not isinstance(strategies, list):
        raise ValueError("parameter lock manifest must contain strategies[]")
    locks: dict[str, str] = {}
    for index, strategy in enumerate(strategies):
        strategy_id = strategy.get("strategy_id")
        parameter_lock_hash = strategy.get("parameter_lock_hash")
        if not isinstance(strategy_id, str) or not isinstance(parameter_lock_hash, str):
            raise ValueError(f"parameter lock manifest strategies[{index}] missing strategy_id or parameter_lock_hash")
        locks[strategy_id] = parameter_lock_hash
    return locks


def verify_parameter_lock(artifact: Mapping[str, Any], locks_by_strategy: Mapping[str, str]) -> None:
    strategy_id = artifact.get("strategy_id")
    parameter_lock_hash = artifact.get("parameter_lock_hash")
    if not isinstance(strategy_id, str):
        raise ValueError("held-out artifact missing strategy_id")
    if not isinstance(parameter_lock_hash, str):
        raise ValueError("held-out artifact missing parameter_lock_hash")
    expected = locks_by_strategy.get(strategy_id)
    if expected is None:
        raise ValueError(f"parameter lock manifest missing strategy_id {strategy_id}")
    if parameter_lock_hash != expected:
        raise ValueError(
            f"parameter_lock_hash mismatch for {strategy_id}: artifact {parameter_lock_hash}, manifest {expected}"
        )
