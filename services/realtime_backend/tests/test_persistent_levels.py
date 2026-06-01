"""RA-108: tests for the persistent-levels detector.

Covers promotion via different evidence types + counts + spans, status
transition (active → deteriorating), and session reset semantics. Out of
scope per the v1 dispatch: resting-size source, broken-detection.
"""

from __future__ import annotations

import pytest
from contracts.realtime.events import (
    AbsorptionPayload,
    IcebergPayload,
    PersistentLevelPayload,
    SweepPayload,
)

from realtime_backend.persistent_levels import (
    PersistentLevelConfig,
    PersistentLevelDetector,
)

NS = 1_000_000_000


def _config() -> PersistentLevelConfig:
    """A test-friendly config with short windows so fixtures stay readable."""
    return PersistentLevelConfig(
        min_persistence_seconds=10.0,
        deteriorate_after_seconds=30.0,
        high_min_distinct_sources=3,
        high_min_same_source_count=5,
        high_min_same_source_span_seconds=20.0,
        high_min_iceberg_refills=4,
        medium_min_distinct_sources=2,
        medium_min_observations=3,
        medium_min_span_seconds=10.0,
        low_min_observations=2,
        low_min_span_seconds=2.0,
    )


def _iceberg(price: float, side: str = "ask", refills: int = 1, total: int = 50) -> IcebergPayload:
    return IcebergPayload(
        price=price,
        side=side,  # type: ignore[arg-type]
        refills=refills,
        total_consumed=total,
        level_id=f"iceberg-{price}-{side}",
    )


def _absorption(price: float, side: str = "ask", score: float = 0.6) -> AbsorptionPayload:
    return AbsorptionPayload(
        price=price,
        side=side,  # type: ignore[arg-type]
        score=score,
        level_id=f"abs-{price}-{side}",
    )


def _sweep(price: float, direction: str = "down", ticks: int = 4) -> SweepPayload:
    return SweepPayload(
        price=price,
        direction=direction,  # type: ignore[arg-type]
        ticks_cleared=ticks,
        level_id=f"sweep-{price}-{direction}",
    )


# ----------------------------------------------------------------------------
# Basic observation / no-emit-before-threshold
# ----------------------------------------------------------------------------


def test_single_observation_below_threshold_does_not_emit() -> None:
    """A single iceberg observation isn't enough to promote a level."""
    det = PersistentLevelDetector(_config())
    out = det.observe_iceberg(_iceberg(30000.0), ts_ns=10 * NS)
    assert out is None
    # State exists but unemitted.
    levels = det.levels_for_test()
    assert len(levels) == 1


def test_low_confidence_promotion_via_two_observations_spanning_min_window() -> None:
    """Two observations of the same source spanning >= low_min_span_seconds promotes to LOW."""
    det = PersistentLevelDetector(_config())
    det.observe_iceberg(_iceberg(30000.0), ts_ns=10 * NS)
    out = det.observe_iceberg(_iceberg(30000.0), ts_ns=15 * NS)  # +5s
    assert isinstance(out, PersistentLevelPayload)
    assert out.confidence == "low"
    assert out.status == "active"
    assert out.side == "ask"
    assert len(out.evidence) == 1
    assert out.evidence[0].source == "iceberg_refill"


# ----------------------------------------------------------------------------
# Medium / High tier promotion
# ----------------------------------------------------------------------------


def test_medium_confidence_via_two_distinct_evidence_sources() -> None:
    """Two distinct evidence sources promote directly to MEDIUM."""
    det = PersistentLevelDetector(_config())
    det.observe_iceberg(_iceberg(30050.0), ts_ns=10 * NS)
    out = det.observe_absorption(_absorption(30050.0), ts_ns=15 * NS)
    assert isinstance(out, PersistentLevelPayload)
    assert out.confidence == "medium"


def test_high_confidence_via_three_distinct_sources() -> None:
    """Three distinct sources at the same level → HIGH."""
    det = PersistentLevelDetector(_config())
    det.observe_iceberg(_iceberg(30100.0), ts_ns=10 * NS)
    det.observe_absorption(_absorption(30100.0), ts_ns=15 * NS)
    out = det.observe_sweep(_sweep(30100.0, "up"), ts_ns=20 * NS)
    assert isinstance(out, PersistentLevelPayload)
    assert out.confidence == "high"
    assert out.side == "ask"  # sweep "up" → ask side defended (broken at 30100)
    sources = {e.source for e in out.evidence}
    assert sources == {"iceberg_refill", "absorption", "sweep_anchor"}


def test_high_confidence_via_iceberg_refill_chain() -> None:
    """An iceberg chain of >= 4 refills alone promotes to HIGH."""
    det = PersistentLevelDetector(_config())
    out = det.observe_iceberg(
        _iceberg(30200.0, refills=4, total=200), ts_ns=10 * NS
    )
    assert isinstance(out, PersistentLevelPayload)
    assert out.confidence == "high"
    iceberg = next(e for e in out.evidence if e.source == "iceberg_refill")
    # Refills are exploded so each individual refill is one count.
    assert iceberg.count == 4


# ----------------------------------------------------------------------------
# Confidence tier re-emission
# ----------------------------------------------------------------------------


