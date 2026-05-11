"""Deterministic artifact writer for QFA-611 selection outputs."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def write_canonical_json(value: Any, path: str | Path) -> None:
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(canonical_json(value) + "\n", encoding="utf-8")
