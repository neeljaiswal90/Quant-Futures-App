"""Deterministic artifact writer for QFA-611 selection outputs.

LF discipline: writers emit raw UTF-8 bytes terminated with 0x0A.
Path.write_text is unsafe on Windows because text mode translates "\n" to
"\r\n" on disk, which breaks byte-equal canonical-hash comparisons.

Float discipline: JSON artifacts round floats at the writer boundary so
platform-specific libm drift does not perturb otherwise equivalent bytes.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

CANONICAL_FLOAT_DECIMALS = 10


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def canonicalize_floats(value: Any, decimals: int = CANONICAL_FLOAT_DECIMALS) -> Any:
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("canonical JSON does not support NaN or Infinity")
        return round(value, decimals)
    if isinstance(value, dict):
        return {key: canonicalize_floats(item, decimals=decimals) for key, item in value.items()}
    if isinstance(value, list):
        return [canonicalize_floats(item, decimals=decimals) for item in value]
    if isinstance(value, tuple):
        return tuple(canonicalize_floats(item, decimals=decimals) for item in value)
    return value


def write_canonical_json(value: Any, path: str | Path) -> None:
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes((canonical_json(canonicalize_floats(value)) + "\n").encode("utf-8"))


def write_lf_text(text: str, path: str | Path) -> None:
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = text if text.endswith("\n") else text + "\n"
    output.write_bytes(payload.encode("utf-8"))
