"""JSON state helpers with corrupt-file quarantine."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

PT = ZoneInfo("America/Los_Angeles")


def load_json_state(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    """Load a JSON object; quarantine corrupt state and return ``default``."""

    if not path.exists():
        return dict(default)
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError:
        timestamp = datetime.now(PT).strftime("%Y%m%d_%H%M%S")
        broken = path.with_name(f"{path.name}.broken_{timestamp}")
        path.replace(broken)
        return dict(default)
    if not isinstance(data, dict):
        return dict(default)
    return data


def save_json_state(path: Path, data: dict[str, Any]) -> None:
    """Atomically save a JSON object."""

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write("\n")
    tmp.replace(path)


def dashboard_state_paths(root: Path) -> dict[str, Path]:
    """Return the canonical dashboard state-file paths."""

    return {
        "state": root / "_state.json",
        "scenarios": root / "_scenarios.json",
        "audit": root / "_audit.json",
        "pause": root / "_pause.flag",
    }
