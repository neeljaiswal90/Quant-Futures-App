"""ADR-0018-A1 broker IPC contract mirror for TS/Python parity."""

from __future__ import annotations

import json
import math
import os
import sys
from typing import Any, Literal, TypedDict

BROKER_IPC_SCHEMA_VERSION = 1

BrokerIpcDirection = Literal["command", "event"]
BROKER_IPC_DIRECTIONS: list[BrokerIpcDirection] = ["command", "event"]

BrokerIpcCommandMessageType = Literal[
    "submit_order",
    "cancel_order",
    "query_order",
    "request_reconciliation_snapshot",
    "subscribe_order_events",
    "heartbeat",
    "shutdown",
]

BROKER_IPC_COMMAND_MESSAGE_TYPES_REQUIRING_IDEMPOTENCY_KEY: list[str] = [
    "submit_order",
    "cancel_order",
    "query_order",
    "request_reconciliation_snapshot",
]

BROKER_IPC_COMMAND_MESSAGE_TYPES_FORBIDDING_IDEMPOTENCY_KEY: list[str] = [
    "subscribe_order_events",
    "heartbeat",
    "shutdown",
]

BROKER_IPC_COMMAND_MESSAGE_TYPES: list[str] = [
    *BROKER_IPC_COMMAND_MESSAGE_TYPES_REQUIRING_IDEMPOTENCY_KEY,
    *BROKER_IPC_COMMAND_MESSAGE_TYPES_FORBIDDING_IDEMPOTENCY_KEY,
]

BrokerIpcEventMessageType = Literal[
    "boot_identity",
    "order_accepted",
    "order_rejected",
    "order_acknowledged",
    "order_partially_filled",
    "order_filled",
    "cancel_pending",
    "order_cancelled",
    "cancel_rejected",
    "broker_error",
    "connection_lost",
    "recovered",
    "position_snapshot",
    "reconciliation_snapshot",
    "heartbeat_pong",
    "shutdown_complete",
]

BROKER_IPC_EVENT_MESSAGE_TYPES: list[str] = [
    "boot_identity",
    "order_accepted",
    "order_rejected",
    "order_acknowledged",
    "order_partially_filled",
    "order_filled",
    "cancel_pending",
    "order_cancelled",
    "cancel_rejected",
    "broker_error",
    "connection_lost",
    "recovered",
    "position_snapshot",
    "reconciliation_snapshot",
    "heartbeat_pong",
    "shutdown_complete",
]

BrokerIpcFailureState = Literal[
    "sidecar_unavailable",
    "broker_disconnected",
    "auth_denied",
    "order_submit_rejected",
    "order_status_unknown",
    "position_reconciliation_failed",
    "duplicate_command_detected",
    "schema_version_incompatible",
    "order_path_not_yet_implemented",
]

BROKER_IPC_FAILURE_STATES: list[str] = [
    "sidecar_unavailable",
    "broker_disconnected",
    "auth_denied",
    "order_submit_rejected",
    "order_status_unknown",
    "position_reconciliation_failed",
    "duplicate_command_detected",
    "schema_version_incompatible",
    "order_path_not_yet_implemented",
]

BrokerIpcProtocolEnvironment = Literal[
    "rithmic_test",
    "rithmic_paper",
    "rithmic_live",
]

BROKER_IPC_PROTOCOL_ENVIRONMENTS: list[str] = [
    "rithmic_test",
    "rithmic_paper",
    "rithmic_live",
]


class BrokerIpcValidationIssue(TypedDict):
    path: str
    code: str
    message: str


class BrokerIpcValidationResult(TypedDict, total=False):
    ok: bool
    envelope: dict[str, Any]
    issues: list[BrokerIpcValidationIssue]


