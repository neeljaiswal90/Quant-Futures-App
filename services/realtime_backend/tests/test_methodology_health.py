"""Tests for the RA-112e step 8 methodology health accumulator."""

from __future__ import annotations

import pytest

from realtime_backend.methodology_health import (
    DEFAULT_WINDOW_SECONDS,
    MethodologyHealthAccumulator,
)


SECOND_NS = 1_000_000_000


def _v3_shelves(*, anchor: float, sup1_width: float = 5.0, dem1_width: float = 5.0,
                quantile_sup1_width: float | None = None,
                quantile_dem1_width: float | None = None) -> list[dict]:
    """Build a minimal v3 shelf set anchored at `anchor`. SUP_1.low == anchor,
    DEM_1.high == anchor — the v3 invariant."""
    shelves: list[dict] = [
        {"family": "sigma_v3_vwap_anchor", "name": "SUP_1",
         "low": anchor, "high": anchor + sup1_width},
        {"family": "sigma_v3_vwap_anchor", "name": "DEM_1",
         "low": anchor - dem1_width, "high": anchor},
    ]
    if quantile_sup1_width is not None and quantile_dem1_width is not None:
        shelves.extend([
            {"family": "sigma_v3_vwap_anchor_quantile", "name": "SUP_1",
             "low": anchor, "high": anchor + quantile_sup1_width},
            {"family": "sigma_v3_vwap_anchor_quantile", "name": "DEM_1",
             "low": anchor - quantile_dem1_width, "high": anchor},
        ])
    return shelves


def _v2_shelves(*, anchor: float, vah: float, val: float) -> list[dict]:
    """v2 legacy: anchored at full-session VAH/VAL — these are commonly OFF
    from the rolling anchor (the bug the audit reviewer flagged)."""
    return [
        {"family": "sigma_v2_session_value_anchor", "name": "SUP_1",
         "low": vah, "high": vah + 5.0},
        {"family": "sigma_v2_session_value_anchor", "name": "DEM_1",
         "low": val - 5.0, "high": val},
    ]


def test_empty_metrics_are_well_formed():
    acc = MethodologyHealthAccumulator()
    m = acc.metrics(now_ts_ns=0)
    assert m["observation_count"] == 0
    assert m["v3_cap_bind_rate"] is None
    assert m["v3_quantile_cap_bind_rate"] is None
    assert m["v3_shelf_cross_anchor_failure_rate"] == 0.0
    assert m["v2_shelf_cross_anchor_failure_rate"] == 0.0
    assert m["warmup_share"] == 0.0
    assert m["estimator_width_divergence_sup_1_ticks"] is None
    assert m["anchor_vs_value_distribution"]["above_value"] == 0.0


def test_v3_cap_bind_rate_computed_per_family():
    acc = MethodologyHealthAccumulator()
    anchor = 30500.0
    # 4 observations: 2 with SUP_1 bound by cap, 2 free.
    for i in range(4):
        acc.observe(
            ts_ns=i * SECOND_NS,
            emitted=True,
            auction_state="inside_value",
            tactical_status="live",
            shelves=_v3_shelves(anchor=anchor),
            cap_bind_flags={
                "sigma_v3_vwap_anchor:SUP_1": i < 2,  # first two bound
                "sigma_v3_vwap_anchor:DEM_1": False,
            },
            anchor=anchor,
        )
    m = acc.metrics(now_ts_ns=4 * SECOND_NS)
    # 2 bound out of 8 total flags (4 obs × 2 shelves each) = 0.25
    assert m["v3_cap_bind_rate"] == pytest.approx(0.25)


