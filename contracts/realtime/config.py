"""Alert-config contract type — declared by RA-067, finalized by RA-063.

RA-067 freezes the *shape* so the UI (RA-061) and daemon (RA-062) can
import and bind to it during the parallel phase. RA-063 owns the
persistence + REST get/put + hot-reload + tier-gating behavior and may
extend this model (additive only — changes go through the contract).

Mirrored in ``config.ts``; ``tests/test_parity.py`` asserts the two stay
in sync.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

CONFIG_SCHEMA_VERSION: int = 1

# Tier keys + field names mirrored as `as const` arrays in config.ts.
ALERT_TIERS: tuple[str, ...] = ("critical", "high", "medium")
ALERT_TIER_FIELDS: tuple[str, ...] = (
    "enabled",
    "audio_file",
    "browser_notif",
    "windows_toast",
)


class TierAlertConfig(BaseModel):
    """Per-tier alerting preferences."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    audio_file: str | None = None
    browser_notif: bool = False
    windows_toast: bool = False


class ProximityConfig(BaseModel):
    """How close (in points) price must be for a tier's alert to arm."""

    model_config = ConfigDict(extra="forbid")

    critical_pt: float = 50.0
    high_pt: float = 100.0
    medium_pt: float = 50.0


class QuietHoursConfig(BaseModel):
    """Optional window that silences audio while keeping visual banners."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    start_pt: str = "22:00"
    end_pt: str = "06:00"
    audio_only: bool = True


class AlertConfig(BaseModel):
    """Single source of truth for alert prefs (frontend + daemon + backend).

    RA-063 persists this to ``data/dashboard/alert_config.json`` and serves
    it over REST; this contract type is what all three consumers import.
    """

    model_config = ConfigDict(extra="forbid")

    schema_version: int = CONFIG_SCHEMA_VERSION
    critical: TierAlertConfig = Field(
        default_factory=lambda: TierAlertConfig(
            enabled=True,
            audio_file="critical_alert.wav",
            browser_notif=True,
            windows_toast=True,
        )
    )
    high: TierAlertConfig = Field(
        default_factory=lambda: TierAlertConfig(
            enabled=True,
            audio_file="high_alert.wav",
            browser_notif=True,
            windows_toast=False,
        )
    )
    medium: TierAlertConfig = Field(default_factory=TierAlertConfig)
    proximity: ProximityConfig = Field(default_factory=ProximityConfig)
    quiet_hours: QuietHoursConfig = Field(default_factory=QuietHoursConfig)


def default_alert_config() -> AlertConfig:
    """The shipped default preferences."""
    return AlertConfig()


__all__ = [
    "CONFIG_SCHEMA_VERSION",
    "ALERT_TIERS",
    "ALERT_TIER_FIELDS",
    "TierAlertConfig",
    "ProximityConfig",
    "QuietHoursConfig",
    "AlertConfig",
    "default_alert_config",
]
