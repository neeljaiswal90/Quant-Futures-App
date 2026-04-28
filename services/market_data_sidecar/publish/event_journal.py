"""OBS-01 JSONL event journal writer for DATA-01A."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = 1


def make_source_event_envelope(
    *,
    event_id: str,
    event_type: str,
    ts_ns: str,
    run_id: str,
    session_id: str,
    payload: dict[str, Any],
    causation_id: str | None = None,
) -> dict[str, Any]:
    envelope = {
        "schema_version": SCHEMA_VERSION,
        "event_id": event_id,
        "type": event_type,
        "ts_ns": ts_ns,
        "run_id": run_id,
        "session_id": session_id,
        "payload": payload,
    }
    if causation_id is not None:
        envelope["causation_id"] = causation_id
    return envelope


def write_jsonl(path: Path, events: Iterable[dict[str, Any]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("w", encoding="utf-8", newline="\n") as output:
        for event in events:
            output.write(json.dumps(event, sort_keys=True, separators=(",", ":")))
            output.write("\n")
            count += 1
    return count