def test_v3_quantile_cap_bind_reported_separately_from_rms():
    acc = MethodologyHealthAccumulator()
    anchor = 30500.0
    acc.observe(
        ts_ns=SECOND_NS, emitted=True,
        auction_state="inside_value", tactical_status="live",
        shelves=_v3_shelves(anchor=anchor, quantile_sup1_width=8.0,
                            quantile_dem1_width=8.0),
        cap_bind_flags={
            "sigma_v3_vwap_anchor:SUP_1": True,
            "sigma_v3_vwap_anchor:DEM_1": True,
            "sigma_v3_vwap_anchor_quantile:SUP_1": False,
            "sigma_v3_vwap_anchor_quantile:DEM_1": False,
        },
        anchor=anchor,
    )
    m = acc.metrics(now_ts_ns=SECOND_NS)
    assert m["v3_cap_bind_rate"] == 1.0
    assert m["v3_quantile_cap_bind_rate"] == 0.0


def test_v3_shelf_cross_anchor_failure_rate_is_zero_for_well_formed():
    acc = MethodologyHealthAccumulator()
    anchor = 30500.0
    for i in range(3):
        acc.observe(
            ts_ns=i * SECOND_NS,
            emitted=True, auction_state="inside_value", tactical_status="live",
            shelves=_v3_shelves(anchor=anchor),
            cap_bind_flags={},
            anchor=anchor,
        )
    m = acc.metrics(now_ts_ns=3 * SECOND_NS)
    assert m["v3_shelf_cross_anchor_failure_rate"] == 0.0


def test_v3_shelf_cross_anchor_failure_rate_flags_regressions():
    """If a v3 shelf ever floats OFF the anchor (the invariant), the rate
    surfaces it — this is the canary for a methodology bug."""
    acc = MethodologyHealthAccumulator()
    anchor = 30500.0
    # 1 healthy
    acc.observe(
        ts_ns=SECOND_NS, emitted=True, auction_state="inside_value",
        tactical_status="live",
        shelves=_v3_shelves(anchor=anchor),
        cap_bind_flags={}, anchor=anchor,
    )
    # 1 broken — SUP_1.low is offset by 2pt
    acc.observe(
        ts_ns=2 * SECOND_NS, emitted=True, auction_state="inside_value",
        tactical_status="live",
        shelves=[
            {"family": "sigma_v3_vwap_anchor", "name": "SUP_1",
             "low": anchor + 2.0, "high": anchor + 7.0},
            {"family": "sigma_v3_vwap_anchor", "name": "DEM_1",
             "low": anchor - 5.0, "high": anchor},
        ],
        cap_bind_flags={}, anchor=anchor,
    )
    m = acc.metrics(now_ts_ns=2 * SECOND_NS)
    assert m["v3_shelf_cross_anchor_failure_rate"] == pytest.approx(0.5)


def test_v2_shelf_cross_anchor_rate_surfaces_legacy_degeneracy():
    """v2 is anchored at VAH/VAL — when the rolling tactical anchor is off
    from VAH/VAL (the common case), every snapshot 'fails' this check. That
    IS the pathology the audit reviewer described, and the metric should
    surface it as a high failure rate."""
    acc = MethodologyHealthAccumulator()
    anchor = 30500.0
    vah = 30530.0
    val = 30470.0
    for i in range(4):
        acc.observe(
            ts_ns=i * SECOND_NS, emitted=True, auction_state="above_value",
            tactical_status="live",
            shelves=_v3_shelves(anchor=anchor) + _v2_shelves(
                anchor=anchor, vah=vah, val=val,
            ),
            cap_bind_flags={}, anchor=anchor,
        )
    m = acc.metrics(now_ts_ns=4 * SECOND_NS)
    # v3 is healthy; v2 is broken (every snapshot)
    assert m["v3_shelf_cross_anchor_failure_rate"] == 0.0
    assert m["v2_shelf_cross_anchor_failure_rate"] == 1.0


def test_anchor_state_distribution_normalizes_to_unity():
    acc = MethodologyHealthAccumulator()
    states = ["above_value", "above_value", "inside_value",
              "below_value", "below_value", "below_value",
              "below_value"]
    for i, st in enumerate(states):
        acc.observe(
            ts_ns=i * SECOND_NS, emitted=True, auction_state=st,
            tactical_status="live", shelves=[], cap_bind_flags={},
            anchor=30500.0,
        )
    m = acc.metrics(now_ts_ns=len(states) * SECOND_NS)
    dist = m["anchor_vs_value_distribution"]
    assert dist["above_value"] == pytest.approx(2 / 7)
    assert dist["inside_value"] == pytest.approx(1 / 7)
    assert dist["below_value"] == pytest.approx(4 / 7)
    assert sum(dist.values()) == pytest.approx(1.0)


