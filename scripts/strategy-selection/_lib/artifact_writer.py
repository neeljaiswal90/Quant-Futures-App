"""Deterministic artifact writer for QFA-611 selection outputs.

LF discipline: writers emit raw UTF-8 bytes terminated with 0x0A.
Path.write_text is unsafe on Windows because text mode translates "\n" to
"\r\n" on disk, which breaks byte-equal canonical-hash comparisons.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def write_canonical_json(value: Any, path: str | Path) -> None:
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes((canonical_json(value) + "\n").encode("utf-8"))


def write_lf_text(text: str, path: str | Path) -> None:
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = text if text.endswith("\n") else text + "\n"
    output.write_bytes(payload.encode("utf-8"))
