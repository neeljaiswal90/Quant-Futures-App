"""Tests for the pure notification gate + quiet-hours logic."""

from __future__ import annotations

from datetime import datetime

from contracts.realtime.config import (
    AlertConfig,
    QuietHoursConfig,
    TierAlertConfig,
    default_alert_config,
)
from contracts.realtime.events import PT, RealtimeMessage, make_message
from notification_daemon.gate import NotificationGateState, in_quiet_hours, should_notify


def _critical_msg() -> RealtimeMessage:
    from contracts.realtime.events import SignalPayload

    return make_message(
        type="event",
        seq=3,
        tier="CRITICAL",
        payload=SignalPayload(
            event_type="confluence_stack",
            level_id="vpoc",
            description="CRITICAL: iceberg + absorption + sweep stacked at VPOC",
            intensity=0.95,
            confidence="high",
            metadata={"families": ["iceberg", "absorption", "sweep"]},
        ),
    )


def _high_msg() -> RealtimeMessage:
    from contracts.realtime.events import SweepPayload

    return make_message(
        type="event",
        seq=4,
        tier="HIGH",
        payload=SweepPayload(price=30085.0, direction="up", ticks_cleared=4, level_id="vah"),
    )


# Midday (12:00) is outside the default 22:00-06:00 quiet window.
_MIDDAY = datetime(2026, 5, 28, 12, 0, tzinfo=PT)


def test_critical_default_fires() -> None:
    assert should_notify(_critical_msg(), default_alert_config(), _MIDDAY) is True


def test_high_default_suppressed_by_windows_toast_flag() -> None:
    # high.windows_toast defaults False -> no toast even though enabled.
    assert should_notify(_high_msg(), default_alert_config(), _MIDDAY) is False


def test_high_opt_in_fires() -> None:
    cfg = default_alert_config()
    cfg.high = TierAlertConfig(enabled=True, windows_toast=True)
    assert should_notify(_high_msg(), cfg, _MIDDAY) is True


def test_price_less_critical_skips_proximity_gate() -> None:
    assert (
        should_notify(
            _critical_msg(), default_alert_config(), _MIDDAY, current_price=30300
        )
        is True
    )


def test_priced_event_outside_proximity_is_suppressed() -> None:
    cfg = default_alert_config()
    cfg.high = TierAlertConfig(enabled=True, windows_toast=True)
    assert should_notify(_high_msg(), cfg, _MIDDAY, current_price=30300) is False


def test_cooldown_suppresses_repeated_logical_toast() -> None:
    state = NotificationGateState()
    first = should_notify(
        _critical_msg(), default_alert_config(), _MIDDAY, state=state
    )
    second = should_notify(
        _critical_msg(), default_alert_config(), _MIDDAY, state=state
    )
    assert first is True
    assert second is False


def test_cooldown_uses_configured_seconds() -> None:
    state = NotificationGateState()
    cfg = default_alert_config().model_copy(update={"cooldown_seconds": 10})
    first = should_notify(_critical_msg(), cfg, _MIDDAY, state=state)
    within = should_notify(
        _critical_msg(),
        cfg,
        datetime(2026, 5, 28, 12, 0, 9, tzinfo=PT),
        state=state,
    )
    after = should_notify(
        _critical_msg(),
        cfg,
        datetime(2026, 5, 28, 12, 0, 11, tzinfo=PT),
        state=state,
    )
    assert first is True
    assert within is False
    assert after is True


def test_critical_disabled_does_not_fire() -> None:
    cfg = default_alert_config()
    cfg.critical = TierAlertConfig(enabled=False, windows_toast=True)
    assert should_notify(_critical_msg(), cfg, _MIDDAY) is False


def test_no_tier_does_not_fire() -> None:
    from contracts.realtime.events import HeartbeatPayload

    hb = make_message(type="heartbeat", seq=2, payload=HeartbeatPayload(server_ts_ns=1))
    assert should_notify(hb, default_alert_config(), _MIDDAY) is False


def test_quiet_hours_audio_only_keeps_toast() -> None:
    # RA-069: audio_only=True (the default) silences audio but keeps visual
    # channels, so the Windows toast still fires inside the quiet window —
    # matching realtime_backend.config.gating.should_fire.
    cfg = default_alert_config()
    cfg.quiet_hours = QuietHoursConfig(enabled=True, start_pt="22:00", end_pt="06:00")
    assert cfg.quiet_hours.audio_only is True
    # 23:30 PT is inside the wrap-around window.
    midnight_ish = datetime(2026, 5, 28, 23, 30, tzinfo=PT)
    assert should_notify(_critical_msg(), cfg, midnight_ish) is True


def test_quiet_hours_full_suppresses_toast() -> None:
    # audio_only=False = a full quiet window: the visual toast is suppressed too.
    cfg = default_alert_config()
    cfg.quiet_hours = QuietHoursConfig(
        enabled=True, start_pt="22:00", end_pt="06:00", audio_only=False
    )
    midnight_ish = datetime(2026, 5, 28, 23, 30, tzinfo=PT)
    assert should_notify(_critical_msg(), cfg, midnight_ish) is False


def test_quiet_hours_wraparound_boundaries() -> None:
    cfg = default_alert_config()
    cfg.quiet_hours = QuietHoursConfig(enabled=True, start_pt="22:00", end_pt="06:00")
    inside_early = datetime(2026, 5, 28, 5, 0, tzinfo=PT)  # before 06:00
    outside = datetime(2026, 5, 28, 6, 30, tzinfo=PT)  # after 06:00
    at_start = datetime(2026, 5, 28, 22, 0, tzinfo=PT)  # exactly start -> inside
    assert in_quiet_hours(cfg, inside_early) is True
    assert in_quiet_hours(cfg, outside) is False
    assert in_quiet_hours(cfg, at_start) is True


def test_quiet_hours_non_wrapping_window() -> None:
    cfg = default_alert_config()
    cfg.quiet_hours = QuietHoursConfig(enabled=True, start_pt="01:00", end_pt="05:00")
    assert in_quiet_hours(cfg, datetime(2026, 5, 28, 3, 0, tzinfo=PT)) is True
    assert in_quiet_hours(cfg, datetime(2026, 5, 28, 6, 0, tzinfo=PT)) is False


def test_quiet_hours_disabled_is_noop() -> None:
    cfg = default_alert_config()
    cfg.quiet_hours = QuietHoursConfig(enabled=False, start_pt="22:00", end_pt="06:00")
    midnight_ish = datetime(2026, 5, 28, 23, 30, tzinfo=PT)
    assert in_quiet_hours(cfg, midnight_ish) is False
    assert should_notify(_critical_msg(), cfg, midnight_ish) is True


def test_malformed_quiet_hours_fails_open() -> None:
    cfg = AlertConfig()
    cfg.quiet_hours = QuietHoursConfig(enabled=True, start_pt="notatime", end_pt="06:00")
    # Bad window -> treated as no quiet hours, still notifies.
    assert in_quiet_hours(cfg, _MIDDAY) is False
