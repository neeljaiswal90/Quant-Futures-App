"""Resolve Rithmic test credentials from process environment only."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping

REQUIRED_ENV_NAMES = (
    "RITHMIC_TEST_USER",
    "RITHMIC_TEST_PASSWORD",
    "RITHMIC_TEST_WS_URL",
    "RITHMIC_TEST_SYSTEM",
)


@dataclass(frozen=True)
class RithmicCredentials:
    user: str
    password: str
    ws_url: str
    system: str


class CredentialResolutionError(RuntimeError):
    def __init__(self, missing: tuple[str, ...]) -> None:
        super().__init__("missing required Rithmic test credential environment variables")
        self.missing = missing


def resolve_credentials(environ: Mapping[str, str]) -> RithmicCredentials:
    missing = tuple(name for name in REQUIRED_ENV_NAMES if not environ.get(name))
    if missing:
        raise CredentialResolutionError(missing)
    return RithmicCredentials(
        user=environ["RITHMIC_TEST_USER"],
        password=environ["RITHMIC_TEST_PASSWORD"],
        ws_url=environ["RITHMIC_TEST_WS_URL"],
        system=environ["RITHMIC_TEST_SYSTEM"],
    )
