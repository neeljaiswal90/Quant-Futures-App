from __future__ import annotations

from datetime import datetime

import pytest

from rithmic_dashboard.models import AuditEntry
from rithmic_dashboard.scenario_state import compute_scenario_states, reset_store_for_session
from rithmic_dashboard.session_state import PT

from .conftest import sample_envelope


def test_all_current_scenarios_render() -> None:
    audit: list[AuditEntry] = []
    states = compute_scenario_states(sample_envelope(), 29240.0, 40.0, audit)
    assert {state.scenario_id for state in states} == {
        "A",
        "B1",
        "B2",
        "C",
        "D",
        "E",
        "G",
        "J",
        "L",
        "M",
    }


def test_scenario_a_active_inside_vpoc_zone() -> None:
    audit: list[AuditEntry] = []
    states = compute_scenario_states(sample_envelope(), 29237.5, 40.0, audit)
    scenario_a = next(state for state in states if state.scenario_id == "A")
    assert scenario_a.state == "ACTIVE"
    assert scenario_a.entry_zone_low == pytest.approx(29232.5)


def test_scenario_far_from_entry_is_dormant() -> None:
    audit: list[AuditEntry] = []
    states = compute_scenario_states(sample_envelope(), 29000.0, 40.0, audit)
    scenario_e = next(state for state in states if state.scenario_id == "E")
    assert scenario_e.state == "DORMANT"


def test_state_transition_appends_audit_entry() -> None:
    audit: list[AuditEntry] = []
    store = {"2026-05-21_rth_A": {"state": "DORMANT"}}
    compute_scenario_states(
        sample_envelope(),
        29237.5,
        40.0,
        audit,
        store,
        session_key="2026-05-21_rth",
        now_pt=datetime(2026, 5, 21, 8, 0, tzinfo=PT),
    )
    assert any("Scenario A DORMANT -> ACTIVE" in entry.description for entry in audit)


def test_completed_state_persists() -> None:
    audit: list[AuditEntry] = []
    store = {"2026-05-21_rth_A": {"state": "COMPLETED"}}
    states = compute_scenario_states(
        sample_envelope(),
        29237.5,
        40.0,
        audit,
        store,
        session_key="2026-05-21_rth",
    )
    scenario_a = next(state for state in states if state.scenario_id == "A")
    assert scenario_a.state == "COMPLETED"


def test_r_multiple_for_long_target_is_positive() -> None:
    audit: list[AuditEntry] = []
    states = compute_scenario_states(sample_envelope(), 29237.5, 40.0, audit)
    scenario_a = next(state for state in states if state.scenario_id == "A")
    assert scenario_a.r_multiple_t1 > 0


def test_scenario_a_uses_nearby_support_stop_for_interpretable_r() -> None:
    envelope = sample_envelope()
    envelope["vpoc"] = 29235.0
    envelope["zones"].append(
        {
            "id": "hvn-29220",
            "top": 29225.0,
            "bot": 29220.0,
            "type": "support",
            "conviction": "MED",
            "text": "HVN 1.7%",
            "sources": ["hvn_rth"],
        }
    )
    audit: list[AuditEntry] = []
    states = compute_scenario_states(envelope, 29500.0, 40.0, audit)
    scenario_a = next(state for state in states if state.scenario_id == "A")
    assert 29210.0 <= scenario_a.stop <= 29220.0
    assert scenario_a.r_multiple_t1 >= 3.0


def test_watching_hysteresis_holds_until_more_than_2_2_atr() -> None:
    audit: list[AuditEntry] = []
    store = {"2026-05-21_rth_B2": {"state": "WATCHING"}}
    envelope = sample_envelope()
    plus1 = 29441.8
    price_inside_demote_buffer = plus1 - (2.1 * 40.0)
    states = compute_scenario_states(
        envelope,
        price_inside_demote_buffer,
        40.0,
        audit,
        store,
        session_key="2026-05-21_rth",
    )
    scenario_b2 = next(state for state in states if state.scenario_id == "B2")
    assert scenario_b2.state == "WATCHING"


def test_watching_hysteresis_demotes_after_2_2_atr() -> None:
    audit: list[AuditEntry] = []
    store = {"2026-05-21_rth_B2": {"state": "WATCHING"}}
    envelope = sample_envelope()
    plus1 = 29441.8
    price_outside_demote_buffer = plus1 - (2.3 * 40.0)
    states = compute_scenario_states(
        envelope,
        price_outside_demote_buffer,
        40.0,
        audit,
        store,
        session_key="2026-05-21_rth",
    )
    scenario_b2 = next(state for state in states if state.scenario_id == "B2")
    assert scenario_b2.state == "DORMANT"


