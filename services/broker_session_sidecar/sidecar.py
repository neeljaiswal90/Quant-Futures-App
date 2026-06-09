"""QFA broker session sidecar process."""

from __future__ import annotations

import argparse
import asyncio
import inspect
import json
import os
import signal
import sys
import threading
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Iterable, Mapping, TextIO

from services.broker_session_sidecar import __version__
from services.broker_session_sidecar.auth import (
    ASYNC_RITHMIC_IMPORT_NAME,
    ASYNC_RITHMIC_SDK_NAME,
    AuthDeniedError,
    AuthResult,
    authenticate,
    disconnect_auth_result,
)
from services.broker_session_sidecar.account_allowlist import (
    AllowlistConfigError,
    LiveAccountAllowlistEntry,
    account_id_allowed,
    command_account_id,
    load_allowlist_from_env,
    redacted_account_id,
)
from services.broker_session_sidecar.contracts.broker_ipc_contract import (
    BROKER_IPC_COMMAND_MESSAGE_TYPES,
    BROKER_IPC_COMMAND_MESSAGE_TYPES_REQUIRING_IDEMPOTENCY_KEY,
    BROKER_IPC_SCHEMA_VERSION,
)
from services.broker_session_sidecar.credential_resolver import CredentialResolutionError, resolve_credentials
from services.broker_session_sidecar.heartbeat import heartbeat_pong
from services.broker_session_sidecar.ipc.envelope import make_event, now_ns, wall_clock_ns, write_jsonl
from services.broker_session_sidecar.ipc.redactor import redact_text

_STOP_REQUESTED = False
_SEEN_COMMAND_IDS: set[str] = set()
_STDIN_EOF = object()
SUPPORTED_COMMAND_TYPES = frozenset(BROKER_IPC_COMMAND_MESSAGE_TYPES)
ORDER_PATH_COMMAND_TYPES = frozenset(BROKER_IPC_COMMAND_MESSAGE_TYPES_REQUIRING_IDEMPOTENCY_KEY)
_ORDER_CONTEXTS: dict[str, dict[str, Any]] = {}


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
    failure_payload.update(fields)
    return make_event("broker_error", command_id=command_id, payload=failure_payload)


def boot_identity(auth_result: AuthResult, config: SidecarConfig) -> dict[str, Any]:
    return make_event(
        "boot_identity",
        session_id=auth_result.broker_session_id,
        correlation_id="boot_identity",
        payload={
            "adapter_version": __version__,
            "sdk_name": ASYNC_RITHMIC_SDK_NAME,
            "sdk_version": auth_result.sdk_version,
            "protocol_environment": "rithmic_test",
            "gateway_url_redacted": auth_result.gateway_url_redacted,
            "boot_ts_ns": str(wall_clock_ns()),
            "process_id": os.getpid(),
            "schema_version": BROKER_IPC_SCHEMA_VERSION,
            "authenticated_plants": list(auth_result.authenticated_plants),
            "mode": config.mode,
            "config_path": config.config_path,
            "account_ref_redacted": auth_result.account_ref_redacted,
        },
    )


def ipc_measurement(command_id: str | None, received_at_ns: int, responded_at_ns: int) -> dict[str, Any]:
    return make_event(
        "qfa_broker_sidecar_ipc_ms",
        command_id=command_id,
        payload={
            "command_id": command_id,
            "received_at_ns": str(received_at_ns),
            "responded_at_ns": str(responded_at_ns),
            "qfa_broker_sidecar_ipc_ms": (responded_at_ns - received_at_ns) / 1_000_000,
        },
    )


def install_signal_handlers(stop_event: asyncio.Event | None = None) -> None:
    loop = asyncio.get_running_loop() if stop_event is not None else None

    def request_stop(_signum: int, _frame: object | None = None) -> None:
        global _STOP_REQUESTED
        _STOP_REQUESTED = True
        if stop_event is not None and loop is not None:
            loop.call_soon_threadsafe(stop_event.set)

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, request_stop)


