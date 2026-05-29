from __future__ import annotations

import pytest

from rithmic_dashboard.level_distances import compute_level_distances

from .conftest import sample_envelope


def test_distances_include_reference_lines_and_zones() -> None:
    distances = compute_level_distances(sample_envelope(), 29240.0, 40.0)
    ids = {distance.level_id for distance in distances}
    assert "ref-vpoc-29237.50" in ids
    assert "hvn-29237.5" in ids


def test_distance_sign_positive_when_level_above_price() -> None:
    distances = compute_level_distances(sample_envelope(), 29200.0, 40.0)
    vpoc = next(d for d in distances if d.level_id == "ref-vpoc-29237.50")
    assert vpoc.distance_pts == pytest.approx(37.5)
    assert vpoc.direction == "above"


def test_distance_sign_negative_when_level_below_price() -> None:
    distances = compute_level_distances(sample_envelope(), 29300.0, 40.0)
    vpoc = next(d for d in distances if d.level_id == "ref-vpoc-29237.50")
    assert vpoc.distance_pts == pytest.approx(-62.5)
    assert vpoc.direction == "below"


def test_crossing_detected_from_prior_state_sign_change() -> None:
    prior = {"ref-vpoc-29237.50": {"last_distance_pts": 5.0}}
    distances = compute_level_distances(sample_envelope(), 29240.0, 40.0, prior)
    vpoc = next(d for d in distances if d.level_id == "ref-vpoc-29237.50")
    assert vpoc.state == "crossing"


def test_distances_are_sorted_by_absolute_distance() -> None:
    distances = compute_level_distances(sample_envelope(), 29236.0, 40.0)
    absolute = [abs(distance.distance_pts) for distance in distances]
    assert absolute == sorted(absolute)