def build_broker_ipc_contract_export() -> dict[str, Any]:
    """Return the structural contract exported by the TS source of truth."""

    return {
        "schema_version": BROKER_IPC_SCHEMA_VERSION,
        "transport": {
            "framing": "json_lines",
            "line_separator": "LF",
            "bigint_fields_serialized_as": "decimal_string",
            "multiline_messages": False,
        },
        "directions": BROKER_IPC_DIRECTIONS,
        "command_message_types": BROKER_IPC_COMMAND_MESSAGE_TYPES,
        "command_message_types_requiring_idempotency_key": BROKER_IPC_COMMAND_MESSAGE_TYPES_REQUIRING_IDEMPOTENCY_KEY,
        "command_message_types_forbidding_idempotency_key": BROKER_IPC_COMMAND_MESSAGE_TYPES_FORBIDDING_IDEMPOTENCY_KEY,
        "event_message_types": BROKER_IPC_EVENT_MESSAGE_TYPES,
        "failure_states": BROKER_IPC_FAILURE_STATES,
        "protocol_environments": BROKER_IPC_PROTOCOL_ENVIRONMENTS,
        "envelope_fields": [
            "schema_version",
            "message_type",
            "direction",
            "run_id",
            "session_id",
            "correlation_id",
            "causation_id",
            "idempotency_key",
            "event_ts_ns",
            "adapter_version",
            "payload",
        ],
        "bigint_fields": ["event_ts_ns", "boot_ts_ns"],
        "boot_identity_payload_fields": [
            "adapter_version",
            "sdk_name",
            "sdk_version",
            "protocol_environment",
            "gateway_url_redacted",
            "boot_ts_ns",
            "process_id",
            "schema_version",
        ],
        "failure_payload_fields": [
            "failure_state",
            "rp_code",
            "rp_message_redacted",
            "reason",
            "recoverable",
            "correlated_command_idempotency_key",
            "qfa_broker_sidecar_ipc_ms",
        ],
        "optional_telemetry_fields": ["qfa_broker_sidecar_ipc_ms"],
    }


BROKER_IPC_CONTRACT = build_broker_ipc_contract_export()


def stable_broker_ipc_contract_json() -> str:
    return json.dumps(BROKER_IPC_CONTRACT, sort_keys=True, separators=(",", ":"))


def validate_broker_ipc_envelope(value: Any) -> BrokerIpcValidationResult:
    issues: list[BrokerIpcValidationIssue] = []
    envelope = _require_record(value, "$", issues)
    if envelope is None:
        return {"ok": False, "issues": issues}

    if envelope.get("schema_version") != BROKER_IPC_SCHEMA_VERSION:
        _add_issue(
            issues,
            "$.schema_version",
            "unsupported_schema_version",
            f"must be {BROKER_IPC_SCHEMA_VERSION}",
        )

    message_type = envelope.get("message_type")
    is_command = message_type in BROKER_IPC_COMMAND_MESSAGE_TYPES
    is_event = message_type in BROKER_IPC_EVENT_MESSAGE_TYPES
    if not is_command and not is_event:
        _add_issue(
            issues,
            "$.message_type",
            "unsupported_message_type",
            f"unsupported broker IPC message_type: {message_type}",
        )

    direction = envelope.get("direction")
    if is_command and direction != "command":
        _add_issue(
            issues,
            "$.direction",
            "invalid_direction",
            "command message requires command direction",
        )
    elif is_event and direction != "event":
        _add_issue(
            issues,
            "$.direction",
            "invalid_direction",
            "event message requires event direction",
        )
    elif not is_command and not is_event and direction not in BROKER_IPC_DIRECTIONS:
        _add_issue(issues, "$.direction", "invalid_direction", "must be command or event")

    _require_non_empty_string(envelope.get("run_id"), "$.run_id", issues)
    _require_non_empty_string(envelope.get("session_id"), "$.session_id", issues)
    _require_non_empty_string(envelope.get("correlation_id"), "$.correlation_id", issues)
    _require_non_empty_string(envelope.get("causation_id"), "$.causation_id", issues)
    _require_non_empty_string(envelope.get("adapter_version"), "$.adapter_version", issues)
    _require_timestamp(envelope.get("event_ts_ns"), "$.event_ts_ns", issues)

    if (
        is_command
        and message_type in BROKER_IPC_COMMAND_MESSAGE_TYPES_REQUIRING_IDEMPOTENCY_KEY
    ):
        _require_non_empty_string(
            envelope.get("idempotency_key"), "$.idempotency_key", issues
        )
    if (
        (is_command and message_type in BROKER_IPC_COMMAND_MESSAGE_TYPES_FORBIDDING_IDEMPOTENCY_KEY)
        or is_event
    ) and "idempotency_key" in envelope:
        _add_issue(
            issues,
            "$.idempotency_key",
            "forbidden_field",
            "must be omitted for this message_type",
        )

    if "payload" not in envelope:
        _add_issue(issues, "$.payload", "missing_required_field", "is required")
    else:
        payload = _require_record(envelope.get("payload"), "$.payload", issues)
        if payload is not None:
            if message_type == "boot_identity":
                _validate_boot_identity_payload(payload, issues)
            if message_type in {
                "broker_error",
                "connection_lost",
                "order_rejected",
                "cancel_rejected",
            }:
                _validate_failure_payload(payload, issues)
            _validate_optional_ipc_latency(payload, issues)

    sorted_issues = sorted(issues, key=lambda issue: (issue["path"], issue["code"]))
    result: BrokerIpcValidationResult = {"ok": len(sorted_issues) == 0, "issues": sorted_issues}
    if len(sorted_issues) == 0:
        result["envelope"] = envelope
    return result


