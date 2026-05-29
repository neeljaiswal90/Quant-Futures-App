"""Truth-table + edge tests for :func:`should_fire`.

Covers each tier x in/out proximity x quiet-hours on/off, plus the
audio-only-vs-full suppression split and the midnight-wrapping window.
"""

from __future__ import annotations

from datetime import datetime

import pytest
from contracts.realtime.config import (
    ALERT_TIERS,
    AlertConfig,
    ProximityConfig,
    QuietHoursConfig,
    TierAlertConfig,
)
from contracts.realtime.events import PT

from realtime_backend.config.gating import (
    REASON_FIRE,
    REASON_OUT_OF_RANGE,
    REASON_QUIET_HOURS_AUDIO,
    REASON_QUIET_HOURS_FULL,
    REASON_TIER_DISABLED,
    should_fire,
)

# Every tier enabled with all three channels on, generous proximity, so a
# suppression in a test is unambiguously caused by the dimension under test.
_FULL_TIER = TierAlertConfig(
    enabled=True, audio_file="x.wav", browser_notif=True, windows_toast=True
)
_PROX = ProximityConfig(critical_pt=50.0, high_pt=100.0, medium_pt=50.0)

# Times in PT: one inside the default 22:00-06:00 quiet window, one outside.
_INSIDE_QUIET = datetime(2026, 5, 21, 23, 30, tzinfo=PT)  # 23:30 -> inside
_OUTSIDE_QUIET = datetime(2026, 5, 21, 12, 0, tzinfo=PT)  # 12:00 -> outside


def _config(quiet: QuietHoursConfig | None = None) -> AlertConfig:
    return AlertConfig(
        schema_version=1,
        critical=_FULL_TIER.model_copy(),
        high=_FULL_TIER.model_copy(),
        medium=_FULL_TIER.model_copy(),
        proximity=_PROX.model_copy(),
        quiet_hours=quiet or QuietHoursConfig(enabled=False),
    )


def _prox_for(tier: str) -> float:
    return float(getattr(_PROX, f"{tier}_pt"))


# --------------------------------------------------------------------------
# Core truth table: tier x in/out proximity x quiet on/off
# --------------------------------------------------------------------------


@pytest.mark.parametrize("tier", ALERT_TIERS)
@pytest.mark.parametrize("in_range", [True, False])
@pytest.mark.parametrize("quiet_on", [True, False])
def test_truth_table(tier: str, in_range: bool, quiet_on: bool) -> None:
    threshold = _prox_for(tier)
    distance = threshold - 1.0 if in_range else threshold + 1.0
    now = _INSIDE_QUIET if quiet_on else _OUTSIDE_QUIET
    # Default quiet window (audio_only=True) is always "enabled"; whether it
    # bites depends on the clock (now).
    cfg = _config(QuietHoursConfig(enabled=True, audio_only=True))

    disp = should_fire(cfg, tier, distance, now)

    if not in_range:
        assert disp.fire is False
        assert disp.reason == REASON_OUT_OF_RANGE
        return

    if quiet_on:
        # audio_only: visual channels still fire, audio suppressed.
        assert disp.reason == REASON_QUIET_HOURS_AUDIO
        assert disp.audio is False
        assert disp.browser_notif is True
        assert disp.windows_toast is True
        assert disp.fire is True
    else:
        assert disp.reason == REASON_FIRE
        assert disp.audio is True
        assert disp.browser_notif is True
        assert disp.windows_toast is True
        assert disp.fire is True


# --------------------------------------------------------------------------
# Tier master switch
# --------------------------------------------------------------------------


@pytest.mark.parametrize("tier", ALERT_TIERS)
def test_disabled_tier_never_fires(tier: str) -> None:
    cfg = _config()
    disabled = getattr(cfg, tier).model_copy(update={"enabled": False})
    cfg = cfg.model_copy(update={tier: disabled})
    disp = should_fire(cfg, tier, 0.0, _OUTSIDE_QUIET)
    assert disp.fire is False
    assert disp.reason == REASON_TIER_DISABLED


# --------------------------------------------------------------------------
# Proximity edge
# --------------------------------------------------------------------------


@pytest.mark.parametrize("tier", ALERT_TIERS)
def test_distance_exactly_at_threshold_arms(tier: str) -> None:
    cfg = _config()
    disp = should_fire(cfg, tier, _prox_for(tier), _OUTSIDE_QUIET)
    assert disp.fire is True


@pytest.mark.parametrize("tier", ALERT_TIERS)
def test_negative_distance_uses_magnitude(tier: str) -> None:
    cfg = _config()
    disp = should_fire(cfg, tier, -(_prox_for(tier) - 1.0), _OUTSIDE_QUIET)
    assert disp.fire is True


# --------------------------------------------------------------------------
# Quiet-hours full suppression vs audio-only
# --------------------------------------------------------------------------


