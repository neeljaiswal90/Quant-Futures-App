"""QFA broker session sidecar process."""

from __future__ import annotations

import argparse
import json
import os
import queue
import signal
import sys
import threading
from dataclasses import dataclass
from typing import Any, Iterable, TextIO

from services.broker_session_sidecar import __version__
from services.broker_session_sidecar.auth import AuthDeniedError, AuthResult, authenticate
from services.broker_session_sidecar.contracts.broker_ipc_contract import (
    BROKER_IPC_COMMAND_MESSAGE_TYPES,
    BROKER_IPC_COMMAND_MESSAGE_TYPES_REQUIRING_IDEMPOTENCY_KEY,
    BROKER_IPC_SCHEMA_VERSION,
)
from services.broker_session_sidecar.credential_resolver import CredentialResolutionError, resolve_credentials
from services.broker_session_sidecar.heartbeat import heartbeat_pong
from services.broker_session_sidecar.ipc.envelope import make_event, now_ns, write_jsonl
from services.broker_session_sidecar.ipc.redactor import redact_text

_STOP_REQUESTED = False
_SEEN_COMMAND_IDS: set[str] = set()
_STDIN_EOF = object()
SUPPORTED_COMMAND_TYPES = frozenset(BROKER_IPC_COMMAND_MESSAGE_TYPES)
ORDER_PATH_COMMAND_TYPES = frozenset(BROKER_IPC_COMMAND_MESSAGE_TYPES_REQUIRING_IDEMPOTENCY_KEY)


@dataclass(frozen=True)
class SidecarConfig:
    config_path: str | None
    log_level: str
    mode: str


@dataclass(frozen=True)
class ParsedCommand:
    raw: dict[str, Any]
    command_type: str
    command_id: str | None
    schema_version: int
    idempotency_key: str | None


def parse_args(argv: Iterable[str]) -> SidecarConfig:
    parser = argparse.ArgumentParser(prog="python -m broker_session_sidecar")
    parser.add_argument("--config", dest="config_path", default=None)
    parser.add_argument("--log-level", choices=("debug", "info", "warning", "error"), default=os.environ.get("QFA_BROKER_LOG_LEVEL", "info"))
    parser.add_argument("--mode", choices=("test",), default=os.environ.get("QFA_BROKER_MODE", "test"))
    args = parser.parse_args(list(argv))
    return SidecarConfig(config_path=args.config_path, log_level=args.log_level, mode=args.mode)


def log(message: object, level: str = "info") -> None:
    sys.stderr.write(f"{level}: {redact_text(message)}\n")
    sys.stderr.flush()


def broker_error(
    failure_state: str,
    reason: object,
    command_id: str | None = None,
    *,
    recoverable: bool = False,
    rp_code: object | None = None,
    rp_message: object | None = None,
    correlated_command_idempotency_key: str | None = None,
    **fields: Any,
) -> dict[str, Any]:
    reason_redacted = redact_text(reason)
    failure_payload: dict[str, Any] = {
        "failure_state": failure_state,
        "reason": reason_redacted,
        "recoverable": recoverable,
    }
    if rp_code is not None:
        failure_payload["rp_code"] = str(rp_code)
    if rp_message is not None:
        failure_payload["rp_message_redacted"] = redact_text(rp_message)
    if correlated_command_idempotency_key is not None:
        failure_payload["correlated_command_idempotency_key"] = correlated_command_idempotency_key
    return make_event(
        "broker_error",
        command_id=command_id,
        failure_state=failure_state,
        reason=reason_redacted,
        recoverable=recoverable,
        payload=failure_payload,
        **({"rp_code": str(rp_code)} if rp_code is not None else {}),
        **({"rp_message_redacted": redact_text(rp_message)} if rp_message is not None else {}),
        **(
            {"correlated_command_idempotency_key": correlated_command_idempotency_key}
            if correlated_command_idempotency_key is not None
            else {}
        ),
        **fields,
    )


def boot_identity(auth_result: AuthResult, config: SidecarConfig) -> dict[str, Any]:
    return make_event(
        "boot_identity",
        broker_session_id=auth_result.broker_session_id,
        sidecar_version=__version__,
        mode=config.mode,
        config_path=config.config_path,
        contract_schema_version=BROKER_IPC_SCHEMA_VERSION,
        account_ref_redacted=auth_result.account_ref_redacted,
    )


def ipc_measurement(command_id: str | None, received_at_ns: int, responded_at_ns: int) -> dict[str, Any]:
    return make_event(
        "qfa_broker_sidecar_ipc_ms",
        command_id=command_id,
        received_at_ns=received_at_ns,
        responded_at_ns=responded_at_ns,
        value_ms=(responded_at_ns - received_at_ns) / 1_000_000,
    )


def install_signal_handlers() -> None:
    def request_stop(_signum: int, _frame: object) -> None:
        global _STOP_REQUESTED
        _STOP_REQUESTED = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, request_stop)