def test_repeat_observations_at_same_tier_do_not_re_emit() -> None:
    """Once a level is at LOW, more same-source observations stay at LOW silently
    AS LONG AS they don't push the level across the MEDIUM gate (3 obs + 10s span)."""
    det = PersistentLevelDetector(_config())
    det.observe_iceberg(_iceberg(30300.0), ts_ns=10 * NS)
    first = det.observe_iceberg(_iceberg(30300.0), ts_ns=15 * NS)
    assert first is not None and first.confidence == "low"
    # Third observation at 17s: span is 7s (< medium_min_span_seconds=10), so the
    # level stays at LOW and emission is silent (same tier, same status).
    second = det.observe_iceberg(_iceberg(30300.0), ts_ns=17 * NS)
    assert second is None


def test_promotion_low_to_medium_re_emits() -> None:
    """Tier promotion from LOW to MEDIUM triggers a fresh emission."""
    det = PersistentLevelDetector(_config())
    det.observe_iceberg(_iceberg(30400.0), ts_ns=10 * NS)
    low_out = det.observe_iceberg(_iceberg(30400.0), ts_ns=15 * NS)
    assert low_out is not None and low_out.confidence == "low"
    # Add an absorption — now two distinct sources → MEDIUM.
    medium_out = det.observe_absorption(_absorption(30400.0), ts_ns=20 * NS)
    assert medium_out is not None and medium_out.confidence == "medium"


# ----------------------------------------------------------------------------
# Side classification
# ----------------------------------------------------------------------------


def test_bid_side_propagates_through_iceberg() -> None:
    det = PersistentLevelDetector(_config())
    det.observe_iceberg(_iceberg(30500.0, side="bid"), ts_ns=10 * NS)
    out = det.observe_iceberg(_iceberg(30500.0, side="bid"), ts_ns=15 * NS)
    assert out is not None
    assert out.side == "bid"


def test_sweep_down_anchors_bid_side() -> None:
    """A sweep DOWN broke a bid-side floor — that floor defended weakly."""
    det = PersistentLevelDetector(_config())
    det.observe_sweep(_sweep(30600.0, direction="down"), ts_ns=10 * NS)
    det.observe_sweep(_sweep(30600.0, direction="down"), ts_ns=15 * NS)
    levels = det.levels_for_test()
    assert any(level.side == "bid" for level in levels.values())


# ----------------------------------------------------------------------------
# Lifecycle: deterioration
# ----------------------------------------------------------------------------


def test_tick_transitions_active_to_deteriorating_after_window() -> None:
    """No new evidence for deteriorate_after_seconds → status flips."""
    config = _config()
    det = PersistentLevelDetector(config)
    det.observe_iceberg(_iceberg(30700.0), ts_ns=10 * NS)
    det.observe_iceberg(_iceberg(30700.0), ts_ns=15 * NS)  # promotes to LOW

    # No transition yet — within the window.
    no_op = det.tick(now_ts_ns=20 * NS)
    assert no_op == []

    # Past deterioration window (last_active at 15s + 30s = 45s; we tick at 50s).
    emitted = det.tick(now_ts_ns=50 * NS)
    assert len(emitted) == 1
    assert emitted[0].status == "deteriorating"
    assert emitted[0].side == "ask"


def test_tick_only_emits_for_previously_emitted_levels() -> None:
    """tick() should not emit deterioration for levels that never reached a tier."""
    det = PersistentLevelDetector(_config())
    det.observe_iceberg(_iceberg(30800.0), ts_ns=10 * NS)  # single — no emit
    emitted = det.tick(now_ts_ns=100 * NS)
    assert emitted == []


# ----------------------------------------------------------------------------
# Session reset
# ----------------------------------------------------------------------------


def test_clear_drops_all_state() -> None:
    det = PersistentLevelDetector(_config())
    det.observe_iceberg(_iceberg(30900.0), ts_ns=10 * NS)
    assert len(det.levels_for_test()) == 1
    det.clear()
    assert det.levels_for_test() == {}


# ----------------------------------------------------------------------------
# Price snapping
# ----------------------------------------------------------------------------


def test_levels_within_one_tick_collapse_to_same_level_id() -> None:
    """Prices snap to the configured tick grid; nearby prices share a level."""
    det = PersistentLevelDetector(_config())
    det.observe_iceberg(_iceberg(31000.01), ts_ns=10 * NS)
    det.observe_iceberg(_iceberg(31000.06), ts_ns=15 * NS)  # both snap to 31000.0
    levels = det.levels_for_test()
    assert len(levels) == 1


# ----------------------------------------------------------------------------
# Payload shape sanity
# ----------------------------------------------------------------------------


def test_emitted_payload_has_required_fields() -> None:
    det = PersistentLevelDetector(_config())
    det.observe_iceberg(_iceberg(31100.0), ts_ns=10 * NS)
    out = det.observe_iceberg(_iceberg(31100.0), ts_ns=20 * NS)
    assert out is not None
    assert out.family == "persistent_level"
    assert out.level_id == "31100.0000_ask"
    assert out.price == 31100.0
    assert out.persistence_seconds == pytest.approx(10.0, rel=0.01)
    assert out.status == "active"
    assert out.confidence in {"low", "medium", "high"}
    assert out.last_active_ts_ns >= 10 * NS
