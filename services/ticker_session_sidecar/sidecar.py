from __future__ import annotations

import argparse
import os
import queue
import signal
import sys
import threading
import time
from typing import Any, TextIO

from .auth import authenticate, infer_protocol_environment, sdk_version
from .contracts.ticker_ipc_contract import TICKER_IPC_SCHEMA_VERSION, validate_ticker_ipc_envelope
from .credential_resolver import CredentialError, resolve_credentials
from .heartbeat import handle_heartbeat
from .ipc.envelope import decode_line, encode_line
from .ipc.redactor import redact_text
from .subscription import SubscriptionManager, normalize_tick

ADAPTER_VERSION = "qfa-633-live-ticker-sidecar-01"
_STDIN_EOF = object()
_STOP_REQUESTED = False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="QFA live ticker sidecar")
    parser.add_argument("--run-id", default=os.environ.get("QFA_RUN_ID", "ticker-sidecar-run"))
    parser.add_argument("--session-id", default=os.environ.get("QFA_SESSION_ID", "ticker-sidecar-session"))
    parser.add_argument("--initial-symbol", default=os.environ.get("QFA_TICKER_SYMBOL", "MNQM6"))
    parser.add_argument("--initial-exchange", default=os.environ.get("QFA_TICKER_EXCHANGE", "CME"))
    args = parser.parse_args(argv)
    return run(args, stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr)


def run(args: argparse.Namespace, *, stdin: TextIO, stdout: TextIO, stderr: TextIO) -> int:
    global _STOP_REQUESTED
    _STOP_REQUESTED = False
    _install_signal_handlers()
    command_queue: queue.Queue[str | object] = queue.Queue()
    reader = threading.Thread(target=_read_stdin, args=(stdin, command_queue), daemon=True)
    reader.start()

    try:
        credentials = resolve_credentials()
        client = authenticate(credentials)
        manager = SubscriptionManager(client)
    except (CredentialError, Exception) as exc:
        _emit(stdout, _event(
            args,
            "broker_error",
            "boot",
            {
                "failure_state": "auth_denied",
                "reason": redact_text(str(exc)),
                "recoverable": False,
                "rp_message_redacted": redact_text(str(exc)),
            },
        ))
        _log(stderr, f"auth failed: {exc}")
        return 1

    _emit(stdout, _event(
        args,
        "boot_identity",
        "boot",
        {
            "adapter_version": ADAPTER_VERSION,
            "sdk_name": "pyrithmic",
            "sdk_version": sdk_version(),
            "protocol_environment": infer_protocol_environment(credentials.system_name),
            "gateway_url_redacted": redact_text(credentials.connect_point),
            "boot_ts_ns": str(time.time_ns()),
            "process_id": os.getpid(),
            "schema_version": TICKER_IPC_SCHEMA_VERSION,
        },
    ))

    if args.initial_symbol and args.initial_exchange:
        manager.subscribe(args.initial_symbol, args.initial_exchange)
        _emit(stdout, _event(
            args,
            "subscription_accepted",
            "initial-subscribe",
            {"symbol": args.initial_symbol, "exchange": args.initial_exchange},
        ))

    while not _STOP_REQUESTED:
        try:
            item = command_queue.get(timeout=0.05)
        except queue.Empty:
            _drain_ticks(args, manager, stdout)
            continue
        if item is _STDIN_EOF:
            break
        if not isinstance(item, str) or item.strip() == "":
            continue
        try:
            command = decode_line(item)
        except Exception as exc:
            _emit(stdout, _event(args, "broker_error", "malformed-json", {
                "failure_state": "schema_version_incompatible",
                "reason": redact_text(str(exc)),
                "recoverable": True,
            }))
            continue
        validation = validate_ticker_ipc_envelope(command)
        if not validation["ok"]:
            _emit(stdout, _event(args, "broker_error", str(command.get("correlation_id", "schema-invalid")), {
                "failure_state": "schema_version_incompatible",
                "reason": "; ".join(f"{issue['path']} {issue['message']}" for issue in validation["issues"]),
                "recoverable": True,
            }))
            continue
        _handle_command(args, command, manager, stdout)
        _drain_ticks(args, manager, stdout)

    _emit(stdout, _event(args, "shutdown_complete", "shutdown", {"reason": "signal" if _STOP_REQUESTED else "stdin_closed"}))
    return 0


def _handle_command(args: argparse.Namespace, command: dict[str, Any], manager: SubscriptionManager, stdout: TextIO) -> None:
    message_type = command["message_type"]
    payload = command.get("payload", {})
    correlation_id = str(command.get("correlation_id", message_type))
    if message_type == "heartbeat":
        reply = handle_heartbeat()
        _emit(stdout, _event(args, "heartbeat_pong", correlation_id, {"pong": reply.pong}))
        return
    if message_type == "shutdown":
        global _STOP_REQUESTED
        _STOP_REQUESTED = True
        return
    if message_type == "subscribe_symbol":
        symbol = str(payload.get("symbol", ""))
        exchange = str(payload.get("exchange", ""))
        manager.subscribe(symbol, exchange)
        _emit(stdout, _event(args, "subscription_accepted", correlation_id, {"symbol": symbol, "exchange": exchange}))
        return
    if message_type == "unsubscribe_symbol":
        symbol = str(payload.get("symbol", ""))
        exchange = str(payload.get("exchange", ""))
        manager.unsubscribe(symbol, exchange)
        _emit(stdout, _event(args, "subscription_snapshot", correlation_id, {"subscriptions": manager.snapshot()}))
        return
    if message_type == "query_subscriptions":
        _emit(stdout, _event(args, "subscription_snapshot", correlation_id, {"subscriptions": manager.snapshot()}))


def _drain_ticks(args: argparse.Namespace, manager: SubscriptionManager, stdout: TextIO) -> None:
    for raw in manager.drain_ticks():
        if not isinstance(raw, dict):
            continue
        normalized = normalize_tick(raw)
        if normalized is None:
            continue
        message_type, payload = normalized
        if payload.get("tick_ts_ns") == "0":
            payload["tick_ts_ns"] = str(time.time_ns())
        if payload.get("sidecar_recv_ts_ns") == "0":
            payload["sidecar_recv_ts_ns"] = str(time.time_ns())
        _emit(stdout, _event(args, message_type, f"tick-{payload['symbol']}-{time.time_ns()}", payload))


def _event(args: argparse.Namespace, message_type: str, correlation_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": TICKER_IPC_SCHEMA_VERSION,
        "message_type": message_type,
        "direction": "event",
        "run_id": args.run_id,
        "session_id": args.session_id,
        "correlation_id": correlation_id,
        "causation_id": correlation_id,
        "event_ts_ns": str(time.time_ns()),
        "adapter_version": ADAPTER_VERSION,
        "payload": payload,
    }


def _emit(stdout: TextIO, message: dict[str, Any]) -> None:
    stdout.write(encode_line(message))
    stdout.flush()


def _log(stderr: TextIO, message: str) -> None:
    stderr.write(redact_text(message) + "\n")
    stderr.flush()


def _read_stdin(stdin: TextIO, command_queue: queue.Queue[str | object]) -> None:
    for line in stdin:
        command_queue.put(line)
    command_queue.put(_STDIN_EOF)


def _install_signal_handlers() -> None:
    def request_stop(_signum: int, _frame: Any) -> None:
        global _STOP_REQUESTED
        _STOP_REQUESTED = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, request_stop)  # type: ignore[attr-defined]


if __name__ == "__main__":
    raise SystemExit(main())
