"""Read-only load of the alert config.

RA-063 owns persistence; this daemon only *reads*. If
``data/dashboard/alert_config.json`` exists it is parsed against the
frozen :class:`AlertConfig` contract (``extra="forbid"`` — a malformed or
drifted file raises and we fall back to defaults rather than guess). If the
file is absent we use :func:`contracts.realtime.config.default_alert_config`.
"""

from __future__ import annotations

import logging
from pathlib import Path

from contracts.realtime.config import AlertConfig, default_alert_config

logger = logging.getLogger("notification_daemon.config")

# Repo-root-relative location RA-063 persists the config to.
_CONFIG_RELPATH = Path("data") / "dashboard" / "alert_config.json"


def _repo_root() -> Path:
    # services/notification_daemon/config_loader.py -> repo root
    return Path(__file__).resolve().parents[2]


def default_config_path() -> Path:
    """Absolute path the daemon reads the alert config from."""
    return _repo_root() / _CONFIG_RELPATH


def load_alert_config(path: Path | None = None) -> AlertConfig:
    """Load :class:`AlertConfig` from disk, or fall back to the default.

    Never raises: a missing file → defaults; an unreadable/invalid file is
    logged and falls back to defaults (the daemon must keep running).
    """
    cfg_path = path or default_config_path()
    if not cfg_path.exists():
        logger.info("no alert config at %s; using shipped defaults", cfg_path)
        return default_alert_config()
    try:
        text = cfg_path.read_text(encoding="utf-8")
        config = AlertConfig.model_validate_json(text)
        logger.info("loaded alert config from %s", cfg_path)
        return config
    except Exception:
        logger.warning(
            "failed to read alert config at %s; using defaults", cfg_path, exc_info=True
        )
        return default_alert_config()


__all__ = ["load_alert_config", "default_config_path"]
