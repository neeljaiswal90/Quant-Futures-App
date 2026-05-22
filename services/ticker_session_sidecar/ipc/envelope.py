from __future__ import annotations

import json
from typing import Any


def encode_line(message: dict[str, Any]) -> str:
    return json.dumps(_stringify_ns(message), separators=(",", ":"), sort_keys=True) + "\n"


def decode_line(line: str) -> dict[str, Any]:
    value = json.loads(line)
    if not isinstance(value, dict):
        raise ValueError("IPC line must decode to an object")
    return value


def _stringify_ns(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _stringify_ns(child) for key, child in value.items()}
    if isinstance(value, list):
        return [_stringify_ns(child) for child in value]
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    return value