async def run(config: SidecarConfig, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> int:
    global _STOP_REQUESTED
    _STOP_REQUESTED = False
    _SEEN_COMMAND_IDS.clear()
    _ORDER_CONTEXTS.clear()
    stop_event = asyncio.Event()
    install_signal_handlers(stop_event)
    auth_result: AuthResult | None = None
    try:
        try:
            allowlist = load_allowlist_from_env(os.environ)
        except AllowlistConfigError as exc:
            event = broker_error("schema_version_incompatible", "invalid broker allowlist configuration", rp_message=str(exc))
            write_jsonl(stdout, event)
            log(str(exc), "error")
            return 2

        try:
            credentials = resolve_credentials(os.environ)
            auth_result = await authenticate(credentials, mode=config.mode)
        except CredentialResolutionError as exc:
            reason = f"missing env vars: {', '.join(exc.missing)}"
            event = broker_error("auth_denied", reason, rp_message=reason, missing_env=list(exc.missing))
            write_jsonl(stdout, event)
            log(reason, "error")
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

        _install_order_notification_handler(auth_result, stdout)
        write_jsonl(stdout, boot_identity(auth_result, config))

        stdin_queue: asyncio.Queue[str | object] = asyncio.Queue()
        _start_stdin_reader(stdin, asyncio.get_running_loop(), stdin_queue)
        while not _STOP_REQUESTED:
            try:
                item = await asyncio.wait_for(stdin_queue.get(), timeout=0.05)
            except TimeoutError:
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
                _emit_with_latency(stdout, broker_error("schema_version_incompatible", f"invalid JSON command: {exc}"), None, received_at_ns)
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

            account_id = command_account_id(command.raw)
            if account_id is not None and not account_id_allowed(allowlist, account_id):
                _emit_with_latency(
                    stdout,
                    broker_error(
                        "account_id_not_in_allowlist",
                        "command account_id is not in the broker allowlist",
                        command.command_id,
                        correlated_command_idempotency_key=command.idempotency_key,
                        account_id_redacted=redacted_account_id(account_id),
                    ),
                    command.command_id,
                    received_at_ns,
                )
                continue

            try:
                event = await _handle_command(command, auth_result, allowlist)
            except Exception as exc:  # noqa: BLE001 - broker SDK errors are normalized at the IPC boundary.
                event = broker_error(
                    _failure_state_for_command(command.command_type),
                    str(exc),
                    command.command_id,
                    rp_code=_error_code(exc),
                    rp_message=str(exc),
                    correlated_command_idempotency_key=command.idempotency_key,
                )
            _emit_with_latency(stdout, event, command.command_id, received_at_ns)
            if command.command_type == "shutdown":
                return 0

        write_jsonl(stdout, make_event("shutdown_complete", payload={"reason": "signal" if _STOP_REQUESTED else "stdin_eof"}))
        return 0
    finally:
        if auth_result is not None:
            await disconnect_auth_result(auth_result)


async def _handle_command(
    command: ParsedCommand,
    auth_result: AuthResult,
    allowlist: tuple[LiveAccountAllowlistEntry, ...],
) -> dict[str, Any]:
    if command.command_type == "shutdown":
        return make_event("shutdown_complete", command_id=command.command_id, payload={})
    if command.command_type == "heartbeat":
        return heartbeat_pong(command.raw, auth_result.broker_session_id)
    if command.command_type == "query_account_list":
        return await _handle_query_account_list(command, auth_result, allowlist)
    if command.command_type == "submit_order":
        return await _handle_submit_order(command, auth_result)
    if command.command_type == "cancel_order":
        return await _handle_cancel_order(command, auth_result)
    if command.command_type == "query_order":
        return await _handle_query_order(command, auth_result)
    if command.command_type == "request_reconciliation_snapshot":
        return broker_error(
            "order_path_not_yet_implemented",
            "broker-truth reconciliation is deferred to QFA-612-BROKER-04",
            command.command_id,
            correlated_command_idempotency_key=command.idempotency_key,
        )
    if command.command_type == "subscribe_order_events":
        return make_event("subscribe_order_events_ack", command_id=command.command_id, payload={"subscribed": True})
    return broker_error("schema_version_incompatible", "unsupported broker IPC command", command.command_id)


async def _handle_query_account_list(
    command: ParsedCommand,
    auth_result: AuthResult,
    allowlist: tuple[LiveAccountAllowlistEntry, ...],
) -> dict[str, Any]:
    client = _require_client(auth_result)
    accounts = await _maybe_await(getattr(client, "list_accounts")()) if callable(getattr(client, "list_accounts", None)) else getattr(client, "accounts", [])
    return make_event(
        "account_list_snapshot",
        command_id=command.command_id,
        payload={
            "accounts": [_account_payload(account, auth_result, allowlist) for account in (accounts or [])],
            "snapshot_ts_ns": str(wall_clock_ns()),
        },
    )


async def _handle_submit_order(command: ParsedCommand, auth_result: AuthResult) -> dict[str, Any]:
    client = _require_client(auth_result)
    payload = _payload(command.raw)
    intent = _record(payload.get("intent"))
    intent_payload = _record(intent.get("payload"))
    account_id = _required_string(intent_payload, "account_id")
    order_id = command.idempotency_key or command.command_id or _required_string(intent_payload, "order_intent_id")
    symbol = _instrument_symbol(intent_payload)
    exchange = str(intent_payload.get("exchange") or "CME")
    quantity = int(intent_payload.get("quantity") or 0)
    if quantity <= 0:
        raise ValueError("order quantity must be positive")
    order_type = _sdk_order_type(intent_payload.get("order_type"))
    transaction_type = _sdk_transaction_type(intent_payload.get("side"))
    kwargs: dict[str, Any] = {"account_id": account_id}
    if "limit_price" in intent_payload:
        kwargs["price"] = float(intent_payload["limit_price"])
    submit = getattr(client, "submit_order")
    response = await _maybe_await(submit(order_id, symbol, exchange, qty=quantity, order_type=order_type, transaction_type=transaction_type, **kwargs))
    broker_order_id = _broker_order_id(response, fallback=order_id)
    context = {
        "intent_id": str(intent.get("event_id") or intent_payload.get("order_intent_id") or order_id),
        "submission_ack_id": f"submission-{order_id}",
        "broker_order_id": broker_order_id,
        "broker_account_id": account_id,
        "instrument_symbol": symbol,
    }
    _remember_order_context(order_id, broker_order_id, response, context)
    return make_event("order_accepted", command_id=command.command_id, payload=context)


async def _handle_cancel_order(command: ParsedCommand, auth_result: AuthResult) -> dict[str, Any]:
    client = _require_client(auth_result)
    payload = _payload(command.raw)
    request = _record(payload.get("request"))
    order_id = str(request.get("broker_order_id") or request.get("order_id") or request.get("submission_ack_id") or "")
    if order_id == "":
        raise ValueError("cancel_order requires order_id, broker_order_id, or submission_ack_id")
    account_id = str(request.get("account_id") or _context_for(order_id).get("broker_account_id") or "")
    kwargs = {"order_id": order_id}
    if account_id != "":
        kwargs["account_id"] = account_id
    cancel = getattr(client, "cancel_order")
    response = await _maybe_await(cancel(**kwargs))
    context = _context_for(order_id)
    event_payload = {
        "intent_id": str(request.get("intent_id") or context.get("intent_id") or order_id),
        "submission_ack_id": str(request.get("submission_ack_id") or context.get("submission_ack_id") or f"submission-{order_id}"),
        "cancel_ack_id": f"cancel-{command.command_id or order_id}",
        "broker_order_id": _broker_order_id(response, fallback=str(context.get("broker_order_id") or order_id)),
        "broker_account_id": str(account_id or context.get("broker_account_id") or "unknown-account"),
        "cancel_reason": "CLIENT_REQUESTED",
    }
    return make_event("order_cancelled", command_id=command.command_id, payload=event_payload)


async def _handle_query_order(command: ParsedCommand, auth_result: AuthResult) -> dict[str, Any]:
    client = _require_client(auth_result)
    payload = _payload(command.raw)
    order_id = str(payload.get("broker_order_id") or payload.get("order_id") or payload.get("client_order_id") or command.idempotency_key or "")
    if order_id == "":
        raise ValueError("query_order requires order_id or broker_order_id")
    get_order = getattr(client, "get_order", None)
    response = await _maybe_await(get_order(order_id=order_id, account_id=payload.get("account_id"))) if callable(get_order) else None
    context = _context_for(order_id)
    return make_event(
        "order_acknowledged",
        command_id=command.command_id,
        payload={
            "intent_id": str(payload.get("intent_id") or context.get("intent_id") or order_id),
            "submission_ack_id": str(context.get("submission_ack_id") or f"submission-{order_id}"),
            "broker_order_id": _broker_order_id(response, fallback=str(context.get("broker_order_id") or order_id)),
            "broker_account_id": str(payload.get("account_id") or context.get("broker_account_id") or getattr(response, "account_id", "unknown-account")),
            "instrument_symbol": str(context.get("instrument_symbol") or getattr(response, "symbol", "MNQM6")),
        },
    )


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


def _start_stdin_reader(stdin: TextIO, loop: asyncio.AbstractEventLoop, stdin_queue: asyncio.Queue[str | object]) -> None:
    def read_stdin() -> None:
        try:
            for line in stdin:
                loop.call_soon_threadsafe(stdin_queue.put_nowait, line)
        finally:
            loop.call_soon_threadsafe(stdin_queue.put_nowait, _STDIN_EOF)

    thread = threading.Thread(target=read_stdin, name="qfa-broker-sidecar-stdin-reader", daemon=True)
    thread.start()


def _emit_with_latency(stdout: TextIO, event: dict[str, Any], command_id: str | None, received_at_ns: int) -> None:
    responded_at_ns = now_ns()
    write_jsonl(stdout, event)
    write_jsonl(stdout, ipc_measurement(command_id, received_at_ns, responded_at_ns))


def _install_order_notification_handler(auth_result: AuthResult, stdout: TextIO) -> None:
    client = auth_result.client
    event = getattr(client, "on_exchange_order_notification", None) if client is not None else None
    if event is None:
        return

    async def on_notification(notification: Any) -> None:
        mapped = _event_from_order_notification(notification)
        if mapped is not None:
            write_jsonl(stdout, mapped)

    try:
        event += on_notification
    except TypeError:
        add = getattr(event, "append", None) or getattr(event, "add", None)
        if callable(add):
            add(on_notification)


def _event_from_order_notification(notification: Any) -> dict[str, Any] | None:
    order_id = str(getattr(notification, "user_tag", None) or getattr(notification, "order_id", None) or getattr(notification, "basket_id", ""))
    context = _context_for(order_id)
    notify_type = str(getattr(notification, "notify_type", "")).lower()
    base = {
        "intent_id": str(context.get("intent_id") or order_id),
        "submission_ack_id": str(context.get("submission_ack_id") or f"submission-{order_id}"),
        "broker_order_id": str(context.get("broker_order_id") or order_id),
        "broker_account_id": str(getattr(notification, "account_id", None) or context.get("broker_account_id") or "unknown-account"),
        "instrument_symbol": str(getattr(notification, "symbol", None) or context.get("instrument_symbol") or "MNQM6"),
    }
    if "fill" in notify_type:
        return make_event(
            "order_filled",
            correlation_id=order_id or "order_filled",
            payload={
                **base,
                "fill_ack_id": f"fill-{order_id}",
                "fill_qty": _number(getattr(notification, "fill_size", None) or getattr(notification, "qty", None) or 0),
                "fill_price": _number(getattr(notification, "fill_price", None) or getattr(notification, "price", None) or 0),
            },
        )
    if "cancel" in notify_type:
        return make_event(
            "order_cancelled",
            correlation_id=order_id or "order_cancelled",
            payload={**base, "cancel_ack_id": f"cancel-{order_id}", "cancel_reason": "BROKER_INITIATED"},
        )
    if "reject" in notify_type:
        return make_event(
            "order_rejected",
            correlation_id=order_id or "order_rejected",
            payload={
                **base,
                "failure_state": "order_submit_rejected",
                "reason": redact_text(getattr(notification, "text", "order rejected")),
                "recoverable": False,
            },
        )
    return None


def _require_client(auth_result: AuthResult) -> Any:
    if auth_result.client is None:
        raise RuntimeError("authenticated async-rithmic client is unavailable")
    return auth_result.client


def _payload(command: Mapping[str, Any]) -> dict[str, Any]:
    return _record(command.get("payload"))


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _required_string(record: Mapping[str, Any], field: str) -> str:
    value = record.get(field)
    if not isinstance(value, str) or value.strip() == "":
        raise ValueError(f"required field missing: {field}")
    return value


def _instrument_symbol(intent_payload: Mapping[str, Any]) -> str:
    return str(
        intent_payload.get("security_code")
        or intent_payload.get("instrument_symbol")
        or intent_payload.get("active_contract")
        or intent_payload.get("symbol")
        or "MNQM6"
    )


def _sdk_order_type(value: Any) -> Any:
    module = _async_rithmic_module()
    order_type = getattr(module, "OrderType", None)
    key = {
        "market": "MARKET",
        "limit": "LIMIT",
        "limit_post_only": "LIMIT",
        "stop_market": "STOP_MARKET",
    }.get(str(value), str(value).upper())
    return getattr(order_type, key, key) if order_type is not None else key


def _sdk_transaction_type(value: Any) -> Any:
    module = _async_rithmic_module()
    transaction_type = getattr(module, "TransactionType", None)
    key = "BUY" if value == "buy" else "SELL"
    return getattr(transaction_type, key, key) if transaction_type is not None else key


def _async_rithmic_module() -> Any:
    try:
        import importlib
        return importlib.import_module(ASYNC_RITHMIC_IMPORT_NAME)
    except Exception:
        return object()


def _account_payload(
    account: Any,
    auth_result: AuthResult,
    allowlist: tuple[LiveAccountAllowlistEntry, ...],
) -> dict[str, Any]:
    account_id = str(getattr(account, "account_id", None) or _mapping_get(account, "account_id") or "")
    allowlist_entry = next((entry for entry in allowlist if entry.account_id == account_id), None)
    fcm_id = (
        getattr(account, "fcm_id", None)
        or _mapping_get(account, "fcm_id")
        or (allowlist_entry.fcm_id if allowlist_entry else getattr(auth_result.client, "fcm_id", ""))
    )
    ib_id = (
        getattr(account, "ib_id", None)
        or _mapping_get(account, "ib_id")
        or (allowlist_entry.ib_id if allowlist_entry else getattr(auth_result.client, "ib_id", ""))
    )
    return {
        "fcm_id": str(fcm_id),
        "ib_id": str(ib_id),
        "account_id": account_id,
        **_optional_str("account_name", getattr(account, "account_name", None) or _mapping_get(account, "account_name")),
        **_optional_str("account_currency", getattr(account, "account_currency", None) or _mapping_get(account, "account_currency")),
        **_optional_bool("account_auto_liquidate", getattr(account, "account_auto_liquidate", None) or _mapping_get(account, "account_auto_liquidate")),
    }


def _mapping_get(value: Any, key: str) -> Any:
    return value.get(key) if isinstance(value, Mapping) else None


def _optional_str(key: str, value: Any) -> dict[str, str]:
    return {key: str(value)} if value is not None else {}


def _optional_bool(key: str, value: Any) -> dict[str, bool]:
    return {key: bool(value)} if value is not None else {}


def _broker_order_id(response: Any, *, fallback: str) -> str:
    for attr in ("basket_id", "order_id", "user_tag", "broker_order_id"):
        value = getattr(response, attr, None)
        if value is not None and str(value) != "":
            return str(value)
    if isinstance(response, Mapping):
        for key in ("basket_id", "order_id", "user_tag", "broker_order_id"):
            value = response.get(key)
            if value is not None and str(value) != "":
                return str(value)
    return fallback


def _remember_order_context(order_id: str, broker_order_id: str, response: Any, context: dict[str, Any]) -> None:
    keys = {order_id, broker_order_id}
    for attr in ("basket_id", "order_id", "user_tag", "broker_order_id"):
        value = getattr(response, attr, None)
        if value is not None:
            keys.add(str(value))
    for key in keys:
        if key != "":
            _ORDER_CONTEXTS[key] = context


def _context_for(order_id: str) -> dict[str, Any]:
    return _ORDER_CONTEXTS.get(order_id, {})


def _number(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


async def _maybe_await(value: Any) -> Any:
    if asyncio.iscoroutine(value) or isinstance(value, Awaitable):
        return await value
    return value


def _error_code(error: object) -> object | None:
    for attr in ("rp_code", "code", "error_code"):
        value = getattr(error, attr, None)
        if value is not None:
            return value
    return None


def _failure_state_for_command(command_type: str) -> str:
    if command_type == "submit_order":
        return "order_submit_rejected"
    if command_type in {"cancel_order", "query_order"}:
        return "order_status_unknown"
    if command_type == "request_reconciliation_snapshot":
        return "position_reconciliation_failed"
    return "broker_disconnected"


def main(argv: list[str] | None = None) -> int:
    config = parse_args(sys.argv[1:] if argv is None else argv)
    return asyncio.run(run(config))
