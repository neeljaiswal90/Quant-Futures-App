"""Shared QFA-611 parameter-lock hashing helpers.

The Cycle1 lock manifest emitter and the QFA-611 driver intentionally share
this implementation so runtime hash checks cannot drift from manifest
construction.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

PARAMETER_LOCK_ALGORITHM = "qfa611_parameter_struct_v1"


def parse_yaml_scalar(raw: str) -> object:
    value = raw.strip()
    if value == "":
        return ""
    lowered = value.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    try:
        if any(token in value for token in (".", "e", "E")):
            return float(value)
        return int(value)
    except ValueError:
        return value.strip('"').strip("'")


def load_strategy_parameter_struct(strategy_id: str, config_dir: str | Path) -> dict[str, object]:
    """Load the simple Cycle1 strategy parameter YAML without adding PyYAML."""

    path = Path(config_dir) / f"{strategy_id}.yaml"
    if not path.exists():
        raise ValueError(f"runtime parameter config missing for {strategy_id}: {path}")

    parameters: dict[str, object] = {}
    in_parameters = False
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if not line.startswith(" ") and stripped.endswith(":"):
            in_parameters = stripped[:-1] == "parameters"
            continue
        if not line.startswith(" ") and ":" in stripped:
            key, value = stripped.split(":", 1)
            in_parameters = key == "parameters" and value.strip() == ""
            continue
        if in_parameters and ":" in stripped:
            key, value = stripped.split(":", 1)
            parameters[key.strip()] = parse_yaml_scalar(value)

    if not parameters:
        raise ValueError(f"runtime parameter config has no parameters for {strategy_id}: {path}")

    return {
        "parameter_lock_algorithm": PARAMETER_LOCK_ALGORITHM,
        "strategy_id": strategy_id,
        "parameters": parameters,
    }


def compute_runtime_parameter_hash(strategy_id: str, config_dir: str | Path) -> str:
    payload = load_strategy_parameter_struct(strategy_id, config_dir)
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
