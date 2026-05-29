from __future__ import annotations

from rithmic_dashboard.models import DayTypeClassification
from rithmic_dashboard.scenario_state import compute_scenario_states

from .conftest import sample_envelope


def test_ib_scenarios_render_extension_targets_and_activate_on_break() -> None:
    states = compute_scenario_states(
        sample_envelope(),
        115.5,
        40.0,
        [],
        day_type=_day_type(),
    )
    ib_long = next(state for state in states if state.scenario_id == "IB-Long")
    ib_short = next(state for state in states if state.scenario_id == "IB-Short")

    assert ib_long.state == "ACTIVE"
    assert ib_long.entry_zone_low == 115.0
    assert ib_long.entry_zone_high == 120.0
    assert ib_long.target_1 == 115.0
    assert ib_long.target_2 == 120.0
    assert ib_long.target_3 == 125.0
    assert ib_long.stop == 105.0
    assert ib_short.target_1 == 95.0
    assert ib_short.target_2 == 90.0
    assert ib_short.target_3 == 85.0


def test_ib_scenarios_absent_until_classified() -> None:
    pending = _day_type(status="pending", day_type="pending")
    states = compute_scenario_states(
        sample_envelope(),
        115.5,
        40.0,
        [],
        day_type=pending,
    )

    assert all(not state.scenario_id.startswith("IB-") for state in states)


def _day_type(
    *,
    status: str = "classified",
    day_type: str = "normal_variation_up",
) -> DayTypeClassification:
    return DayTypeClassification(
        trading_date="2026-05-26",
        session="rth",
        computed_at_pt="2026-05-26 08:00:00 PT",
        status=status,  # type: ignore[arg-type]
        day_type=day_type,  # type: ignore[arg-type]
        confidence="high",
        reason="fixture",
        ib_high=110.0,
        ib_low=100.0,
        ib_range=10.0,
        ib_midpoint=105.0,
    )