def make_boot_identity_payload(
    *,
    adapter_version: str,
    sdk_version: str,
    protocol_environment: BrokerIpcProtocolEnvironment,
    gateway_url_redacted: str,
    boot_ts_ns: int | str,
    process_id: int | None = None,
) -> dict[str, Any]:
    return {
        "adapter_version": adapter_version,
        "sdk_name": "pyrithmic",
        "sdk_version": sdk_version,
        "protocol_environment": protocol_environment,
        "gateway_url_redacted": gateway_url_redacted,
        "boot_ts_ns": boot_ts_ns,
        "process_id": os.getpid() if process_id is None else process_id,
        "schema_version": BROKER_IPC_SCHEMA_VERSION,
    }


def _validate_boot_identity_payload(
    payload: dict[str, Any],
    issues: list[BrokerIpcValidationIssue],
) -> None:
    _require_non_empty_string(payload.get("adapter_version"), "$.payload.adapter_version", issues)
    if payload.get("sdk_name") != "pyrithmic":
        _add_issue(issues, "$.payload.sdk_name", "invalid_field_value", "must be pyrithmic")
    _require_non_empty_string(payload.get("sdk_version"), "$.payload.sdk_version", issues)
    if payload.get("protocol_environment") not in BROKER_IPC_PROTOCOL_ENVIRONMENTS:
        _add_issue(
            issues,
            "$.payload.protocol_environment",
            "invalid_field_value",
            "must be one of: " + ", ".join(BROKER_IPC_PROTOCOL_ENVIRONMENTS),
        )
    _require_non_empty_string(
        payload.get("gateway_url_redacted"), "$.payload.gateway_url_redacted", issues
    )
    _require_timestamp(payload.get("boot_ts_ns"), "$.payload.boot_ts_ns", issues)
    _require_non_negative_integer(payload.get("process_id"), "$.payload.process_id", issues)
    if payload.get("schema_version") != BROKER_IPC_SCHEMA_VERSION:
        _add_issue(
            issues,
            "$.payload.schema_version",
            "unsupported_schema_version",
            f"must be {BROKER_IPC_SCHEMA_VERSION}",
        )


