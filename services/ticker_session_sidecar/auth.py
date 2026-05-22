from __future__ import annotations

from typing import Any

from .credential_resolver import TickerCredentials


class TickerAuthError(RuntimeError):
    pass


def authenticate(credentials: TickerCredentials, pyrithmic_module: Any | None = None) -> Any:
    module = pyrithmic_module
    if module is None:
        try:
            import pyrithmic as module  # type: ignore[no-redef]
        except Exception as exc:  # pragma: no cover - exercised by integration smoke only
            raise TickerAuthError(f"pyrithmic import failed: {exc}") from exc

    if hasattr(module, "authenticate"):
        return module.authenticate(
            username=credentials.username,
            password=credentials.password,
            connect_point=credentials.connect_point,
            system_name=credentials.system_name,
            plant="TICKER_PLANT",
        )

    client_cls = getattr(module, "RithmicClient", None) or getattr(module, "Rithmic", None)
    if client_cls is None:
        raise TickerAuthError("pyrithmic module does not expose a supported ticker auth entry point")

    client = client_cls(
        username=credentials.username,
        password=credentials.password,
        connect_point=credentials.connect_point,
        system_name=credentials.system_name,
    )
    for method_name in ("login", "connect", "start"):
        method = getattr(client, method_name, None)
        if callable(method):
            method(plant="TICKER_PLANT")
            return client
    return client


def sdk_version(pyrithmic_module: Any | None = None) -> str:
    module = pyrithmic_module
    if module is None:
        try:
            import pyrithmic as module  # type: ignore[no-redef]
        except Exception:
            return "unknown"
    return str(getattr(module, "__version__", "unknown"))


def infer_protocol_environment(system_name: str) -> str:
    lowered = system_name.lower()
    if "test" in lowered:
        return "rithmic_test"
    if "paper" in lowered:
        return "rithmic_paper"
    return "rithmic_live"
