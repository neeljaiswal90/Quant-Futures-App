"""Resolve Rithmic broker credentials from process environment only."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping

ENV_ALIASES = {
    "user": ("RITHMIC_LUCID_USER", "RITHMIC_TEST_USER", "RITHMIC_USER"),
    "password": ("RITHMIC_LUCID_PASSWORD", "RITHMIC_TEST_PASSWORD", "RITHMIC_PASSWORD"),
    "ws_url": (
        "RITHMIC_LUCID_GATEWAY",
        "RITHMIC_LUCID_CONNECT_POINT",
        "RITHMIC_TEST_GATEWAY_URL",
        "RITHMIC_TEST_WS_URL",
        "RITHMIC_CONNECT_POINT",
    ),
    "system": (
        "RITHMIC_LUCID_SYSTEM_NAME",
        "RITHMIC_TEST_SYSTEM",
        "RITHMIC_TEST_SYSTEM_NAME",
        "RITHMIC_SYSTEM_NAME",
        "RITHMIC_SYSTEM",
    ),
}


@dataclass(frozen=True)
class RithmicCredentials:
    user: str
    password: str
    ws_url: str
    system: str


class CredentialResolutionError(RuntimeError):
    def __init__(self, missing: tuple[str, ...]) -> None:
        super().__init__("missing required Rithmic broker credential environment variables")
        self.missing = missing


def resolve_credentials(environ: Mapping[str, str]) -> RithmicCredentials:
    resolved: dict[str, str] = {}
    missing: list[str] = []
    for field, aliases in ENV_ALIASES.items():
        value = _first(environ, aliases)
        if value is None:
            missing.append("|".join(aliases))
        else:
            resolved[field] = value
    if missing:
        raise CredentialResolutionError(tuple(missing))
    return RithmicCredentials(
        user=resolved["user"],
        password=resolved["password"],
        ws_url=resolved["ws_url"],
        system=_normalize_system(resolved["system"]),
    )


def _first(environ: Mapping[str, str], names: tuple[str, ...]) -> str | None:
    for name in names:
        value = environ.get(name)
        if value is not None and value.strip() != "":
            return value
    return None


def _normalize_system(value: str) -> str:
    stripped = value.strip()
    if stripped.lower() == "tradeify":
        return "Rithmic Paper Trading"
    return stripped
