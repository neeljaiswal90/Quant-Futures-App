"""Tests for the read-only alert-config loader."""

from __future__ import annotations

from pathlib import Path

from contracts.realtime.config import AlertConfig, default_alert_config
from notification_daemon.config_loader import load_alert_config


def test_missing_file_returns_defaults(tmp_path: Path) -> None:
    cfg = load_alert_config(tmp_path / "nope.json")
    assert cfg == default_alert_config()
    assert cfg.critical.windows_toast is True


def test_valid_file_is_loaded(tmp_path: Path) -> None:
    custom = AlertConfig()
    custom.high.windows_toast = True
    p = tmp_path / "alert_config.json"
    p.write_text(custom.model_dump_json(), encoding="utf-8")
    loaded = load_alert_config(p)
    assert loaded.high.windows_toast is True


def test_invalid_file_falls_back_to_defaults(tmp_path: Path) -> None:
    p = tmp_path / "alert_config.json"
    p.write_text("{ not valid json", encoding="utf-8")
    loaded = load_alert_config(p)
    assert loaded == default_alert_config()
