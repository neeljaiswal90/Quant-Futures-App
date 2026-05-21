"""Inline Python replica of the broker IPC contract until BROKER-00 lands.

TODO(QFA-612-BROKER-00): import the canonical BROKER-00 contract shape when it is
available and keep these names structurally compatible.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

BROKER_IPC_SCHEMA_VERSION = 1
SIDECAR_NAME = "qfa_broker_session_sidecar"
SUPPORTED_COMMAND_TYPES = frozenset({
    "heartbeat",
    "submit_order",
    "cancel_order",
    "query_order",
    "request_reconciliation_snapshot",
    "subscribe_order_events",
    "shutdown",
})
ORDER_PATH_COMMAND_TYPES = frozenset({
    "submit_order",
    "cancel_order",
    "query_order",
    "request_reconciliation_snapshot",
})
FAILURE_STATES = frozenset({
    "auth_denied",
    "broker_disconnected",
    "duplicate_command_detected",
    "schema_version_incompatible",
    "order_path_not_yet_implemented",
})


@dataclass(frozen=True)
class ParsedCommand:
    raw: dict[str, Any]
    command_type: str
    command_id: str | None
    schema_version: int


def parse_command(value: Any) -> ParsedCommand | None:
    if not isinstance(value, dict):
        return None
    command_type = value.get("type") or value.get("command_type")
    schema_version = value.get("schema_version")
    if not isinstance(command_type, str) or not isinstance(schema_version, int):
        return None
    command_id = value.get("command_id")
    return ParsedCommand(
        raw=value,
        command_type=command_type,
        command_id=command_id if isinstance(command_id, str) else None,
        schema_version=schema_version,
    )
