"""Tests for ``rithmic_analytics.ops.credentials``."""

from __future__ import annotations

from pathlib import Path

import pytest

from rithmic_analytics.ops.credentials import (
    CredentialsMissing,
    RithmicCredentials,
    load_credentials,
)

_ALL_ENV_VARS: tuple[str, ...] = (
    "RITHMIC_CONNECT_POINT",
    "RITHMIC_SYSTEM_NAME",
    "RITHMIC_USER",
    "RITHMIC_PASSWORD",
    "RITHMIC_RPROTOCOL_HOME",
)


@pytest.fixture(autouse=True)
def _clear_rithmic_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ensure no developer's local RITHMIC_* env vars leak into tests."""
    for key in _ALL_ENV_VARS:
        monkeypatch.delenv(key, raising=False)


@pytest.fixture
def _no_dot_env(tmp_path: Path) -> Path:
    """A non-existent ``.env`` path so the loader's default resolution doesn't
    pick up the developer's real ``<project_root>/.env`` during tests."""
    return tmp_path / "no_such_dot_env"


def test_load_from_env_vars_only(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, _no_dot_env: Path
) -> None:
    monkeypatch.setenv("RITHMIC_CONNECT_POINT", "test-cp")
    monkeypatch.setenv("RITHMIC_SYSTEM_NAME", "Rithmic Test")
    monkeypatch.setenv("RITHMIC_USER", "neel-test")
    monkeypatch.setenv("RITHMIC_PASSWORD", "pw-test")
    monkeypatch.setenv("RITHMIC_RPROTOCOL_HOME", "/opt/rprotocol")

    creds = load_credentials(
        toml_path=tmp_path / "does_not_exist.toml", dot_env_path=_no_dot_env
    )

    assert creds.connect_point == "test-cp"
    assert creds.system_name == "Rithmic Test"
    assert creds.user == "neel-test"
    assert creds.password == "pw-test"
    assert creds.rprotocol_home == "/opt/rprotocol"


def test_load_from_toml_only(tmp_path: Path, _no_dot_env: Path) -> None:
    toml = tmp_path / "creds.toml"
    toml.write_text(
        'connect_point = "toml-cp"\n'
        'system_name = "Rithmic TOML"\n'
        'user = "toml-user"\n'
        'password = "toml-pw"\n'
        'rprotocol_home = "/opt/toml-rp"\n',
        encoding="utf-8",
    )

    creds = load_credentials(toml_path=toml, dot_env_path=_no_dot_env)

    assert creds.connect_point == "toml-cp"
    assert creds.user == "toml-user"
    assert creds.password == "toml-pw"


def test_env_wins_over_toml(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, _no_dot_env: Path
) -> None:
    toml = tmp_path / "creds.toml"
    toml.write_text(
        'connect_point = "toml-cp"\n'
        'system_name = "toml-sys"\n'
        'user = "toml-user"\n'
        'password = "toml-pw"\n'
        'rprotocol_home = "/opt/toml-rp"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("RITHMIC_USER", "env-user")  # only override user

    creds = load_credentials(toml_path=toml, dot_env_path=_no_dot_env)

    assert creds.user == "env-user"  # env wins
    assert creds.connect_point == "toml-cp"  # fallback to TOML
    assert creds.password == "toml-pw"


def test_missing_credential_raises_with_field_name(
    tmp_path: Path, _no_dot_env: Path
) -> None:
    # No env, no .env, no TOML → every field missing; the first one looked up raises.
    with pytest.raises(CredentialsMissing) as excinfo:
        load_credentials(
            toml_path=tmp_path / "does_not_exist.toml", dot_env_path=_no_dot_env
        )
    msg = str(excinfo.value)
    assert "RITHMIC_CONNECT_POINT" in msg
    assert "connect_point" in msg


def test_partial_creds_in_toml_raises_for_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, _no_dot_env: Path
) -> None:
    # TOML has only 3 of 5 fields, no env → missing field error.
    toml = tmp_path / "creds.toml"
    toml.write_text(
        'connect_point = "cp"\n'
        'system_name = "sys"\n'
        'user = "u"\n',
        encoding="utf-8",
    )
    with pytest.raises(CredentialsMissing) as excinfo:
        load_credentials(toml_path=toml, dot_env_path=_no_dot_env)
    assert "RITHMIC_PASSWORD" in str(excinfo.value)


