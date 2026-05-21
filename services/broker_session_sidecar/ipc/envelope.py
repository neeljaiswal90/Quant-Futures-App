"""JSONL envelope helpers for broker sidecar IPC."""

from __future__ import annotations

import json
import sys
import time
from typing import Any, TextIO

from services.broker_session_sidecar.contracts.broker_ipc_contract import BROKER_IPC_SCHEMA_VERSION

SIDECAR_NAME = "qfa_broker_session_sidecar"


def now_ns() -> int:
    return time.monotonic_ns()


def wall_clock_ns() -> int:
    return time.time_ns()


def make_event(event_type: str, **fields: Any) -> dict[str, Any]:
    event: dict[str, Any] = {
        "schema_version": BROKER_IPC_SCHEMA_VERSION,
        "type": event_type,
        "sidecar": SIDECAR_NAME,
        "ts_ns": wall_clock_ns(),
    }
    event.update(fields)
    return event


def write_jsonl(stream: TextIO, event: dict[str, Any]) -> None:
    stream.write(json.dumps(event, separators=(",", ":"), sort_keys=True))
    stream.write("\n")
    stream.flush()


def write_stdout_event(event: dict[str, Any]) -> None:
    write_jsonl(sys.stdout, event)
