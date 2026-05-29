from __future__ import annotations

from rithmic_dashboard.features.multi_signal_stack_alert import MultiSignalStackAlert
from rithmic_dashboard.features.recent_signals_panel import RecentSignal
from rithmic_dashboard.features.zone_signal_badges import build_zone_signal_badges
from rithmic_dashboard.models import LevelDistance


def test_zone_badges_group_recent_signals_by_displayed_level() -> None:
    level = LevelDistance(
        level_id="ref-vah-29425.00",
        price=29425.0,
        text="VAH 29425",
        source="vah",
        conviction="MED",
        distance_pts=1.0,
        distance_atr=0.02,
        direction="above",
        state="approaching",
    )
    recent_signals = [
        _signal("sweep", "level:ref-vah-29425.00"),
        _signal("absorption", "level:ref-vah-29425.00"),
        _signal("sweep", "level:ref-vah-29425.00"),
    ]
    badges = build_zone_signal_badges(
        distances=[level],
        recent_signals=recent_signals,
        stack_alerts=[
            MultiSignalStackAlert(
                zone_key="level:ref-vah-29425.00",
                zone_text="VAH 29425",
                zone_price=29425.0,
                families=("sweep", "absorption"),
                signal_count=3,
                latest_timestamp_pt="2026-05-26 06:32:00 PT",
                distance_pts=1.0,
                description="stack",
                tooltip="stack tooltip",
            )
        ],
    )

    level_badges = badges["ref-vah-29425.00"]
    assert [badge.family for badge in level_badges] == ["stack", "sweep", "absorption"]
    assert "2 recent" in level_badges[1].tooltip


def _signal(family: str, zone_key: str) -> RecentSignal:
    return RecentSignal(
        timestamp_pt="2026-05-26 06:32:00 PT",
        timestamp_ns=1,
        event_type=f"{family}_event",
        family=family,
        icon="●",
        label=family.title(),
        level_id="ref-vah-29425.00",
        level_text="VAH 29425",
        level_price=29425.0,
        price=29425.0,
        description=f"{family} description",
        direction="long",
        urgency="medium",
        decay_class="signal-age-fresh",
        age_minutes=1.0,
        scenario_refs=(),
        zone_key=zone_key,
        zone_text="VAH 29425",
        zone_price=29425.0,
        tooltip=f"{family} tooltip",
    )