def test_active_state_keeps_five_point_exit_buffer() -> None:
    audit: list[AuditEntry] = []
    store = {"2026-05-21_rth_A": {"state": "ACTIVE"}}
    states = compute_scenario_states(
        sample_envelope(),
        29231.0,
        40.0,
        audit,
        store,
        session_key="2026-05-21_rth",
    )
    scenario_a = next(state for state in states if state.scenario_id == "A")
    assert scenario_a.state == "ACTIVE"


def test_active_state_returns_to_watching_after_exit_buffer() -> None:
    audit: list[AuditEntry] = []
    store = {"2026-05-21_rth_A": {"state": "ACTIVE"}}
    states = compute_scenario_states(
        sample_envelope(),
        29226.0,
        40.0,
        audit,
        store,
        session_key="2026-05-21_rth",
    )
    scenario_a = next(state for state in states if state.scenario_id == "A")
    assert scenario_a.state == "WATCHING"


def test_sigma_scalp_stops_are_capped_to_atr() -> None:
    audit: list[AuditEntry] = []
    states = compute_scenario_states(sample_envelope(), 29237.5, 40.0, audit)
    b1 = next(state for state in states if state.scenario_id == "B1")
    b2 = next(state for state in states if state.scenario_id == "B2")
    assert abs(((b1.entry_zone_low + b1.entry_zone_high) / 2) - b1.stop) <= 60.0
    assert abs(b2.stop - ((b2.entry_zone_low + b2.entry_zone_high) / 2)) <= 60.0


def test_upper_band_trade_ideas_are_near_current_exhaustion_zone() -> None:
    envelope = sample_envelope()
    audit: list[AuditEntry] = []
    states = compute_scenario_states(envelope, 29470.0, 40.0, audit)
    pullback = next(state for state in states if state.scenario_id == "J")
    fade = next(state for state in states if state.scenario_id == "M")
    continuation = next(state for state in states if state.scenario_id == "L")
    assert pullback.direction == "long"
    assert fade.direction == "short"
    assert continuation.direction == "long"
    assert pullback.target_1 < continuation.target_1
    assert fade.entry_zone_low < fade.entry_zone_high
    assert fade.stop > fade.entry_zone_high
    assert fade.r_multiple_t1 > 0


def test_cycle_high_fade_and_breakout_are_mutually_exclusive_at_rejection_zone() -> None:
    envelope = sample_envelope()
    audit: list[AuditEntry] = []
    states = compute_scenario_states(envelope, 29555.0, 40.0, audit)
    fade = next(state for state in states if state.scenario_id == "C")
    breakout = next(state for state in states if state.scenario_id == "E")

    assert fade.state == "ACTIVE"
    assert breakout.state == "DORMANT"
    assert "below acceptance trigger" in breakout.reason


def test_breakout_continuation_only_activates_after_acceptance_above_fade_zone() -> None:
    envelope = sample_envelope()
    audit: list[AuditEntry] = []
    states = compute_scenario_states(envelope, 29572.0, 40.0, audit)
    fade = next(state for state in states if state.scenario_id == "C")
    breakout = next(state for state in states if state.scenario_id == "E")

    assert fade.state == "DORMANT"
    assert "fade invalidated" in fade.reason
    assert breakout.state == "ACTIVE"
    assert breakout.entry_zone_low > fade.entry_zone_high
    assert breakout.r_multiple_t1 > 0
    assert breakout.target_1 > (breakout.entry_zone_low + breakout.entry_zone_high) / 2


def test_breakdown_short_stop_is_tight() -> None:
    audit: list[AuditEntry] = []
    states = compute_scenario_states(sample_envelope(), 29237.5, 40.0, audit)
    scenario_d = next(state for state in states if state.scenario_id == "D")
    assert scenario_d.stop - scenario_d.entry_zone_high == pytest.approx(0.375)


def test_probability_tooltip_discloses_heuristic() -> None:
    audit: list[AuditEntry] = []
    states = compute_scenario_states(sample_envelope(), 29237.5, 40.0, audit)
    scenario_a = next(state for state in states if state.scenario_id == "A")
    assert "Heuristic only" in scenario_a.tooltip


def test_reset_store_keeps_only_current_session_keys() -> None:
    store = {
        "2026-05-21_rth_A": {"state": "ACTIVE"},
        "2026-05-21_globex_A": {"state": "WATCHING"},
    }
    reset = reset_store_for_session(store, "2026-05-21_rth")
    assert "2026-05-21_rth_A" in reset
    assert "2026-05-21_globex_A" not in reset