def test_quiet_hours_full_suppresses_whole_tier() -> None:
    cfg = _config(QuietHoursConfig(enabled=True, audio_only=False))
    disp = should_fire(cfg, "critical", 1.0, _INSIDE_QUIET)
    assert disp.fire is False
    assert disp.audio is False
    assert disp.browser_notif is False
    assert disp.windows_toast is False
    assert disp.reason == REASON_QUIET_HOURS_FULL


def test_quiet_hours_disabled_does_not_suppress() -> None:
    cfg = _config(QuietHoursConfig(enabled=False, audio_only=True))
    disp = should_fire(cfg, "critical", 1.0, _INSIDE_QUIET)
    # Even though `now` is in the window, the feature is off.
    assert disp.reason == REASON_FIRE
    assert disp.audio is True


def test_audio_only_with_no_visual_channels_does_not_fire() -> None:
    """Audio-only quiet hours + a tier with only audio configured -> no fire."""
    audio_only_tier = TierAlertConfig(
        enabled=True, audio_file="x.wav", browser_notif=False, windows_toast=False
    )
    cfg = _config(QuietHoursConfig(enabled=True, audio_only=True)).model_copy(
        update={"critical": audio_only_tier}
    )
    disp = should_fire(cfg, "critical", 1.0, _INSIDE_QUIET)
    assert disp.fire is False
    assert disp.audio is False
    assert disp.reason == REASON_QUIET_HOURS_AUDIO


def test_tier_without_audio_file_has_no_audio_channel() -> None:
    no_audio = TierAlertConfig(
        enabled=True, audio_file=None, browser_notif=True, windows_toast=False
    )
    cfg = _config().model_copy(update={"high": no_audio})
    disp = should_fire(cfg, "high", 1.0, _OUTSIDE_QUIET)
    assert disp.audio is False
    assert disp.browser_notif is True
    assert disp.fire is True


# --------------------------------------------------------------------------
# Wrap-around window mechanics
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("hour", "minute", "expected_quiet"),
    [
        (22, 0, True),    # start boundary inside (half-open)
        (23, 59, True),   # late evening inside
        (0, 30, True),    # after midnight inside
        (5, 59, True),    # just before end inside
        (6, 0, False),    # end boundary outside (half-open)
        (6, 1, False),    # after end outside
        (12, 0, False),   # midday outside
        (21, 59, False),  # just before start outside
    ],
)
def test_wraparound_window_boundaries(hour: int, minute: int, expected_quiet: bool) -> None:
    cfg = _config(QuietHoursConfig(enabled=True, start_pt="22:00", end_pt="06:00", audio_only=True))
    now = datetime(2026, 5, 21, hour, minute, tzinfo=PT)
    disp = should_fire(cfg, "critical", 1.0, now)
    if expected_quiet:
        assert disp.reason == REASON_QUIET_HOURS_AUDIO
        assert disp.audio is False
    else:
        assert disp.reason == REASON_FIRE
        assert disp.audio is True


def test_same_day_window() -> None:
    """A non-wrapping window (start < end) bites only inside the range."""
    cfg = _config(QuietHoursConfig(enabled=True, start_pt="09:00", end_pt="17:00", audio_only=True))
    inside = datetime(2026, 5, 21, 12, 0, tzinfo=PT)
    outside = datetime(2026, 5, 21, 20, 0, tzinfo=PT)
    assert should_fire(cfg, "critical", 1.0, inside).reason == REASON_QUIET_HOURS_AUDIO
    assert should_fire(cfg, "critical", 1.0, outside).reason == REASON_FIRE


def test_naive_now_treated_as_pt() -> None:
    """A naive datetime is assumed to be PT wall-clock (no crash, no shift)."""
    cfg = _config(QuietHoursConfig(enabled=True, start_pt="22:00", end_pt="06:00", audio_only=True))
    naive_inside = datetime(2026, 5, 21, 23, 30)  # noqa: DTZ001 - intentional naive
    disp = should_fire(cfg, "critical", 1.0, naive_inside)
    assert disp.reason == REASON_QUIET_HOURS_AUDIO


def test_tz_aware_non_pt_now_is_normalized() -> None:
    """An instant given in another tz is converted to PT before comparison."""
    from zoneinfo import ZoneInfo

    # 02:30 US/Eastern == 23:30 PT (same instant) -> inside the PT quiet window.
    eastern = datetime(2026, 5, 22, 2, 30, tzinfo=ZoneInfo("America/New_York"))
    cfg = _config(QuietHoursConfig(enabled=True, start_pt="22:00", end_pt="06:00", audio_only=True))
    disp = should_fire(cfg, "critical", 1.0, eastern)
    assert disp.reason == REASON_QUIET_HOURS_AUDIO