def test_warmup_share_tracks_tactical_status():
    acc = MethodologyHealthAccumulator()
    for i, st in enumerate(["warmup", "warmup", "live", "live", "live"]):
        acc.observe(
            ts_ns=i * SECOND_NS, emitted=True, auction_state="inside_value",
            tactical_status=st, shelves=[], cap_bind_flags={},
            anchor=30500.0,
        )
    m = acc.metrics(now_ts_ns=5 * SECOND_NS)
    assert m["warmup_share"] == pytest.approx(0.4)


def test_estimator_width_divergence_quantile_wider_by_ticks():
    """When quantile shelves are wider than RMS, divergence is positive in
    ticks. Mirrors the live divergence the operator already observed
    (RMS=13.39pt, quantile=15.53pt → +8.56 ticks)."""
    acc = MethodologyHealthAccumulator()
    anchor = 30500.0
    # quantile +2 ticks wider than RMS, twice
    for i in range(2):
        acc.observe(
            ts_ns=i * SECOND_NS, emitted=True, auction_state="inside_value",
            tactical_status="live",
            shelves=_v3_shelves(
                anchor=anchor, sup1_width=5.0, dem1_width=5.0,
                quantile_sup1_width=5.5, quantile_dem1_width=5.5,
            ),
            cap_bind_flags={}, anchor=anchor,
        )
    m = acc.metrics(now_ts_ns=2 * SECOND_NS)
    # (5.5 - 5.0) / 0.25 tick = +2 ticks; averaged across 2 obs = +2 ticks
    assert m["estimator_width_divergence_sup_1_ticks"] == pytest.approx(2.0)


def test_window_pruning_drops_old_observations():
    acc = MethodologyHealthAccumulator(window_seconds=10)
    # 5 old observations (well outside the window), 3 fresh
    for i in range(5):
        acc.observe(
            ts_ns=i * SECOND_NS, emitted=True, auction_state="above_value",
            tactical_status="live", shelves=[], cap_bind_flags={},
            anchor=30500.0,
        )
    # Jump forward 100s; observe 3 fresh in this window
    for i in range(3):
        acc.observe(
            ts_ns=(100 + i) * SECOND_NS, emitted=True,
            auction_state="below_value", tactical_status="live",
            shelves=[], cap_bind_flags={}, anchor=30500.0,
        )
    m = acc.metrics(now_ts_ns=103 * SECOND_NS)
    # Only the 3 fresh observations survive the prune.
    assert m["observation_count"] == 3
    assert m["anchor_vs_value_distribution"]["below_value"] == pytest.approx(1.0)
    assert m["anchor_vs_value_distribution"]["above_value"] == 0.0


def test_emit_rate_per_minute_uses_emit_count_only():
    """Emit rate counts only emitted observations; throttled passes are
    observed but do NOT count toward emit_rate_per_minute."""
    acc = MethodologyHealthAccumulator(window_seconds=60)
    for i in range(12):
        acc.observe(
            ts_ns=i * SECOND_NS, emitted=(i % 2 == 0),  # 6 emits in 12 passes
            auction_state="inside_value", tactical_status="live",
            shelves=[], cap_bind_flags={}, anchor=30500.0,
        )
    m = acc.metrics(now_ts_ns=12 * SECOND_NS)
    assert m["emit_count"] == 6
    # window=60s = 1min, 6 emits → 6/min
    assert m["emit_rate_per_minute"] == pytest.approx(6.0)


def test_default_window_is_ten_minutes():
    assert DEFAULT_WINDOW_SECONDS == 600
    acc = MethodologyHealthAccumulator()
    assert acc.window_seconds == 600
