"""Heartbeat handling tests for the async-rithmic sidecar."""

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


def _module() -> ModuleType:
    module = ModuleType("async_rithmic")
    module.__version__ = "1.6.1"

    async def fake_authenticate(user: str, password: str, url: str, system_name: str) -> dict[str, object]:
        return {"ok": True, "session_id": "mock-session-123", "account_ref_redacted": "mock-account"}

    module.authenticate = fake_authenticate  # type: ignore[attr-defined]
    return module


def _events(stdout: str) -> list[dict[str, object]]:
    return [json.loads(line) for line in stdout.splitlines() if line.strip()]


def _event_type(event: dict[str, object]) -> object:
    return event.get("message_type") or event.get("type")


def test_heartbeat_command_returns_heartbeat_pong_with_latency_event() -> None:
    command = {
        "schema_version": 1,
        "message_type": "heartbeat",
        "direction": "command",
        "run_id": "run-1",
        "session_id": "session-1",
        "correlation_id": "heartbeat-1",
        "causation_id": "operator",
        "event_ts_ns": "1",
        "adapter_version": "test",
        "payload": {},
    }
    stdout = io.StringIO()
    with patch.dict(os.environ, _env(), clear=True), patch.dict(sys.modules, {"async_rithmic": _module()}):
        code = asyncio.run(run(SidecarConfig(config_path=None, log_level="info", mode="test"), io.StringIO(json.dumps(command) + "\n"), stdout))

    assert code == 0
    event_types = [_event_type(event) for event in _events(stdout.getvalue())]
    assert "boot_identity" in event_types
    assert "heartbeat_pong" in event_types
    assert "qfa_broker_sidecar_ipc_ms" in event_types
    assert "shutdown_complete" in event_types
