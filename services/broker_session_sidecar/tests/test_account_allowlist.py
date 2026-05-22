"""Account allowlist tests for QFA-635 substrate enforcement."""

from __future__ import annotations

import asyncio
import io
import json
import os
import sys
from types import ModuleType
from unittest.mock import patch

import pytest

from services.broker_session_sidecar.account_allowlist import AllowlistConfigError, load_allowlist_from_env
from services.broker_session_sidecar.sidecar import SidecarConfig, run


def _env() -> dict[str, str]:
    return {
        "RITHMIC_TEST_USER": "test-user@example.com",
        "RITHMIC_TEST_PASSWORD": "test-password",
        "RITHMIC_TEST_WS_URL": "wss://gateway.example.invalid",
        "RITHMIC_TEST_SYSTEM": "Rithmic Test",
    }


def _allowlist() -> list[dict[str, object]]:
    return [
        {
            "fcm_id": "TEST_FCM",
            "ib_id": "TEST_IB",
            "account_id": "TEST_ACCT_001",
            "label": "Synthetic account",
            "max_position_contracts": 2,
            "daily_loss_cap_usd": 100,
            "max_session_duration_ms": 60_000,
            "time_of_day_restriction": "unrestricted",
        }
    ]


def _success_module() -> ModuleType:
    module = ModuleType("async_rithmic")
    module.__version__ = "1.6.1"

    async def fake_authenticate(user: str, password: str, url: str, system_name: str) -> dict[str, object]:
        return {"ok": True, "session_id": "mock-session-123", "account_ref_redacted": "mock-account"}

    module.authenticate = fake_authenticate  # type: ignore[attr-defined]
    return module


def _command(message_type: str, correlation_id: str, payload: dict[str, object]) -> dict[str, object]:
    return {
        "schema_version": 1,
        "message_type": message_type,
        "direction": "command",
        "run_id": "run-1",
        "session_id": "session-1",
        "correlation_id": correlation_id,
        "causation_id": "operator",
        "event_ts_ns": "1",
        "adapter_version": "test",
        "idempotency_key": "intent-1",
        "payload": payload,
    }


def _events(stdout: str) -> list[dict[str, object]]:
    return [json.loads(line) for line in stdout.splitlines() if line.strip()]


def _payload(event: dict[str, object]) -> dict[str, object]:
    payload = event.get("payload")
    return payload if isinstance(payload, dict) else event


def test_load_allowlist_from_env_accepts_valid_json() -> None:
    env = {"QFA_BROKER_ALLOWLIST_JSON": json.dumps(_allowlist())}

    allowlist = load_allowlist_from_env(env)

    assert len(allowlist) == 1
    assert allowlist[0].account_id == "TEST_ACCT_001"


def test_load_allowlist_from_env_rejects_malformed_json() -> None:
    with pytest.raises(AllowlistConfigError):
        load_allowlist_from_env({"QFA_BROKER_ALLOWLIST_JSON": "not-json"})


def test_sidecar_rejects_command_account_id_outside_allowlist() -> None:
    stdout = io.StringIO()
    command = _command("submit_order", "submit-1", {"account_id": "OTHER"})
    stdin = io.StringIO(json.dumps(command) + "\n")
    env = {
        **_env(),
        "QFA_BROKER_ALLOWLIST_JSON": json.dumps(_allowlist()),
    }
    with patch.dict(os.environ, env, clear=True), patch.dict(sys.modules, {"async_rithmic": _success_module()}):
        code = asyncio.run(run(SidecarConfig(config_path=None, log_level="info", mode="test"), stdin, stdout))

    assert code == 0
    broker_errors = [
        _payload(event)
        for event in _events(stdout.getvalue())
        if (event.get("message_type") or event.get("type")) == "broker_error"
    ]
    assert broker_errors[0]["failure_state"] == "account_id_not_in_allowlist"
    assert [
        event.get("account_id_redacted")
        for event in _events(stdout.getvalue())
        if (event.get("message_type") or event.get("type")) == "broker_error"
    ][0] == "OT...ER"


def test_sidecar_query_account_list_stays_deferred() -> None:
    stdout = io.StringIO()
    command = {
        "schema_version": 1,
        "message_type": "query_account_list",
        "direction": "command",
        "run_id": "run-1",
        "session_id": "session-1",
        "correlation_id": "query-1",
        "causation_id": "operator",
        "event_ts_ns": "1",
        "adapter_version": "test",
        "payload": {},
    }
    stdin = io.StringIO(json.dumps(command) + "\n")
    with patch.dict(os.environ, _env(), clear=True), patch.dict(sys.modules, {"async_rithmic": _success_module()}):
        code = asyncio.run(run(SidecarConfig(config_path=None, log_level="info", mode="test"), stdin, stdout))

    assert code == 0
    states = [
        _payload(event).get("failure_state")
        for event in _events(stdout.getvalue())
        if (event.get("message_type") or event.get("type")) == "broker_error"
    ]
    assert "order_path_not_yet_implemented" in states
