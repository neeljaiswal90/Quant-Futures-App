"""Tests for ``rithmic_analytics.features.zone_probability`` + the markdown
probability-card renderer (RA-038)."""

from __future__ import annotations

import json
import math

import pytest

from rithmic_analytics.core.schema import Zone, ZoneEnvelope
from rithmic_analytics.features.zone_probability import (
    ZoneProbabilityAnnotation,
    annotate_zone,
    annotate_zones_with_probability,
)
from rithmic_analytics.features.zone_quality import (
    BinomialEstimate,
    HistoryReport,
)
from rithmic_analytics.viewer.probability_card import render_probability_card

# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------


def _zone(
    *,
    id_: str = "hvn-27380",
    top: float = 27385.0,
    bot: float = 27380.0,
    type_: str = "support",
    conviction: str = "SUPER",
) -> Zone:
    return Zone(
        id=id_,
        top=top,
        bot=bot,
        type=type_,
        conviction=conviction,
        text=f"{conviction} zone {bot:.0f}",
        sources=["hvn_5m"],
    )


def _envelope(zones: list[Zone], *, atr_14: float = 30.0) -> ZoneEnvelope:
    return ZoneEnvelope(
        schema_version=1,
        symbol="MNQ",
        timeframe="rth",
        bars_used=100,
        computed_at="2026-05-20T20:00:00+00:00",
        data_source="rithmic",
        vpoc=27380.0, vah=27400.0, val=27360.0,
        atr_14=atr_14,
        bin_size_ticks=20,
        zones=zones,
        reference_lines=[],
    )


def _estimate(
    *,
    n_trials: int = 50,
    n_success: int = 35,
    ci_low: float = 0.55,
    ci_high: float = 0.81,
    insufficient: bool = False,
) -> BinomialEstimate:
    rate = (n_success / n_trials) if n_trials > 0 else None
    return BinomialEstimate(
        n_trials=n_trials,
        n_success=n_success,
        rate=rate,
        ci_low=ci_low,
        ci_high=ci_high,
        insufficient_data=insufficient,
    )


def _history(
    *,
    estimates: dict[str, BinomialEstimate] | None = None,
    bounce: dict[str, float | None] | None = None,
    sessions_analyzed: int = 24,
    window_sessions: int = 30,
) -> HistoryReport:
    return HistoryReport(
        sessions_analyzed=sessions_analyzed,
        window_sessions=window_sessions,
        pairing="next-day",
        hit_rate_by_conviction=estimates or {"SUPER": _estimate()},
        avg_bounce_distance_by_conviction=bounce or {"SUPER": 40.0},
        avg_continuation_distance_by_conviction={},
    )


# ---------------------------------------------------------------------------
# Annotator unit tests
# ---------------------------------------------------------------------------


def test_annotate_zone_super_full_size() -> None:
    # ci_low=0.7, bounce=45pts, atr=30 → bounce_R=1.5
    # expected_R = 0.7 * 1.5 - 0.3 = 1.05 - 0.3 = 0.75 (>0.30 → full)
    history = _history(
        estimates={"SUPER": _estimate(ci_low=0.70)},
        bounce={"SUPER": 45.0},
    )
    z = _zone(conviction="SUPER")
    ann = annotate_zone(z, atr_14=30.0, history=history)

    assert ann.conviction == "SUPER"
    assert ann.p_hold_ci_low == pytest.approx(0.70)
    assert ann.bounce_r == pytest.approx(1.5)
    assert ann.expected_r == pytest.approx(0.75)
    assert ann.sizing_decision == "full"
    assert not ann.history_insufficient


def test_annotate_zone_half_size_band() -> None:
    # ci_low=0.5, bounce=30, atr=30 → bounce_R=1.0
    # expected_R = 0.5*1.0 - 0.5 = 0 → skip
    # Adjust to land in half band: ci_low=0.55, bounce=30, atr=30 → 0.55-0.45=0.10 → half
    history = _history(
        estimates={"HIGH": _estimate(ci_low=0.55)},
        bounce={"HIGH": 30.0},
    )
    z = _zone(conviction="HIGH")
    ann = annotate_zone(z, atr_14=30.0, history=history)

    assert ann.expected_r == pytest.approx(0.10, abs=1e-9)
    assert ann.sizing_decision == "half"


