#!/usr/bin/env python3
"""Emit an independent QFA-611 parameter-lock manifest."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

LIB_DIR = Path(__file__).resolve().parent / "_lib"
sys.path.insert(0, str(LIB_DIR))

from artifact_writer import write_canonical_json
from parameter_lock import PARAMETER_LOCK_ALGORITHM, compute_runtime_parameter_hash

DEFAULT_STRATEGY_IDS_PATH = Path("apps/strategy_runtime/src/contracts/strategy-ids.ts")
DEFAULT_STRATEGY_CONFIG_DIR = Path("config/strategies")


def active_strategy_ids(path: Path = DEFAULT_STRATEGY_IDS_PATH) -> list[str]:
    text = path.read_text(encoding="utf-8")
    match = re.search(r"ACTIVE_STRATEGY_IDS\s*=\s*\[(.*?)\]\s*as const", text, re.S)
    if not match:
        raise RuntimeError(f"Could not parse ACTIVE_STRATEGY_IDS from {path}")
    ids = re.findall(r"'([^']+)'", match.group(1))
    if not ids:
        raise RuntimeError("ACTIVE_STRATEGY_IDS is empty")
    return ids


def default_output_for_cycle(cycle_id: str) -> Path:
    return Path("artifacts/strategy-selection") / f"{cycle_id}-parameter-locks.json"


def build_manifest(
    strategy_ids: list[str],
    strategy_config_dir: Path,
    cycle_id: str,
) -> dict[str, object]:
    return {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "parameter_lock_algorithm": PARAMETER_LOCK_ALGORITHM,
        "strategies": [
            {
                "strategy_id": strategy_id,
                "parameter_lock_hash": compute_runtime_parameter_hash(strategy_id, strategy_config_dir),
            }
            for strategy_id in sorted(strategy_ids)
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Emit a QFA-611 parameter-lock manifest")
    parser.add_argument("--cycle-id", required=True)
    parser.add_argument("--strategy-config-dir", type=Path, default=DEFAULT_STRATEGY_CONFIG_DIR)
    parser.add_argument("--strategy-ids", nargs="*", default=None)
    parser.add_argument("--strategy-ids-path", type=Path, default=DEFAULT_STRATEGY_IDS_PATH)
    parser.add_argument("--out", type=Path, default=None)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    strategy_ids = args.strategy_ids or active_strategy_ids(args.strategy_ids_path)
    manifest = build_manifest(strategy_ids, args.strategy_config_dir, args.cycle_id)
    output_path = args.out or default_output_for_cycle(args.cycle_id)
    write_canonical_json(manifest, output_path)
    print(f"wrote {output_path} ({len(strategy_ids)} strategies)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
