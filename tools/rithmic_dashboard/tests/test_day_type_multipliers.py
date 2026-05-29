from __future__ import annotations

from pathlib import Path

from rithmic_dashboard.models import (
    AbsorptionProxyEvent,
    DayTypeClassification,
    DeltaDislocationEvent,
    InstitutionalFlowEvent,
    LiveCvd,
    LiveSignals,
    LiveVwap,
    SweepEvent,
    VolumeVelocity,
)
from rithmic_dashboard.probability_adjuster import ProbabilitySignalContext, get_adjustment_factors
from rithmic_dashboard.scenario_state import compute_scenario_states

from .conftest import sample_envelope


def test_day_type_multiplier_applies_after_live_event_factors() -> None:
    factors = get_adjustment_factors(
        distance_atr=0.1,
        matches_session_drift=True,
        time_into_session_pct=0.4,
        state="ACTIVE",
        signal_context=ProbabilitySignalContext(
            direction="long",
            entry_zone_low=100.0,
            entry_zone_high=110.0,
            day_type=_day_type("trend_day_up"),
            scenario_id="E",
            scenario_name="Breakout continuation",
        ),
    )

    assert factors[-1].name == "day_type_trend_day_up_long"
    assert factors[-1].multiplier == 1.25


def test_day_type_mean_reversion_penalty_on_trend_day() -> None:
    factors = get_adjustment_factors(
        distance_atr=0.1,
        matches_session_drift=True,
        time_into_session_pct=0.4,
        state="ACTIVE",
        signal_context=ProbabilitySignalContext(
            direction="short",
            entry_zone_low=100.0,
            entry_zone_high=110.0,
            day_type=_day_type("trend_day_up"),
            scenario_id="C",
            scenario_name="Cycle-high rejection fade",
        ),
    )

    factor = factors[-1]
    assert factor.name == "day_type_trend_day_up_mean_reversion"
    assert factor.multiplier == 0.60


def test_worst_case_stack_clips_but_keeps_all_tooltip_multipliers() -> None:
    audit = []
    states = compute_scenario_states(
        sample_envelope(),
        29237.5,
        40.0,
        audit,
        now_pt=None,
        time_into_session_pct=0.4,
        live_signals=_signals(),
        day_type=_day_type("neutral_day_center"),
    )
    scenario = next(state for state in states if state.scenario_id == "A")
    names = {factor.name for factor in scenario.adjustment_factors}

    assert {
        "cvd_direction_match",
        "recent_sweep_at_entry",
        "absorption_proxy_at_entry",
        "delta_dislocation_at_entry_strong",
        "institutional_flow_match",
        "day_type_neutral_day_center_mean_reversion",
    } <= names
    assert "Unclipped factor" in scenario.tooltip
    for name in names:
        if name in {
            "cvd_direction_match",
            "recent_sweep_at_entry",
            "absorption_proxy_at_entry",
            "delta_dislocation_at_entry_strong",
            "institutional_flow_match",
            "day_type_neutral_day_center_mean_reversion",
        }:
            assert name in scenario.tooltip
    assert scenario.adjusted_prob_high == 0.95


def _day_type(day_type: str) -> DayTypeClassification:
    return DayTypeClassification(
        trading_date="2026-05-26",
        session="rth",
        computed_at_pt="2026-05-26 08:00:00 PT",
        status="classified",
        day_type=day_type,  # type: ignore[arg-type]
        confidence="high",
        reason=f"{day_type} synthetic fixture",
        classification_timestamp_pt="2026-05-26 08:00:00 PT",
        ib_high=110.0,
        ib_low=100.0,
        ib_range=10.0,
        ib_midpoint=105.0,
        current_extension_pts=5.0,
        current_extension_x_ib=0.5,
    )


def _signals() -> LiveSignals:
    return LiveSignals(
        trading_date="2026-05-26",
        session="rth",
        computed_at_pt="2026-05-26 08:00:00 PT",
        source_path=Path("capture.jsonl"),
        tail_bytes=20_000_000,
        trade_count=100,
        live_vwap=LiveVwap(60, 29237.5, 4.0, 29241.5, 29233.5),
        cvd=LiveCvd(2_000, 2_000, 1_000, "bullish", "bullish", False),
        velocity=VolumeVelocity(30, 2.0, 1.0, 2.0, "active"),
        sweeps=(SweepEvent("x", 1, "vpoc", "VPOC", 29237.5, "up", 5.0, False),),
        absorption_proxies=(
            AbsorptionProxyEvent("x", 1, 29237.5, 500, 0, "balanced", "high"),
            AbsorptionProxyEvent("x", 2, 29237.5, 510, 0, "balanced", "high"),
        ),
        delta_dislocations=(
            DeltaDislocationEvent(
                "x",
                3,
                "long",
                "vpoc",
                "VPOC",
                29237.5,
                "down",
                2_000,
                500.0,
                0.0,
                "high",
                0,
                60.0,
                True,
            ),
        ),
        institutional_flow_events=(
            InstitutionalFlowEvent(
                "x",
                4,
                "institutional_concentration_detected",
                "vpoc",
                "VPOC",
                29237.5,
                "buy",
                3,
                240,
                240,
                0,
                90,
                15,
                "high",
                60.0,
                3.0,
                "Institutional buy concentration at VPOC",
            ),
        ),
    )