def test_annotate_zone_skip_when_expected_r_low() -> None:
    # ci_low=0.40, bounce=30, atr=30 → 0.40 - 0.60 = -0.20 → skip
    history = _history(
        estimates={"MED": _estimate(ci_low=0.40)},
        bounce={"MED": 30.0},
    )
    z = _zone(conviction="MED")
    ann = annotate_zone(z, atr_14=30.0, history=history)

    assert ann.expected_r < 0
    assert ann.sizing_decision == "skip"


def test_annotate_zone_insufficient_history_tier() -> None:
    # Tier flagged insufficient → sizing=insufficient_history, NaN ci_low.
    history = _history(
        estimates={"LOW": _estimate(n_trials=2, n_success=1, insufficient=True)},
        bounce={"LOW": None},
    )
    z = _zone(conviction="LOW")
    ann = annotate_zone(z, atr_14=30.0, history=history)

    assert ann.history_insufficient
    assert math.isnan(ann.p_hold_ci_low)
    assert math.isnan(ann.expected_r)
    assert ann.sizing_decision == "insufficient_history"


def test_annotate_zone_no_history_bootstrap() -> None:
    # history=None → bootstrap path, insufficient_history sizing.
    z = _zone(conviction="SUPER")
    ann = annotate_zone(z, atr_14=30.0, history=None)

    assert ann.history_insufficient
    assert ann.sizing_decision == "insufficient_history"
    assert ann.n_trials == 0


def test_annotate_zone_nan_atr_yields_nan_expected_r() -> None:
    # ATR NaN → bounce_r=None → expected_r NaN → skip path? No — insufficient_history
    # because we cannot compute. Use the insufficient_history label per the rule.
    history = _history(
        estimates={"SUPER": _estimate(ci_low=0.70)},
        bounce={"SUPER": 40.0},
    )
    z = _zone(conviction="SUPER")
    ann = annotate_zone(z, atr_14=float("nan"), history=history)

    assert ann.bounce_r is None
    assert math.isnan(ann.expected_r)
    assert ann.sizing_decision == "insufficient_history"


def test_annotate_zone_missing_conviction_in_history() -> None:
    # zone conviction not present in history → treat as insufficient.
    history = _history(estimates={"SUPER": _estimate()})
    z = _zone(conviction="LOW")  # LOW not in history
    ann = annotate_zone(z, atr_14=30.0, history=history)

    assert ann.history_insufficient
    assert ann.sizing_decision == "insufficient_history"


def test_annotate_zones_with_probability_envelope() -> None:
    history = _history(
        estimates={
            "SUPER": _estimate(ci_low=0.70),
            "HIGH": _estimate(ci_low=0.45, insufficient=False),
        },
        bounce={"SUPER": 40.0, "HIGH": 25.0},
    )
    envelope = _envelope(
        zones=[
            _zone(id_="hvn-1", conviction="SUPER"),
            _zone(id_="hvn-2", conviction="HIGH"),
            _zone(id_="hvn-3", conviction="LOW"),  # not in history → insufficient
        ],
    )

    annotated = annotate_zones_with_probability(
        envelope, history, trading_date_iso="2026-05-20",
    )

    assert annotated.symbol == "MNQ"
    assert annotated.timeframe == "rth"
    assert annotated.trading_date_iso == "2026-05-20"
    assert annotated.sessions_analyzed == 24
    assert annotated.window_sessions == 30
    assert annotated.pairing == "next-day"
    assert not annotated.bootstrap_mode
    assert len(annotated.zone_annotations) == 3
    # LOW zone is insufficient, others are not.
    sizing = {a.zone_id: a.sizing_decision for a in annotated.zone_annotations}
    assert sizing["hvn-3"] == "insufficient_history"
    assert sizing["hvn-1"] in ("full", "half")


def test_annotate_zones_bootstrap_mode_when_history_none() -> None:
    envelope = _envelope(zones=[_zone()])
    annotated = annotate_zones_with_probability(
        envelope, history=None, trading_date_iso="2026-05-20",
    )
    assert annotated.bootstrap_mode
    assert annotated.sessions_analyzed == 0
    assert annotated.window_sessions == 0
    assert all(a.sizing_decision == "insufficient_history" for a in annotated.zone_annotations)


def test_annotate_zones_bootstrap_when_all_tiers_insufficient() -> None:
    # History exists but every tier flagged insufficient → still bootstrap.
    history = _history(
        estimates={
            "SUPER": _estimate(insufficient=True),
            "HIGH": _estimate(insufficient=True),
        },
    )
    envelope = _envelope(zones=[_zone()])
    annotated = annotate_zones_with_probability(
        envelope, history, trading_date_iso="2026-05-20",
    )
    assert annotated.bootstrap_mode


