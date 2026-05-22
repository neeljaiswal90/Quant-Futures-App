from __future__ import annotations

from dataclasses import dataclass
import os
from typing import Mapping


@dataclass(frozen=True)
class TickerCredentials:
    username: str
    password: str
    connect_point: str
    system_name: str


_REQUIRED_ENV = {
    "username": "RITHMIC_USER",
    "password": "RITHMIC_PASSWORD",
    "connect_point": "RITHMIC_CONNECT_POINT",
    "system_name": "RITHMIC_SYSTEM_NAME",
}


class CredentialError(RuntimeError):
    pass


def resolve_credentials(env: Mapping[str, str | None] | None = None) -> TickerCredentials:
    source = os.environ if env is None else env
    values: dict[str, str] = {}
    missing: list[str] = []
    for field, env_name in _REQUIRED_ENV.items():
        value = source.get(env_name)
        if value is None or value.strip() == "":
            missing.append(env_name)
        else:
            values[field] = value
    if missing:
        raise CredentialError("missing required TICKER_PLANT environment variables: " + ", ".join(missing))
    return TickerCredentials(**values)
