from __future__ import annotations

from datetime import datetime

from rithmic_dashboard.audit_trail import (
    add_confluence_break_events,
    add_level_touch_events,
    dedupe_audit_entries,
    dump_audit_entries,
    load_audit_entries,
)
from rithmic_dashboard.confluence import compute_confluence_groups
from rithmic_dashboard.level_distances import compute_level_distances
from rithmic_dashboard.models import AuditEntry
from rithmic_dashboard.session_state import PT

from .conftest import sample_envelope


def test_audit_load_dump_round_trip() -> None:
    entries = [AuditEntry("2026-05-21 08:00:00 PT", "scenario_state_change", "A -> ACTIVE")]
    loaded = load_audit_entries(dump_audit_entries(entries))
    assert loaded == entries


def test_load_audit_drops_data_warning_entries() -> None:
    data = {
        "entries": [
            {
                "timestamp_pt": "2026-05-21 08:00:00 PT",
                "event_type": "data_warning",
                "description": "Zones JSON missing",
            },
            {
                "timestamp_pt": "2026-05-21 08:01:00 PT",
                "event_type": "scenario_state_change",
                "description": "Scenario A DORMANT -> WATCHING",
            },
        ]
    }
    loaded = load_audit_entries(data)
    assert len(loaded) == 1
    assert loaded[0].event_type == "scenario_state_change"


def test_audit_truncates_to_last_50() -> None:
    entries = [
        AuditEntry(f"2026-05-21 08:{idx:02d}:00 PT", "scenario_state_change", str(idx))
        for idx in range(60)
    ]
    dumped = dump_audit_entries(entries)
    assert len(dumped["entries"]) == 50


def test_dedupe_audit_collapses_identical_recent_entries() -> None:
    entries = [
        AuditEntry("2026-05-21 08:00:00 PT", "scenario_state_change", "A -> WATCHING"),
        AuditEntry("2026-05-21 08:03:00 PT", "scenario_state_change", "A -> WATCHING"),
    ]
    deduped = dedupe_audit_entries(entries)
    assert len(deduped) == 1
    assert "repeated 2 times" in deduped[0].description


def test_dedupe_audit_keeps_entries_outside_window() -> None:
    entries = [
        AuditEntry("2026-05-21 08:00:00 PT", "scenario_state_change", "A -> WATCHING"),
        AuditEntry("2026-05-21 08:06:00 PT", "scenario_state_change", "A -> WATCHING"),
    ]
    assert len(dedupe_audit_entries(entries)) == 2


def test_dedupe_audit_keeps_different_related_levels() -> None:
    entries = [
        AuditEntry("2026-05-21 08:00:00 PT", "level_crossed", "touch", "level-a"),
        AuditEntry("2026-05-21 08:01:00 PT", "level_crossed", "touch", "level-b"),
    ]
    assert len(dedupe_audit_entries(entries)) == 2


def test_level_touch_only_records_high_or_super() -> None:
    distances = compute_level_distances(sample_envelope(), 29552.5, 40.0)
    entries = add_level_touch_events([], distances, now_pt=datetime(2026, 5, 21, 8, 0, tzinfo=PT))
    assert entries
    assert all("touched" in entry.description for entry in entries)


def test_confluence_break_records_prior_sign_change() -> None:
    groups = compute_confluence_groups(sample_envelope())
    upper = max(groups, key=lambda group: group.center_price)
    prior = {f"confluence-{upper.center_price:.2f}-{upper.span_pts:.2f}": {"last_distance_pts": 5.0}}
    entries = add_confluence_break_events(
        [],
        [upper],
        current_price=upper.center_price + 1.0,
        prior_state=prior,
        now_pt=datetime(2026, 5, 21, 8, 0, tzinfo=PT),
    )
    assert len(entries) == 1