def _validate_failure_payload(
    payload: dict[str, Any],
    issues: list[BrokerIpcValidationIssue],
) -> None:
    if "failure_state" not in payload:
        _add_issue(issues, "$.payload.failure_state", "missing_required_field", "is required")
    elif payload.get("failure_state") not in BROKER_IPC_FAILURE_STATES:
        _add_issue(
            issues,
            "$.payload.failure_state",
            "invalid_field_value",
            "must be one of: " + ", ".join(BROKER_IPC_FAILURE_STATES),
        )
    _require_required_string(payload, "reason", "$.payload.reason", issues)
    _require_required_boolean(payload, "recoverable", "$.payload.recoverable", issues)
    _optional_string(payload.get("rp_code"), "$.payload.rp_code", issues)
    _optional_string(payload.get("rp_message_redacted"), "$.payload.rp_message_redacted", issues)
    _optional_string(
        payload.get("correlated_command_idempotency_key"),
        "$.payload.correlated_command_idempotency_key",
        issues,
    )


def _validate_optional_ipc_latency(
    payload: dict[str, Any],
    issues: list[BrokerIpcValidationIssue],
) -> None:
    value = payload.get("qfa_broker_sidecar_ipc_ms")
    if value is not None and (
        not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0
    ):
        _add_issue(
            issues,
            "$.payload.qfa_broker_sidecar_ipc_ms",
            "invalid_field_value",
            "must be a non-negative finite number when present",
        )


def _require_record(
    value: Any,
    path: str,
    issues: list[BrokerIpcValidationIssue],
) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        _add_issue(issues, path, "invalid_envelope", "must be an object")
        return None
    return value


def _require_non_empty_string(
    value: Any,
    path: str,
    issues: list[BrokerIpcValidationIssue],
) -> None:
    if not isinstance(value, str) or value.strip() == "":
        _add_issue(issues, path, "invalid_field_type", "must be a non-empty string")


def _require_required_string(
    record: dict[str, Any],
    field_name: str,
    path: str,
    issues: list[BrokerIpcValidationIssue],
) -> None:
    if field_name not in record:
        _add_issue(issues, path, "missing_required_field", "is required")
        return
    _require_non_empty_string(record.get(field_name), path, issues)


def _require_required_boolean(
    record: dict[str, Any],
    field_name: str,
    path: str,
    issues: list[BrokerIpcValidationIssue],
) -> None:
    if field_name not in record:
        _add_issue(issues, path, "missing_required_field", "is required")
        return
    if not isinstance(record.get(field_name), bool):
        _add_issue(issues, path, "invalid_field_type", "must be a boolean")


def _optional_string(
    value: Any,
    path: str,
    issues: list[BrokerIpcValidationIssue],
) -> None:
    if value is not None and not isinstance(value, str):
        _add_issue(issues, path, "invalid_field_type", "must be a string when present")


def _require_timestamp(
    value: Any,
    path: str,
    issues: list[BrokerIpcValidationIssue],
) -> None:
    if isinstance(value, bool):
        pass
    elif isinstance(value, int) and value >= 0:
        return
    elif isinstance(value, str) and (value == "0" or (value[:1] in "123456789" and value.isdigit())):
        return
    _add_issue(
        issues,
        path,
        "invalid_field_value",
        "must be a non-negative integer or unsigned decimal string",
    )


def _require_non_negative_integer(
    value: Any,
    path: str,
    issues: list[BrokerIpcValidationIssue],
) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        _add_issue(issues, path, "invalid_field_value", "must be a non-negative integer")


def _add_issue(
    issues: list[BrokerIpcValidationIssue],
    path: str,
    code: str,
    message: str,
) -> None:
    issues.append({"path": path, "code": code, "message": message})


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1:] != ["--export-json"]:
        raise SystemExit(
            "usage: python -m services.broker_session_sidecar.contracts.broker_ipc_contract [--export-json]"
        )
    print(stable_broker_ipc_contract_json())
