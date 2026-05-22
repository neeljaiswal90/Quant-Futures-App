"""Rithmic authentication handshake boundary using async-rithmic."""

from __future__ import annotations

import importlib
import inspect
from dataclasses import dataclass
from importlib import metadata
from typing import Any

from services.broker_session_sidecar import __version__
from services.broker_session_sidecar.credential_resolver import RithmicCredentials
from services.broker_session_sidecar.ipc.redactor import redact_text

ASYNC_RITHMIC_DISTRIBUTION = "async-rithmic"
ASYNC_RITHMIC_IMPORT_NAME = "async_rithmic"
ASYNC_RITHMIC_SDK_NAME = "async-rithmic"
ASYNC_RITHMIC_PINNED_VERSION = "1.6.1"


@dataclass(frozen=True)
class AuthResult:
    broker_session_id: str
    account_ref_redacted: str | None = None
    sdk_version: str = ASYNC_RITHMIC_PINNED_VERSION
    client: Any | None = None


class AuthDeniedError(RuntimeError):
    def __init__(self, message: object, rp_code: object | None = None) -> None:
        super().__init__(redact_text(message))
        self.rp_code = None if rp_code is None else str(rp_code)
        self.rp_message_redacted = redact_text(message)


async def authenticate(credentials: RithmicCredentials, mode: str = "test") -> AuthResult:
    if mode != "test":
        raise AuthDeniedError("live mode is out of scope for QFA-612-BROKER-01")
    try:
        async_rithmic = importlib.import_module(ASYNC_RITHMIC_IMPORT_NAME)
    except Exception as exc:  # noqa: BLE001 - import boundary intentionally normalized.
        raise AuthDeniedError(f"async-rithmic import failed: {exc}") from exc

    sdk_version = sdk_version_for(async_rithmic)
    try:
        response = await _call_gateway(async_rithmic, credentials)
    except AuthDeniedError:
        raise
    except Exception as exc:  # noqa: BLE001 - broker library errors may be arbitrary.
        raise AuthDeniedError(str(exc), _error_code(exc)) from exc

    return _auth_result_from_response(response, sdk_version)


async def disconnect_auth_result(auth_result: AuthResult) -> None:
    client = auth_result.client
    if client is None:
        return
    method = getattr(client, "disconnect", None) or getattr(client, "close", None)
    if not callable(method):
        return
    result = method()
    if inspect.isawaitable(result):
        await result


def sdk_version_for(async_rithmic_module: Any | None = None) -> str:
    if async_rithmic_module is not None:
        version = getattr(async_rithmic_module, "__version__", None)
        if isinstance(version, str) and version.strip() != "":
            return version
    try:
        return metadata.version(ASYNC_RITHMIC_DISTRIBUTION)
    except metadata.PackageNotFoundError:
        return ASYNC_RITHMIC_PINNED_VERSION


async def _call_gateway(async_rithmic: Any, credentials: RithmicCredentials) -> Any:
    authenticate_fn = getattr(async_rithmic, "authenticate", None)
    if callable(authenticate_fn):
        return await _maybe_await(authenticate_fn(
            user=credentials.user,
            password=credentials.password,
            url=_normalize_gateway_url(credentials.ws_url),
            system_name=credentials.system,
        ))

    client_factory = getattr(async_rithmic, "RithmicClient", None)
    if client_factory is None:
        raise AuthDeniedError("async-rithmic RithmicClient factory not found")
    client = _make_client(client_factory, credentials)
    connect = getattr(client, "connect", None)
    if not callable(connect):
        raise AuthDeniedError("async-rithmic client has no supported connect method")
    result = await _maybe_await(connect(**_ticker_only_connect_kwargs(async_rithmic)))
    return client if result is None else result


def _make_client(client_factory: Any, credentials: RithmicCredentials) -> Any:
    url = _normalize_gateway_url(credentials.ws_url)
    attempts = [
        {
            "user": credentials.user,
            "password": credentials.password,
            "system_name": credentials.system,
            "app_name": "qfa_broker_session_sidecar",
            "app_version": __version__,
            "url": url,
        },
        {
            "username": credentials.user,
            "password": credentials.password,
            "system": credentials.system,
            "app_name": "qfa_broker_session_sidecar",
            "app_version": __version__,
            "url": url,
        },
    ]
    last_error: TypeError | None = None
    for kwargs in attempts:
        try:
            return client_factory(**kwargs)
        except TypeError as exc:
            last_error = exc
    raise AuthDeniedError(f"async-rithmic client construction failed: {last_error}")


def _ticker_only_connect_kwargs(async_rithmic: Any) -> dict[str, Any]:
    sys_infra = getattr(async_rithmic, "SysInfraType", None)
    ticker = getattr(sys_infra, "TICKER_PLANT", None)
    if ticker is None:
        return {}
    return {"plants": [ticker]}


def _auth_result_from_response(response: Any, sdk_version: str) -> AuthResult:
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
            sdk_version=sdk_version,
            client=response.get("client"),
        )

    session_id = getattr(response, "session_id", None) or getattr(response, "broker_session_id", None) or "rithmic-test-session"
    account_ref = getattr(response, "account_ref_redacted", None)
    return AuthResult(
        broker_session_id=str(session_id),
        account_ref_redacted=account_ref if isinstance(account_ref, str) else None,
        sdk_version=sdk_version,
        client=response,
    )


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def _normalize_gateway_url(value: str) -> str:
    if value.startswith("wss://"):
        return value.removeprefix("wss://")
    if value.startswith("ws://"):
        return value.removeprefix("ws://")
    return value


def _error_code(error: object) -> object | None:
    for attr in ("rp_code", "code", "error_code"):
        value = getattr(error, attr, None)
        if value is not None:
            return value
    return None
