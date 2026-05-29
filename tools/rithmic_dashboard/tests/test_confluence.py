from __future__ import annotations

from rithmic_dashboard.confluence import compute_confluence_groups

from .conftest import sample_envelope


def test_vpoc_minus_one_sd_group_is_detected() -> None:
    groups = compute_confluence_groups(sample_envelope())
    assert any(abs(group.center_price - 29235.105) < 0.1 for group in groups)


def test_upper_multi_method_group_scores_super() -> None:
    groups = compute_confluence_groups(sample_envelope())
    upper = max(groups, key=lambda group: group.center_price)
    assert upper.conviction_score == "SUPER"


def test_group_tightness_uses_five_point_span() -> None:
    groups = compute_confluence_groups(sample_envelope())
    lower = min(groups, key=lambda group: abs(group.center_price - 29235.105))
    assert lower.tightness == "TIGHT"


def test_groups_are_sorted_by_center_price() -> None:
    groups = compute_confluence_groups(sample_envelope())
    centers = [group.center_price for group in groups]
    assert centers == sorted(centers)