def test_credentials_is_frozen(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, _no_dot_env: Path
) -> None:
    for k, v in zip(_ALL_ENV_VARS, ("a", "b", "c", "d", "e"), strict=True):
        monkeypatch.setenv(k, v)

    creds = load_credentials(toml_path=tmp_path / "x.toml", dot_env_path=_no_dot_env)

    import dataclasses

    with pytest.raises(dataclasses.FrozenInstanceError):
        creds.password = "leak"  # type: ignore[misc]


def test_returns_rithmic_credentials_type(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, _no_dot_env: Path
) -> None:
    for k, v in zip(_ALL_ENV_VARS, ("a", "b", "c", "d", "e"), strict=True):
        monkeypatch.setenv(k, v)

    creds = load_credentials(toml_path=tmp_path / "x.toml", dot_env_path=_no_dot_env)

    assert isinstance(creds, RithmicCredentials)


# ---------------------------------------------------------------------------
# .env support
# ---------------------------------------------------------------------------


def test_credentials_dot_env_loading(tmp_path: Path) -> None:
    """All five fields loaded from .env when no env vars and no TOML."""
    dot_env = tmp_path / ".env"
    dot_env.write_text(
        "# A comment that should be skipped\n"
        "\n"
        "RITHMIC_CONNECT_POINT=dot-cp\n"
        'RITHMIC_SYSTEM_NAME="Rithmic DotEnv"\n'  # double-quoted
        "RITHMIC_USER='dot-user'\n"  # single-quoted
        "RITHMIC_PASSWORD=dot-pw\n"
        "RITHMIC_RPROTOCOL_HOME=/opt/dot-rp\n"
        "MALFORMED_LINE_NO_EQUALS\n"  # silently skipped
        "  RITHMIC_IGNORED  =  but-this-key-isn't-needed  \n",  # extra whitespace
        encoding="utf-8",
    )

    creds = load_credentials(
        toml_path=tmp_path / "does_not_exist.toml", dot_env_path=dot_env
    )

    assert creds.connect_point == "dot-cp"
    assert creds.system_name == "Rithmic DotEnv"  # quotes stripped
    assert creds.user == "dot-user"  # quotes stripped
    assert creds.password == "dot-pw"
    assert creds.rprotocol_home == "/opt/dot-rp"


def test_credentials_env_var_precedence(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Environment variable beats .env when both are present."""
    dot_env = tmp_path / ".env"
    dot_env.write_text(
        "RITHMIC_CONNECT_POINT=dot-cp\n"
        "RITHMIC_SYSTEM_NAME=dot-sys\n"
        "RITHMIC_USER=dot-user\n"
        "RITHMIC_PASSWORD=dot-pw\n"
        "RITHMIC_RPROTOCOL_HOME=/opt/dot-rp\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("RITHMIC_USER", "env-user")  # only override user

    creds = load_credentials(
        toml_path=tmp_path / "does_not_exist.toml", dot_env_path=dot_env
    )

    assert creds.user == "env-user"  # env wins
    assert creds.connect_point == "dot-cp"  # rest from .env
    assert creds.password == "dot-pw"


def test_credentials_dot_env_then_toml_fallback(tmp_path: Path) -> None:
    """Partial .env, partial TOML → loader composes the full set."""
    dot_env = tmp_path / ".env"
    dot_env.write_text(
        "RITHMIC_USER=dot-user\n"
        "RITHMIC_PASSWORD=dot-pw\n",
        encoding="utf-8",
    )
    toml = tmp_path / "creds.toml"
    toml.write_text(
        'connect_point = "toml-cp"\n'
        'system_name = "toml-sys"\n'
        'user = "toml-user"\n'  # shadowed by .env
        'password = "toml-pw"\n'  # shadowed by .env
        'rprotocol_home = "/opt/toml-rp"\n',
        encoding="utf-8",
    )

    creds = load_credentials(toml_path=toml, dot_env_path=dot_env)

    assert creds.user == "dot-user"  # .env wins over TOML
    assert creds.password == "dot-pw"  # .env wins over TOML
    assert creds.connect_point == "toml-cp"  # TOML fallback
    assert creds.system_name == "toml-sys"
    assert creds.rprotocol_home == "/opt/toml-rp"
