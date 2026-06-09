"""JSONL envelope helpers for broker sidecar IPC."""

from __future__ import annotations

import json
import sys
import time
from typing import Any, TextIO

from services.broker_session_sidecar import __version__
from services.broker_session_sidecar.contracts.broker_ipc_contract import BROKER_IPC_SCHEMA_VERSION

SIDECAR_NAME = "qfa_broker_session_sidecar"


def now_ns() -> int:
    return time.monotonic_ns()


def wall_clock_ns() -> int:
    return time.time_ns()


def make_event(event_type: str, **fields: Any) -> dict[str, Any]:
    command_id = fields.pop("command_id", None)
    correlation_id = str(fields.pop("correlation_id", command_id or event_type))
    session_id = str(fields.pop("session_id", fields.get("broker_session_id", "broker-sidecar-session")))
    run_id = str(fields.pop("run_id", "broker-sidecar-run"))
    causation_id = str(fields.pop("causation_id", correlation_id))
    event_ts_ns = fields.pop("event_ts_ns", wall_clock_ns())
    payload = fields.pop("payload", fields.copy())
    return {
        "schema_version": BROKER_IPC_SCHEMA_VERSION,
        "message_type": event_type,
        "type": event_type,
        "direction": "event",
        "run_id": run_id,
        "session_id": session_id,
        "correlation_id": correlation_id,
        "causation_id": causation_id,
        "event_ts_ns": str(event_ts_ns),
        "adapter_version": __version__,
        "payload": payload,
        "sidecar": SIDECAR_NAME,
        "ts_ns": int(event_ts_ns),
    }


def write_jsonl(stream: TextIO, event: dict[str, Any]) -> None:
    stream.write(json.dumps(event, separators=(",", ":"), sort_keys=True))
    stream.write("\n")
    stream.flush()


def write_stdout_event(event: dict[str, Any]) -> None:
    write_jsonl(sys.stdout, event)
