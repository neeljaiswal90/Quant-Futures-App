"""Failure-state emission tests for the async-rithmic sidecar."""

from __future__ import annotations

import asyncio
import io
import json
import os
import sys
from types import ModuleType
from unittest.mock import patch

from services.broker_session_sidecar.sidecar import SidecarConfig, run


def _env() -> dict[str, str]:
    return {
        "RITHMIC_TEST_USER": "test-user@example.com",
        "RITHMIC_TEST_PASSWORD": "test-password",
        "RITHMIC_TEST_WS_URL": "wss://gateway.example.invalid",
        "RITHMIC_TEST_SYSTEM": "Rithmic Test",
    }


def _success_module() -> ModuleType:
    module = ModuleType("async_rithmic")
    module.__version__ = "1.6.1"

    async def fake_authenticate(user: str, password: str, url: str, system_name: str) -> dict[str, object]:
        return {"ok": True, "session_id": "mock-session-123", "account_ref_redacted": "mock-account"}

    module.authenticate = fake_authenticate  # type: ignore[attr-defined]
    return module


def _denied_module() -> ModuleType:
    module = ModuleType("async_rithmic")
    module.__version__ = "1.6.1"

    class FakeDenied(Exception):
        rp_code = "13"

    async def fake_authenticate(user: str, password: str, url: str, system_name: str) -> dict[str, object]:
        raise FakeDenied("permission denied for test-user@example.com")

    module.authenticate = fake_authenticate  # type: ignore[attr-defined]
    return module


def _command(message_type: str, correlation_id: str, *, schema_version: int = 1, idempotency_key: str | None = None) -> dict[str, object]:
    command: dict[str, object] = {
        "schema_version": schema_version,
        "message_type": message_type,
        "direction": "command",
        "run_id": "run-1",
        "session_id": "session-1",
        "correlation_id": correlation_id,
        "causation_id": "operator",
        "event_ts_ns": "1",
        "adapter_version": "test",
        "payload": {},
    }
    if idempotency_key is not None:
        command["idempotency_key"] = idempotency_key
    return command


def _events(stdout: str) -> list[dict[str, object]]:
    return [json.loads(line) for line in stdout.splitlines() if line.strip()]


def _payload(event: dict[str, object]) -> dict[str, object]:
    payload = event.get("payload")
    return payload if isinstance(payload, dict) else event


def _failure_states(events: list[dict[str, object]]) -> list[object]:
    return [_payload(event).get("failure_state") for event in events if (event.get("message_type") or event.get("type")) == "broker_error"]


def test_auth_denied_emits_structured_broker_error_and_nonzero_exit() -> None:
    stdout = io.StringIO()
    with patch.dict(os.environ, _env(), clear=True), patch.dict(sys.modules, {"async_rithmic": _denied_module()}):
        code = asyncio.run(run(SidecarConfig(config_path=None, log_level="info", mode="test"), io.StringIO(""), stdout))

    assert code == 2
    events = _events(stdout.getvalue())
    payload = _payload(events[0])
    assert payload["failure_state"] == "auth_denied"
    assert payload["recoverable"] is False
    assert payload["rp_code"] == "13"


def test_order_command_still_returns_not_yet_implemented() -> None:
    stdout = io.StringIO()
    commands = [_command("submit_order", "submit-1", idempotency_key="intent-1")]
    stdin = io.StringIO("\n".join(json.dumps(command) for command in commands) + "\n")
    with patch.dict(os.environ, _env(), clear=True), patch.dict(sys.modules, {"async_rithmic": _success_module()}):
        code = asyncio.run(run(SidecarConfig(config_path=None, log_level="info", mode="test"), stdin, stdout))

    assert code == 0
    assert "order_path_not_yet_implemented" in _failure_states(_events(stdout.getvalue()))


def test_duplicate_and_schema_failure_states_are_preserved() -> None:
    stdout = io.StringIO()
    commands = [
        _command("heartbeat", "dup-1"),
        _command("heartbeat", "dup-1"),
        _command("heartbeat", "bad-schema", schema_version=999),
    ]
    stdin = io.StringIO("\n".join(json.dumps(command) for command in commands) + "\n")
    with patch.dict(os.environ, _env(), clear=True), patch.dict(sys.modules, {"async_rithmic": _success_module()}):
        code = asyncio.run(run(SidecarConfig(config_path=None, log_level="info", mode="test"), stdin, stdout))

    assert code == 0
    states = _failure_states(_events(stdout.getvalue()))
    assert "duplicate_command_detected" in states
    assert "schema_version_incompatible" in states
