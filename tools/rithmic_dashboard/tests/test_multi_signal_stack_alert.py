from __future__ import annotations

from rithmic_dashboard.features.multi_signal_stack_alert import build_multi_signal_stack_alerts
from rithmic_dashboard.features.recent_signals_panel import RecentSignal


def test_stack_alert_requires_distinct_signal_families() -> None:
    same_family = [
        _signal("sweep", "level:ref-vah-29425.00", "VAH 29425", 29425.0, 1),
        _signal("sweep", "level:ref-vah-29425.00", "VAH 29425", 29425.0, 2),
    ]
    assert build_multi_signal_stack_alerts(recent_signals=same_family, current_price=29424.0) == []

    mixed = [
        _signal("sweep", "level:ref-vah-29425.00", "VAH 29425", 29425.0, 1),
        _signal("absorption", "level:ref-vah-29425.00", "VAH 29425", 29425.0, 2),
    ]
    alerts = build_multi_signal_stack_alerts(recent_signals=mixed, current_price=29424.0)

    assert len(alerts) == 1
    assert alerts[0].families == ("sweep", "absorption")
    assert "sweep + absorption stack" in alerts[0].description


def test_stack_alert_drops_when_price_moves_away() -> None:
    signals = [
        _signal("sweep", "level:ref-vah-29425.00", "VAH 29425", 29425.0, 1),
        _signal("absorption", "level:ref-vah-29425.00", "VAH 29425", 29425.0, 2),
    ]

    assert build_multi_signal_stack_alerts(recent_signals=signals, current_price=29380.0) == []


def _signal(
    family: str,
    zone_key: str,
    zone_text: str,
    zone_price: float,
    seq: int,
) -> RecentSignal:
    return RecentSignal(
        timestamp_pt=f"2026-05-26 06:3{seq}:00 PT",
        timestamp_ns=seq,
        event_type=f"{family}_event",
        family=family,
        icon="●",
        label=family.title(),
        level_id=None,
        level_text=zone_text,
        level_price=zone_price,
        price=zone_price,
        description=f"{family} description",
        direction="long",
        urgency="medium",
        decay_class="signal-age-fresh",
        age_minutes=1.0,
        scenario_refs=(),
        zone_key=zone_key,
        zone_text=zone_text,
        zone_price=zone_price,
        tooltip=f"{family} tooltip",
    )
