"""Tests for settings resolution + override layering."""

from __future__ import annotations

from pathlib import Path

from realtime_backend.settings import (
    DEFAULT_CORS_ORIGINS,
    Settings,
    settings_from_env,
)


def test_defaults_match_green_lit_decisions() -> None:
    s = Settings()
    assert s.host == "127.0.0.1"
    assert s.port == 8765
    assert s.client_queue_maxsize == 256
    assert s.debounce_seconds == 0.250
    assert s.min_compute_interval_seconds == 0.500
    assert s.max_price_distance == 30.0
    assert s.tail_bytes == 20_000_000
    assert s.depth_enabled is False
    assert s.depth_emit_interval_seconds == 0.250
    assert s.depth_n_ticks == 20
    assert s.depth_seed_tail_bytes == 20_000_000
    assert s.cors_origins == DEFAULT_CORS_ORIGINS
    assert "*" not in s.cors_origins


def test_env_overrides_defaults(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RA60_HOST", "0.0.0.0")
    monkeypatch.setenv("RA60_PORT", "9001")
    monkeypatch.setenv("RA60_SESSION", "rth")
    monkeypatch.setenv("RA60_DEPTH_ENABLED", "1")
    monkeypatch.setenv("RA60_DEPTH_N_TICKS", "30")
    s = settings_from_env()
    assert s.host == "0.0.0.0"
    assert s.port == 9001
    assert s.session_override == "rth"
    assert s.depth_enabled is True
    assert s.depth_n_ticks == 30


def test_explicit_overrides_win_over_env(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RA60_PORT", "9001")
    s = settings_from_env(port=8800)
    assert s.port == 8800


def test_none_overrides_are_ignored(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RA60_PORT", "9001")
    s = settings_from_env(port=None)
    assert s.port == 9001  # env value retained


def test_resolved_calibration_path_missing_is_none(tmp_path: Path) -> None:
    s = Settings(ewma_calibration_path=tmp_path / "nope.json")
    assert s.resolved_calibration_path() is None


def test_resolved_calibration_path_present(tmp_path: Path) -> None:
    p = tmp_path / "ewma.json"
    p.write_text("{}", encoding="utf-8")
    s = Settings(ewma_calibration_path=p)
    assert s.resolved_calibration_path() == p