def run(config: SidecarConfig, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> int:
    global _STOP_REQUESTED
    _STOP_REQUESTED = False
    _SEEN_COMMAND_IDS.clear()
    install_signal_handlers()
    try:
        credentials = resolve_credentials(os.environ)
        auth_result = authenticate(credentials, mode=config.mode)
    except CredentialResolutionError as exc:
        reason = f"missing env vars: {', '.join(exc.missing)}"
        event = broker_error("auth_denied", reason, rp_message=reason, missing_env=list(exc.missing))
        write_jsonl(stdout, event)
        log(event["reason"], "error")
        return 2
    except AuthDeniedError as exc:
        event = broker_error(
            "auth_denied",
            "Rithmic authentication denied",
            rp_code=exc.rp_code,
            rp_message=exc.rp_message_redacted,
        )
        write_jsonl(stdout, event)
        log(exc.rp_message_redacted, "error")
        return 2

    write_jsonl(stdout, boot_identity(auth_result, config))

    stdin_queue = _start_stdin_reader(stdin)
    while not _STOP_REQUESTED:
        try:
            item = stdin_queue.get(timeout=0.05)
        except queue.Empty:
            continue
        if item is _STDIN_EOF:
            break
        line = str(item)
        if _STOP_REQUESTED:
            break
        stripped = line.strip()
        if not stripped:
            continue
        received_at_ns = now_ns()
        try:
            payload = json.loads(stripped)
        except json.JSONDecodeError as exc:
            _emit_with_latency(
                stdout,
                broker_error("schema_version_incompatible", f"invalid JSON command: {exc}"),
                None,
                received_at_ns,
            )
            continue
        command = parse_command(payload)
        if command is None or command.schema_version != BROKER_IPC_SCHEMA_VERSION or command.command_type not in SUPPORTED_COMMAND_TYPES:
            command_id = payload.get("command_id") if isinstance(payload, dict) and isinstance(payload.get("command_id"), str) else None
            idempotency_key = payload.get("idempotency_key") if isinstance(payload, dict) and isinstance(payload.get("idempotency_key"), str) else None
            _emit_with_latency(
                stdout,
                broker_error(
                    "schema_version_incompatible",
                    "unsupported broker IPC command schema",
                    command_id,
                    correlated_command_idempotency_key=idempotency_key,
                ),
                command_id,
                received_at_ns,
            )
            continue
        if command.command_id is not None:
            if command.command_id in _SEEN_COMMAND_IDS:
                _emit_with_latency(
                    stdout,
                    broker_error(
                        "duplicate_command_detected",
                        "duplicate command id",
                        command.command_id,
                        correlated_command_idempotency_key=command.idempotency_key,
                    ),
                    command.command_id,
                    received_at_ns,
                )
                continue
            _SEEN_COMMAND_IDS.add(command.command_id)

        if command.command_type == "shutdown":
            _emit_with_latency(stdout, make_event("shutdown_complete", command_id=command.command_id), command.command_id, received_at_ns)
            return 0
        if command.command_type == "heartbeat":
            _emit_with_latency(stdout, heartbeat_pong(command.raw, auth_result.broker_session_id), command.command_id, received_at_ns)
            continue
        if command.command_type in ORDER_PATH_COMMAND_TYPES:
            _emit_with_latency(
                stdout,
                broker_error(
                    "order_path_not_yet_implemented",
                    "order path is not implemented in QFA-612-BROKER-01",
                    command.command_id,
                    correlated_command_idempotency_key=command.idempotency_key,
                ),
                command.command_id,
                received_at_ns,
            )
            continue
        if command.command_type == "subscribe_order_events":
            _emit_with_latency(stdout, make_event("subscribe_order_events_ack", command_id=command.command_id), command.command_id, received_at_ns)
            continue

    write_jsonl(stdout, make_event("shutdown_complete", reason="signal" if _STOP_REQUESTED else "stdin_eof"))
    return 0


def parse_command(value: Any) -> ParsedCommand | None:
    if not isinstance(value, dict):
        return None
    command_type = value.get("message_type") or value.get("type") or value.get("command_type")
    schema_version = value.get("schema_version")
    if not isinstance(command_type, str) or not isinstance(schema_version, int):
        return None
    command_id = value.get("command_id") or value.get("correlation_id")
    idempotency_key = value.get("idempotency_key")
    return ParsedCommand(
        raw=value,
        command_type=command_type,
        command_id=command_id if isinstance(command_id, str) else None,
        schema_version=schema_version,
        idempotency_key=idempotency_key if isinstance(idempotency_key, str) else None,
    )


def _start_stdin_reader(stdin: TextIO) -> queue.Queue[str | object]:
    stdin_queue: queue.Queue[str | object] = queue.Queue()

    def read_stdin() -> None:
        try:
            for line in stdin:
                stdin_queue.put(line)
        finally:
            stdin_queue.put(_STDIN_EOF)

    thread = threading.Thread(target=read_stdin, name="qfa-broker-sidecar-stdin-reader", daemon=True)
    thread.start()
    return stdin_queue


def _emit_with_latency(stdout: TextIO, event: dict[str, Any], command_id: str | None, received_at_ns: int) -> None:
    responded_at_ns = now_ns()
    write_jsonl(stdout, event)
    write_jsonl(stdout, ipc_measurement(command_id, received_at_ns, responded_at_ns))


def main(argv: list[str] | None = None) -> int:
    config = parse_args(sys.argv[1:] if argv is None else argv)
    return run(config)