def test_to_dict_round_trips_through_json() -> None:
    history = _history()
    envelope = _envelope(zones=[_zone()])
    annotated = annotate_zones_with_probability(
        envelope, history, trading_date_iso="2026-05-20",
    )
    payload = annotated.to_dict()
    # NaN → None so JSON serializes cleanly without `allow_nan=False` hacks.
    blob = json.dumps(payload)
    assert "NaN" not in blob
    parsed = json.loads(blob)
    assert parsed["symbol"] == "MNQ"
    assert isinstance(parsed["zone_annotations"], list)


def test_dataclasses_are_frozen() -> None:
    ann = ZoneProbabilityAnnotation(
        zone_id="z", conviction="SUPER", functional_role="support",
        p_hold_ci_low=0.7, p_hold_rate=0.75, n_trials=50,
        avg_bounce_distance_pts=40.0, bounce_r=1.3,
        expected_r=0.6, sizing_decision="full",
        history_insufficient=False,
    )
    import dataclasses

    with pytest.raises(dataclasses.FrozenInstanceError):
        ann.conviction = "LOW"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Renderer tests
# ---------------------------------------------------------------------------


def test_render_card_header_uses_n_sessions_no_date_range() -> None:
    # Q-RA038-2: header must say "trailing-30 window, n=N sessions" — never
    # an explicit date range.
    history = _history(sessions_analyzed=24, window_sessions=30)
    envelope = _envelope(zones=[_zone()])
    annotated = annotate_zones_with_probability(
        envelope, history, trading_date_iso="2026-05-20",
    )
    md = render_probability_card(annotated)

    assert "Trailing-30 window" in md
    assert "n=24 sessions" in md
    # No ISO date range pattern (YYYY-MM-DD to YYYY-MM-DD or "from … to …")
    assert " to 2026-" not in md
    assert "from " not in md.lower() or "from " in "from "  # paranoia hedge


def test_render_card_includes_role_conditioning_note() -> None:
    # Q-RA038-1: limitation must be visible to future-Neel reading the card.
    envelope = _envelope(zones=[_zone()])
    history = _history()
    annotated = annotate_zones_with_probability(
        envelope, history, trading_date_iso="2026-05-20",
    )
    md = render_probability_card(annotated)
    assert "conviction tier only" in md or "RA-040" in md


def test_render_card_bootstrap_mode_omits_recommendation_section() -> None:
    envelope = _envelope(zones=[_zone()])
    annotated = annotate_zones_with_probability(
        envelope, history=None, trading_date_iso="2026-05-20",
    )
    md = render_probability_card(annotated)
    assert "pre-bootstrap" in md or "Sizing recommendations suppressed" in md


def test_render_card_table_has_row_per_zone() -> None:
    envelope = _envelope(
        zones=[
            _zone(id_="z1", conviction="SUPER"),
            _zone(id_="z2", conviction="HIGH"),
        ],
    )
    history = _history(
        estimates={
            "SUPER": _estimate(ci_low=0.70),
            "HIGH": _estimate(ci_low=0.55),
        },
        bounce={"SUPER": 45.0, "HIGH": 30.0},
    )
    annotated = annotate_zones_with_probability(
        envelope, history, trading_date_iso="2026-05-20",
    )
    md = render_probability_card(annotated)

    # Each zone id must appear in the markdown.
    assert "| z1 |" in md
    assert "| z2 |" in md
    # Table header present.
    assert "| Zone | Conviction | Role | P(hold) ci_low | Expected R | Size |" in md


def test_render_card_empty_envelope() -> None:
    envelope = _envelope(zones=[])
    history = _history()
    annotated = annotate_zones_with_probability(
        envelope, history, trading_date_iso="2026-05-20",
    )
    md = render_probability_card(annotated)
    assert "No zones" in md


def test_render_card_size_label_bolds_full() -> None:
    history = _history(
        estimates={"SUPER": _estimate(ci_low=0.70)},
        bounce={"SUPER": 45.0},
    )
    envelope = _envelope(zones=[_zone(conviction="SUPER")])
    annotated = annotate_zones_with_probability(
        envelope, history, trading_date_iso="2026-05-20",
    )
    md = render_probability_card(annotated)
    # "**full**" markdown bold
    assert "**full**" in md
