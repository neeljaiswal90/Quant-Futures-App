from __future__ import annotations

import json
from typing import Any, Dict, List, Tuple

TICKER_IPC_SCHEMA_VERSION = 1
TICKER_IPC_DIRECTIONS = ["command", "event"]
TICKER_IPC_COMMAND_MESSAGE_TYPES = [
    "subscribe_symbol",
    "unsubscribe_symbol",
    "query_subscriptions",
    "heartbeat",
    "shutdown",
]
TICKER_IPC_EVENT_MESSAGE_TYPES = [
    "boot_identity",
    "subscription_accepted",
    "subscription_rejected",
    "tick_quote",
    "tick_trade",
    "tick_book_rebuild",
    "heartbeat_pong",
    "subscription_snapshot",
    "connection_lost",
    "recovered",
    "broker_error",
    "shutdown_complete",
]
TICKER_IPC_FAILURE_STATES = [
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
TICKER_IPC_PROTOCOL_ENVIRONMENTS = ["rithmic_test", "rithmic_paper", "rithmic_live"]


def build_ticker_ipc_contract_export() -> Dict[str, Any]:
    return {
        "schema_version": TICKER_IPC_SCHEMA_VERSION,
        "transport": {
            "framing": "json_lines",
            "line_separator": "LF",
            "bigint_fields_serialized_as": "decimal_string",
            "multiline_messages": False,
        },
        "directions": TICKER_IPC_DIRECTIONS,
        "command_message_types": TICKER_IPC_COMMAND_MESSAGE_TYPES,
        "command_message_types_forbidding_idempotency_key": TICKER_IPC_COMMAND_MESSAGE_TYPES,
        "event_message_types": TICKER_IPC_EVENT_MESSAGE_TYPES,
        "failure_states": TICKER_IPC_FAILURE_STATES,
        "protocol_environments": TICKER_IPC_PROTOCOL_ENVIRONMENTS,
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
        "bigint_fields": ["event_ts_ns", "boot_ts_ns", "tick_ts_ns"],
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
        "tick_quote_payload_fields": [
            "symbol",
            "exchange",
            "tick_ts_ns",
            "sidecar_recv_ts_ns",
            "bid_px",
            "bid_qty",
            "ask_px",
            "ask_qty",
        ],
        "tick_trade_payload_fields": [
            "symbol",
            "exchange",
            "tick_ts_ns",
            "sidecar_recv_ts_ns",
            "price",
            "quantity",
            "aggressor_side",
            "trade_id",
        ],
        "failure_payload_fields": [
            "failure_state",
            "rp_code",
            "rp_message_redacted",
            "reason",
            "recoverable",
            "correlated_command_idempotency_key",
        ],
    }


TICKER_IPC_CONTRACT = build_ticker_ipc_contract_export()


def stable_ticker_ipc_contract_json() -> str:
    return json.dumps(TICKER_IPC_CONTRACT, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def validate_ticker_ipc_envelope(value: Any) -> Dict[str, Any]:
    issues: List[Dict[str, str]] = []
    envelope = _require_record(value, "$", issues)
    if envelope is None:
        return {"ok": False, "issues": issues}

    if envelope.get("schema_version") != TICKER_IPC_SCHEMA_VERSION:
        _add_issue(issues, "$.schema_version", "unsupported_schema_version", f"must be {TICKER_IPC_SCHEMA_VERSION}")

    message_type = envelope.get("message_type")
    is_command = message_type in TICKER_IPC_COMMAND_MESSAGE_TYPES
    is_event = message_type in TICKER_IPC_EVENT_MESSAGE_TYPES
    if not is_command and not is_event:
        _add_issue(issues, "$.message_type", "unsupported_message_type", f"unsupported ticker IPC message_type: {message_type}")
    if is_command and envelope.get("direction") != "command":
        _add_issue(issues, "$.direction", "invalid_direction", "command message requires command direction")
    elif is_event and envelope.get("direction") != "event":
        _add_issue(issues, "$.direction", "invalid_direction", "event message requires event direction")
    elif not is_command and not is_event and envelope.get("direction") not in TICKER_IPC_DIRECTIONS:
        _add_issue(issues, "$.direction", "invalid_direction", "must be command or event")

    for field in ["run_id", "session_id", "correlation_id", "causation_id", "adapter_version"]:
        _require_non_empty_string(envelope.get(field), f"$.{field}", issues)
    _require_timestamp(envelope.get("event_ts_ns"), "$.event_ts_ns", issues)
    if "idempotency_key" in envelope:
        _add_issue(issues, "$.idempotency_key", "forbidden_field", "ticker IPC messages must omit idempotency_key")

    if "payload" not in envelope:
        _add_issue(issues, "$.payload", "missing_required_field", "is required")
    else:
        payload = _require_record(envelope.get("payload"), "$.payload", issues)
        if payload is not None:
            if message_type == "boot_identity":
                _validate_boot_identity_payload(payload, issues)
            if message_type in {"broker_error", "connection_lost", "subscription_rejected"}:
                _validate_failure_payload(payload, issues)
            if message_type == "tick_quote":
                _validate_tick_quote_payload(payload, issues)
            if message_type == "tick_trade":
                _validate_tick_trade_payload(payload, issues)

    issues.sort(key=lambda issue: (issue["path"], issue["code"]))
    return {"ok": len(issues) == 0, "issues": issues, **({"envelope": value} if len(issues) == 0 else {})}


def _validate_boot_identity_payload(payload: Dict[str, Any], issues: List[Dict[str, str]]) -> None:
    _require_non_empty_string(payload.get("adapter_version"), "$.payload.adapter_version", issues)
    if payload.get("sdk_name") != "pyrithmic":
        _add_issue(issues, "$.payload.sdk_name", "invalid_field_value", "must be pyrithmic")
    _require_non_empty_string(payload.get("sdk_version"), "$.payload.sdk_version", issues)
    if payload.get("protocol_environment") not in TICKER_IPC_PROTOCOL_ENVIRONMENTS:
        _add_issue(issues, "$.payload.protocol_environment", "invalid_field_value", "must be one of: " + ", ".join(TICKER_IPC_PROTOCOL_ENVIRONMENTS))
    _require_non_empty_string(payload.get("gateway_url_redacted"), "$.payload.gateway_url_redacted", issues)
    _require_timestamp(payload.get("boot_ts_ns"), "$.payload.boot_ts_ns", issues)
    _require_non_negative_integer(payload.get("process_id"), "$.payload.process_id", issues)
    if payload.get("schema_version") != TICKER_IPC_SCHEMA_VERSION:
        _add_issue(issues, "$.payload.schema_version", "unsupported_schema_version", f"must be {TICKER_IPC_SCHEMA_VERSION}")


def _validate_failure_payload(payload: Dict[str, Any], issues: List[Dict[str, str]]) -> None:
    if "failure_state" not in payload:
        _add_issue(issues, "$.payload.failure_state", "missing_required_field", "is required")
    elif payload.get("failure_state") not in TICKER_IPC_FAILURE_STATES:
        _add_issue(issues, "$.payload.failure_state", "invalid_field_value", "must be one of: " + ", ".join(TICKER_IPC_FAILURE_STATES))
    _require_required_string(payload, "reason", "$.payload.reason", issues)
    _require_required_boolean(payload, "recoverable", "$.payload.recoverable", issues)
    _optional_string(payload.get("rp_code"), "$.payload.rp_code", issues)
    _optional_string(payload.get("rp_message_redacted"), "$.payload.rp_message_redacted", issues)
    _optional_string(payload.get("correlated_command_idempotency_key"), "$.payload.correlated_command_idempotency_key", issues)


def _validate_tick_quote_payload(payload: Dict[str, Any], issues: List[Dict[str, str]]) -> None:
    for field in ["symbol", "exchange"]:
        _require_non_empty_string(payload.get(field), f"$.payload.{field}", issues)
    for field in ["tick_ts_ns", "sidecar_recv_ts_ns"]:
        _require_timestamp(payload.get(field), f"$.payload.{field}", issues)
    for field in ["bid_px", "bid_qty", "ask_px", "ask_qty"]:
        _require_number(payload.get(field), f"$.payload.{field}", issues)


def _validate_tick_trade_payload(payload: Dict[str, Any], issues: List[Dict[str, str]]) -> None:
    for field in ["symbol", "exchange"]:
        _require_non_empty_string(payload.get(field), f"$.payload.{field}", issues)
    for field in ["tick_ts_ns", "sidecar_recv_ts_ns"]:
        _require_timestamp(payload.get(field), f"$.payload.{field}", issues)
    for field in ["price", "quantity"]:
        _require_number(payload.get(field), f"$.payload.{field}", issues)
    if payload.get("aggressor_side") is not None and payload.get("aggressor_side") not in {"buy", "sell", "unknown"}:
        _add_issue(issues, "$.payload.aggressor_side", "invalid_field_value", "must be buy, sell, or unknown")
    _optional_string(payload.get("trade_id"), "$.payload.trade_id", issues)


def _require_record(value: Any, path: str, issues: List[Dict[str, str]]) -> Dict[str, Any] | None:
    if not isinstance(value, dict):
        _add_issue(issues, path, "invalid_envelope", "must be an object")
        return None
    return value


def _require_non_empty_string(value: Any, path: str, issues: List[Dict[str, str]]) -> None:
    if not isinstance(value, str) or value.strip() == "":
        _add_issue(issues, path, "invalid_field_type", "must be a non-empty string")


def _require_required_string(record: Dict[str, Any], field: str, path: str, issues: List[Dict[str, str]]) -> None:
    if field not in record:
        _add_issue(issues, path, "missing_required_field", "is required")
        return
    _require_non_empty_string(record.get(field), path, issues)


def _require_required_boolean(record: Dict[str, Any], field: str, path: str, issues: List[Dict[str, str]]) -> None:
    if field not in record:
        _add_issue(issues, path, "missing_required_field", "is required")
        return
    if not isinstance(record.get(field), bool):
        _add_issue(issues, path, "invalid_field_type", "must be a boolean")


def _optional_string(value: Any, path: str, issues: List[Dict[str, str]]) -> None:
    if value is not None and not isinstance(value, str):
        _add_issue(issues, path, "invalid_field_type", "must be a string when present")


def _require_number(value: Any, path: str, issues: List[Dict[str, str]]) -> None:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        _add_issue(issues, path, "invalid_field_type", "must be a finite number")


def _require_timestamp(value: Any, path: str, issues: List[Dict[str, str]]) -> None:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return
    if isinstance(value, str) and value.isdecimal() and (value == "0" or not value.startswith("0")):
        return
    _add_issue(issues, path, "invalid_field_value", "must be a non-negative integer or unsigned decimal string")


def _require_non_negative_integer(value: Any, path: str, issues: List[Dict[str, str]]) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        _add_issue(issues, path, "invalid_field_value", "must be a non-negative integer")


def _add_issue(issues: List[Dict[str, str]], path: str, code: str, message: str) -> None:
    issues.append({"path": path, "code": code, "message": message})


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--export-json", action="store_true")
    args = parser.parse_args()
    if args.export_json:
        print(stable_ticker_ipc_contract_json())
