"""Initial Balance scenario templates."""

from __future__ import annotations

from rithmic_dashboard.models import DayTypeClassification
from rithmic_dashboard.scenario_state import ScenarioTemplate


def build_ib_templates(day_type: DayTypeClassification | None) -> list[ScenarioTemplate]:
    """Return IB breakout scenarios once RTH day type is classified."""

    if (
        day_type is None
        or day_type.status != "classified"
        or day_type.ib_high is None
        or day_type.ib_low is None
        or day_type.ib_range is None
        or day_type.ib_midpoint is None
        or day_type.ib_range <= 0
    ):
        return []
    ib_high = day_type.ib_high
    ib_low = day_type.ib_low
    ib_range = day_type.ib_range
    midpoint = day_type.ib_midpoint
    return [
        ScenarioTemplate(
            "IB-Long",
            "Initial Balance upside break",
            "long",
            ib_high + 5.0,
            ib_high + 10.0,
            midpoint,
            ib_high + 0.5 * ib_range,
            ib_high + 1.0 * ib_range,
            ib_high + 1.5 * ib_range,
            0.55,
            0.55,
        ),
        ScenarioTemplate(
            "IB-Short",
            "Initial Balance downside break",
            "short",
            ib_low - 10.0,
            ib_low - 5.0,
            midpoint,
            ib_low - 0.5 * ib_range,
            ib_low - 1.0 * ib_range,
            ib_low - 1.5 * ib_range,
            0.55,
            0.55,
        ),
    ]
