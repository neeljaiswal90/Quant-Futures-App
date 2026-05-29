"""Rithmic credentials loader.

Resolution order, highest precedence first:
    1. Environment variables (``RITHMIC_CONNECT_POINT``, ``RITHMIC_SYSTEM_NAME``,
       ``RITHMIC_USER``, ``RITHMIC_PASSWORD``, ``RITHMIC_RPROTOCOL_HOME``)
    2. ``<project_root>/.env`` — same env-var names, ``KEY=VALUE`` per line.
       Project root is the package's parent (``tools/rithmic_analytics/``).
    3. ``~/.rithmic_creds.toml`` with keys ``connect_point``, ``system_name``,
       ``user``, ``password``, ``rprotocol_home``.

Env wins so CI / scheduled-task contexts can override a developer's local
``.env`` or TOML. ``.env`` is intended for the developer-laptop case where
the env vars aren't set system-wide.

The ``.env`` parser is intentionally minimal (~15 LOC, stdlib only): no
multi-line values, no escape sequences, no ``${VAR}`` expansion. If your
secret needs any of those, use TOML.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path


class CredentialsMissing(Exception):
    """Raised when a required Rithmic credential cannot be found."""


@dataclass(frozen=True, slots=True)
class RithmicCredentials:
    """Immutable bundle of the five values the probe needs to authenticate."""

    connect_point: str
    system_name: str
    user: str
    password: str
    rprotocol_home: str


def _default_toml_path() -> Path:
    return Path.home() / ".rithmic_creds.toml"


def _default_dot_env_path() -> Path:
    """``<project_root>/.env``. Project root = the ``rithmic_analytics`` package's parent."""
    return Path(__file__).resolve().parents[2] / ".env"


def _parse_dot_env(path: Path) -> dict[str, str]:
    """Parse a ``.env`` file into a ``{KEY: VALUE}`` dict.

    Rules: skip blank lines and lines starting with ``#``; parse ``KEY=VALUE``
    pairs; strip optional matching single- or double-quotes around ``VALUE``;
    no multi-line, no escape sequences. Malformed lines (no ``=``) are
    silently skipped — ``.env`` files are not parsed strictly.
    """
    result: dict[str, str] = {}
    if not path.exists():
        return result
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key:
            result[key] = value
    return result


def load_credentials(
    *,
    toml_path: Path | None = None,
    dot_env_path: Path | None = None,
) -> RithmicCredentials:
    """Load Rithmic credentials with env > ``.env`` > TOML precedence.

    Args:
        toml_path: Optional override for testing. Defaults to
            ``~/.rithmic_creds.toml``.
        dot_env_path: Optional override for testing. Defaults to
            ``<project_root>/.env``.

    Returns:
        ``RithmicCredentials`` with all five fields populated.

    Raises:
        CredentialsMissing: If any required field is absent from all three
            sources. Message names the missing field for fast debugging.
    """
    if toml_path is None:
        toml_path = _default_toml_path()
    if dot_env_path is None:
        dot_env_path = _default_dot_env_path()

    toml_data: dict[str, str] = {}
    if toml_path.exists():
        with toml_path.open("rb") as f:
            raw = tomllib.load(f)
        toml_data = {str(k): str(v) for k, v in raw.items() if isinstance(v, str)}

    dot_env_data = _parse_dot_env(dot_env_path)

    def _resolve(env_key: str, toml_key: str) -> str:
        env_val = os.getenv(env_key)
        if env_val:
            return env_val
        dot_env_val = dot_env_data.get(env_key)
        if dot_env_val:
            return dot_env_val
        toml_val = toml_data.get(toml_key)
        if toml_val:
            return toml_val
        raise CredentialsMissing(
            f"missing credential: env {env_key} not set, "
            f"not in {dot_env_path}, and {toml_key!r} not in {toml_path}"
        )

    return RithmicCredentials(
        connect_point=_resolve("RITHMIC_CONNECT_POINT", "connect_point"),
        system_name=_resolve("RITHMIC_SYSTEM_NAME", "system_name"),
        user=_resolve("RITHMIC_USER", "user"),
        password=_resolve("RITHMIC_PASSWORD", "password"),
        rprotocol_home=_resolve("RITHMIC_RPROTOCOL_HOME", "rprotocol_home"),
    )
