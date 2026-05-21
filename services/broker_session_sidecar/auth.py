"""Rithmic authentication handshake boundary."""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from typing import Any

from services.broker_session_sidecar.credential_resolver import RithmicCredentials
from services.broker_session_sidecar.ipc.redactor import redact_text


@dataclass(frozen=True)
class AuthResult:
    broker_session_id: str
    account_ref_redacted: str | None = None


class AuthDeniedError(RuntimeError):
    def __init__(self, message: object, rp_code: object | None = None) -> None:
        super().__init__(redact_text(message))
        self.rp_code = None if rp_code is None else str(rp_code)
        self.rp_message_redacted = redact_text(message)


def authenticate(credentials: RithmicCredentials, mode: str = "test") -> AuthResult:
    if mode != "test":
        raise AuthDeniedError("live mode is out of scope for QFA-612-BROKER-01")
    try:
        pyrithmic = importlib.import_module("pyrithmic")
    except Exception as exc:  # noqa: BLE001 - import boundary intentionally normalized.
        raise AuthDeniedError(f"pyrithmic import failed: {exc}") from exc

    try:
        response = _call_gateway(pyrithmic, credentials)
    except AuthDeniedError:
        raise
    except Exception as exc:  # noqa: BLE001 - broker library errors may be arbitrary.
        raise AuthDeniedError(str(exc), getattr(exc, "rp_code", None)) from exc

    if isinstance(response, dict):
        ok = response.get("ok", response.get("authenticated", True))
        if ok is False:
            raise AuthDeniedError(
                response.get("rp_message") or response.get("message") or "Rithmic authentication denied",
                response.get("rp_code"),
            )
        return AuthResult(
            broker_session_id=str(response.get("session_id") or response.get("broker_session_id") or "rithmic-test-session"),
            account_ref_redacted=response.get("account_ref_redacted") if isinstance(response.get("account_ref_redacted"), str) else None,
        )

    session_id = getattr(response, "session_id", None) or getattr(response, "broker_session_id", None) or "rithmic-test-session"
    return AuthResult(broker_session_id=str(session_id), account_ref_redacted=None)


def _call_gateway(pyrithmic: Any, credentials: RithmicCredentials) -> Any:
    if hasattr(pyrithmic, "authenticate"):
        return pyrithmic.authenticate(
            user=credentials.user,
            password=credentials.password,
            ws_url=credentials.ws_url,
            system=credentials.system,
        )
    client_factory = getattr(pyrithmic, "Client", None) or getattr(pyrithmic, "RithmicClient", None) or getattr(pyrithmic, "Rithmic", None)
    if client_factory is None:
        raise AuthDeniedError("pyrithmic client factory not found")
    client = client_factory(
        username=credentials.user,
        password=credentials.password,
        url=credentials.ws_url,
        system=credentials.system,
    )
    for method_name in ("login", "connect", "authenticate"):
        method = getattr(client, method_name, None)
        if callable(method):
            result = method()
            return client if result is None else result
    raise AuthDeniedError("pyrithmic client has no supported auth method")
