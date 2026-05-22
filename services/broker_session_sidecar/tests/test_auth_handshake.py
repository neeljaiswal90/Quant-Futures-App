"""Auth handshake tests for the async-rithmic substrate."""

from __future__ import annotations

import asyncio
import os
import sys
from types import ModuleType
from unittest.mock import patch

import pytest

from services.broker_session_sidecar.auth import AuthDeniedError, authenticate
from services.broker_session_sidecar.credential_resolver import resolve_credentials


def _env() -> dict[str, str]:
    return {
        "RITHMIC_TEST_USER": "test-user@example.com",
        "RITHMIC_TEST_PASSWORD": "test-password",
        "RITHMIC_TEST_WS_URL": "wss://gateway.example.invalid",
        "RITHMIC_TEST_SYSTEM": "Rithmic Test",
    }


def test_authenticate_uses_async_rithmic_gateway_shape() -> None:
    captured: dict[str, object] = {}
    module = ModuleType("async_rithmic")
    module.__version__ = "1.6.1"

    async def fake_authenticate(user: str, password: str, url: str, system_name: str) -> dict[str, object]:
        captured.update({"user": user, "password": password, "url": url, "system_name": system_name})
        return {"ok": True, "session_id": "mock-session-123", "account_ref_redacted": "mock-account"}

    module.authenticate = fake_authenticate  # type: ignore[attr-defined]

    with patch.dict(os.environ, _env(), clear=True):
        credentials = resolve_credentials(os.environ)
    with patch.dict(sys.modules, {"async_rithmic": module}):
        result = asyncio.run(authenticate(credentials))

    assert captured == {
        "user": "test-user@example.com",
        "password": "test-password",
        "url": "gateway.example.invalid",
        "system_name": "Rithmic Test",
    }
    assert result.broker_session_id == "mock-session-123"
    assert result.account_ref_redacted == "mock-account"
    assert result.sdk_version == "1.6.1"


def test_authenticate_failure_raises_auth_denied_with_structured_fields() -> None:
    module = ModuleType("async_rithmic")
    module.__version__ = "1.6.1"

    class FakeDenied(Exception):
        rp_code = "13"

    async def fake_authenticate(user: str, password: str, url: str, system_name: str) -> dict[str, object]:
        raise FakeDenied("permission denied for test-user@example.com")

    module.authenticate = fake_authenticate  # type: ignore[attr-defined]

    with patch.dict(os.environ, _env(), clear=True):
        credentials = resolve_credentials(os.environ)
    with patch.dict(sys.modules, {"async_rithmic": module}):
        with pytest.raises(AuthDeniedError) as exc_info:
            asyncio.run(authenticate(credentials))

    assert exc_info.value.rp_code == "13"
    assert "[REDACTED:credential]" in exc_info.value.rp_message_redacted


def test_authenticate_connects_ticker_plant_only_with_client_factory() -> None:
    captured: dict[str, object] = {}
    module = ModuleType("async_rithmic")
    module.__version__ = "1.6.1"
    ticker_marker = object()

    class FakeSysInfraType:
        TICKER_PLANT = ticker_marker

    class FakeClient:
        session_id = "client-session-123"

        def __init__(self, **kwargs: object) -> None:
            captured["init"] = kwargs

        async def connect(self, **kwargs: object) -> None:
            captured["connect"] = kwargs

        async def disconnect(self) -> None:
            captured["disconnect"] = True

    module.SysInfraType = FakeSysInfraType  # type: ignore[attr-defined]
    module.RithmicClient = FakeClient  # type: ignore[attr-defined]

    with patch.dict(os.environ, _env(), clear=True):
        credentials = resolve_credentials(os.environ)
    with patch.dict(sys.modules, {"async_rithmic": module}):
        result = asyncio.run(authenticate(credentials))

    assert result.broker_session_id == "client-session-123"
    assert captured["connect"] == {"plants": [ticker_marker]}
