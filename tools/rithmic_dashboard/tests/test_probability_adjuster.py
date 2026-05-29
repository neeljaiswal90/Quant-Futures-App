from __future__ import annotations

import pytest

from rithmic_dashboard.probability_adjuster import adjust, get_adjustment_factors


def test_dormant_keeps_prior_range() -> None:
    assert adjust(
        0.6,
        0.72,
        distance_atr=5.0,
        matches_session_drift=False,
        time_into_session_pct=0.9,
        state="DORMANT",
    ) == pytest.approx((0.6, 0.72))


def test_near_entry_with_matching_drift_boosts() -> None:
    low, high = adjust(
        0.5,
        0.6,
        distance_atr=0.1,
        matches_session_drift=True,
        time_into_session_pct=0.2,
        state="ACTIVE",
    )
    assert low == pytest.approx(0.575)
    assert high == pytest.approx(0.69)


def test_late_opposed_far_setup_discounts() -> None:
    low, high = adjust(
        0.6,
        0.7,
        distance_atr=3.0,
        matches_session_drift=False,
        time_into_session_pct=0.9,
        state="WATCHING",
    )
    assert low == pytest.approx(0.24)
    assert high == pytest.approx(0.28)


def test_adjustment_clamps_to_five_and_ninety_five_percent() -> None:
    low, high = adjust(
        0.99,
        1.5,
        distance_atr=0.0,
        matches_session_drift=True,
        time_into_session_pct=0.0,
        state="ACTIVE",
    )
    assert low <= 0.95
    assert high == 0.95


def test_factor_tooltip_breakdown_names_distance_session_and_time() -> None:
    factors = get_adjustment_factors(
        distance_atr=1.5,
        matches_session_drift=False,
        time_into_session_pct=0.5,
        state="WATCHING",
    )
    assert [factor.name for factor in factors] == ["distance", "session drift", "time"]
