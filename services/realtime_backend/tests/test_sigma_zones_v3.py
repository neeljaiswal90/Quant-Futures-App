"""Unit tests for RA-112e step 4 v3 σ-shelf compute (sigma_zones_v3)."""

from __future__ import annotations

import json
import math

import pytest

from realtime_backend.sigma_zones_v3 import (
    DEFAULT_PRIOR_ATR_60M,
    FAMILY_V2,
    FAMILY_V3,
    ShelfDescriptor,
    _build_shelf,
    _nearest_structural,
    _resolve_atr_60m,
    _v3_shelves,
    compute_zone_shelves,
)


# ---------------------------------------------------------------------------
# Pure geometry (no I/O)
# ---------------------------------------------------------------------------


class TestV3Geometry:
    def test_supply_shelves_anchored_at_vwap_w(self):
        """Shelf bottoms walk up FROM the anchor, never cross below it."""
        shelves, caps, srcs = _v3_shelves(
            anchor=30419.0, sigma_above=24.0, sigma_below=26.0, atr_cap=32.0,
            vah=30560.0, val=30424.0, tick_size=0.25, reference_lines=[],
        )
        sup = [s for s in shelves if s.name.startswith("SUP_")]
        assert len(sup) == 3
        # SUP_1 bottom == anchor (the fix).
        assert sup[0].low == 30419.0
        # Tiers are non-overlapping: bottom of each = top of the previous.
        assert sup[0].high == sup[1].low
        assert sup[1].high == sup[2].low
        # All sup tops sit above the anchor.
        assert all(s.high > 30419.0 for s in sup)

    def test_demand_shelves_anchored_at_vwap_w(self):
        shelves, caps, srcs = _v3_shelves(
            anchor=30419.0, sigma_above=24.0, sigma_below=26.0, atr_cap=32.0,
            vah=30560.0, val=30424.0, tick_size=0.25, reference_lines=[],
        )
        dem = [s for s in shelves if s.name.startswith("DEM_")]
        assert len(dem) == 3
        # DEM_1 top == anchor (the fix).
        assert dem[0].high == 30419.0
        # Tiers non-overlapping going DOWN.
        assert dem[0].low == dem[1].high
        assert dem[1].low == dem[2].high
        assert all(s.low < 30419.0 for s in dem)

    def test_cap_binds_when_sigma_exceeds_cap_per_tier(self):
        """Large σ + small ATR_cap -> every tier hits atr_cap."""
        shelves, caps, srcs = _v3_shelves(
            anchor=30000.0,
            sigma_above=100.0,
            sigma_below=100.0,
            atr_cap=20.0,
            vah=30100.0, val=29900.0, tick_size=0.25, reference_lines=[],
        )
        for s in shelves:
            key = f"{FAMILY_V3}:{s.name}"
            assert caps[key] is True
            assert srcs[key] == "atr_cap"
            assert s.cap_bound is True
            assert s.bound_source == "atr_cap"
        sup = sorted([s for s in shelves if s.name.startswith("SUP_")], key=lambda x: x.tier)
        assert pytest.approx(sup[0].high - sup[0].low, abs=0.01) == 10.0
        assert pytest.approx(sup[1].high - sup[1].low, abs=0.01) == 10.0
        assert pytest.approx(sup[2].high - sup[2].low, abs=0.01) == 10.0

    def test_estimator_drives_widths_when_sigma_under_cap(self):
        shelves, caps, srcs = _v3_shelves(
            anchor=30000.0,
            sigma_above=2.0,
            sigma_below=2.0,
            atr_cap=200.0,
            vah=30100.0, val=29900.0, tick_size=0.25, reference_lines=[],
        )
        for s in shelves:
            assert s.bound_source == "estimator"
            assert s.cap_bound is False

    def test_asymmetric_sigma_produces_asymmetric_shelves(self):
        shelves, caps, srcs = _v3_shelves(
            anchor=30000.0, sigma_above=10.0, sigma_below=30.0, atr_cap=100.0,
            vah=30100.0, val=29900.0, tick_size=0.25, reference_lines=[],
        )
        sup_1 = next(s for s in shelves if s.name == "SUP_1")
        dem_1 = next(s for s in shelves if s.name == "DEM_1")
        assert (dem_1.high - dem_1.low) > (sup_1.high - sup_1.low)

    def test_confluence_overlap_with_vah(self):
        shelves, caps, srcs = _v3_shelves(
            anchor=30000.0, sigma_above=24.0, sigma_below=24.0, atr_cap=200.0,
            vah=30010.0, val=29990.0,
            tick_size=0.25, reference_lines=[],
        )
        sup_1 = next(s for s in shelves if s.name == "SUP_1")
        assert sup_1.overlaps_vah is True
        dem_1 = next(s for s in shelves if s.name == "DEM_1")
        assert dem_1.overlaps_val is True

    def test_nearest_structural_level_metadata(self):
        shelves, _, _ = _v3_shelves(
            anchor=30000.0, sigma_above=24.0, sigma_below=24.0, atr_cap=200.0,
            vah=30100.0, val=29900.0, tick_size=0.25,
            reference_lines=[
                {"source": "vpoc", "price": 30000.0},
                {"source": "lvn_globex", "price": 30050.0},
                {"source": "hvn_globex", "price": 29975.0},
            ],
        )
        sup_2 = next(s for s in shelves if s.name == "SUP_2")
        assert sup_2.nearest_structural_level == "lvn_globex"
        assert sup_2.distance_to_structural_level_ticks is not None
        assert sup_2.distance_to_structural_level_ticks >= 0


class TestNearestStructural:
    def test_empty_reference_lines_returns_none(self):
        nearest, dist = _nearest_structural(30000.0, [], tick_size=0.25)
        assert nearest is None
        assert dist is None

    def test_picks_smallest_distance(self):
        nearest, dist = _nearest_structural(
            30000.0,
            [
                {"source": "vah", "price": 30050.0},
                {"source": "vpoc", "price": 30005.0},
                {"source": "val", "price": 29900.0},
            ],
            tick_size=0.25,
        )
        assert nearest == "vpoc"
        assert dist == pytest.approx(20.0)

    def test_skips_malformed_records(self):
        nearest, dist = _nearest_structural(
            30000.0,
            [
                {"source": "vah", "price": None},
                {"price": 30005.0},
                {"source": "vpoc", "price": "abc"},
                {"source": "lvn", "price": 30001.0},
            ],
            tick_size=0.25,
        )
        assert nearest == "lvn"


class TestBuildShelf:
    def test_low_high_normalized(self):
        s = _build_shelf(
            family=FAMILY_V3, name="SUP_1", tier=1,
            low=30100.0, high=30050.0,
            bound_source="estimator", vah=30200.0, val=30000.0,
            tick_size=0.25, reference_lines=[],
        )
        assert s.low == 30050.0
        assert s.high == 30100.0


class TestResolveAtr:
    def test_returns_computed_when_atr_is_finite(self):
        import numpy as np
        import pandas as pd
        n = 30 * 60
        ts = np.arange(n, dtype="int64") * 60 * 10**9
        px = 30000 + np.cumsum(np.random.default_rng(0).normal(0, 1, n))
        df = pd.DataFrame({
            "event_ts_ns": ts, "price": px.astype("float64"),
            "quantity": np.ones(n, dtype="int32"),
        })
        value, source = _resolve_atr_60m(df, prior_atr_60m=99.0)
        assert source == "computed"
        assert value > 0
        assert value != 99.0

    def test_falls_back_to_prior_when_tape_too_young(self):
        import pandas as pd
        df = pd.DataFrame(
            {"event_ts_ns": [0], "price": [30000.0], "quantity": [1]}
        )
        value, source = _resolve_atr_60m(df, prior_atr_60m=66.0)
        assert source == "fallback_prior_session"
        assert value == 66.0

    def test_falls_back_to_constant_when_no_prior(self):
        import pandas as pd
        df = pd.DataFrame(
            {"event_ts_ns": [0], "price": [30000.0], "quantity": [1]}
        )
        value, source = _resolve_atr_60m(df, prior_atr_60m=None)
        assert source == "fallback_constant"
        assert value == DEFAULT_PRIOR_ATR_60M


def _write_synthetic_tape(path, n_trades=2000, base_ts_ns=1_780_000_000_000_000_000):
    import numpy as np
    rng = np.random.default_rng(42)
    times = base_ts_ns + np.arange(n_trades, dtype="int64") * 1_000_000_000
    prices = 30400.0 + 0.01 * np.arange(n_trades) + rng.normal(0, 1.0, n_trades)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for ts, px in zip(times, prices):
            rec = {
                "type": "TRADE",
                "payload": {
                    "exchange_event_ts_ns": int(ts),
                    "price": float(round(px * 4) / 4),
                    "quantity": 1,
                    "aggressor_side": "buy" if rng.random() > 0.5 else "sell",
                },
            }
            fh.write(json.dumps(rec) + "\n")


class TestComputeZoneShelvesE2E:
    def test_returns_none_when_inputs_missing(self, tmp_path):
        out = compute_zone_shelves(
            capture_path=tmp_path / "missing.jsonl",
            vah=30500.0, val=30400.0, vpoc=30450.0, bin_size_ticks=8,
        )
        assert out is None

    def test_returns_none_when_no_vah_val(self, tmp_path):
        path = tmp_path / "tape.jsonl"
        _write_synthetic_tape(path, n_trades=200)
        out = compute_zone_shelves(
            capture_path=path, vah=None, val=30400.0, vpoc=30450.0,
            bin_size_ticks=8,
        )
        assert out is None

    def test_produces_six_v3_shelves_and_four_v2_legacy(self, tmp_path):
        path = tmp_path / "tape.jsonl"
        _write_synthetic_tape(path)
        out = compute_zone_shelves(
            capture_path=path,
            vah=30500.0, val=30400.0, vpoc=30450.0,
            bin_size_ticks=8, prior_atr_60m=60.0,
            tail_bytes=10_000_000,
        )
        assert out is not None
        v3 = [s for s in out.shelves if s.family == FAMILY_V3]
        v2 = [s for s in out.shelves if s.family == FAMILY_V2]
        assert len(v3) == 6
        assert len(v2) == 4
        assert {s.name for s in v3} == {
            "SUP_1", "SUP_2", "SUP_3", "DEM_1", "DEM_2", "DEM_3"
        }

    def test_v3_shelves_do_not_cross_the_anchor(self, tmp_path):
        """Regression for the v2 pathology: SUP_1 LOW must equal the anchor,
        and DEM_1 HIGH must equal the anchor, even on a drifty tape."""
        path = tmp_path / "tape.jsonl"
        _write_synthetic_tape(path)
        out = compute_zone_shelves(
            capture_path=path,
            vah=30500.0, val=30400.0, vpoc=30450.0,
            bin_size_ticks=8, prior_atr_60m=60.0,
            tail_bytes=10_000_000,
        )
        assert out is not None
        sup_1 = next(s for s in out.shelves if s.family == FAMILY_V3 and s.name == "SUP_1")
        dem_1 = next(s for s in out.shelves if s.family == FAMILY_V3 and s.name == "DEM_1")
        assert sup_1.low == pytest.approx(out.anchor)
        assert dem_1.high == pytest.approx(out.anchor)

    def test_atr_cap_source_falls_back_on_young_tape(self, tmp_path):
        path = tmp_path / "tape.jsonl"
        _write_synthetic_tape(path, n_trades=300)
        out = compute_zone_shelves(
            capture_path=path,
            vah=30500.0, val=30400.0, vpoc=30450.0,
            bin_size_ticks=8, prior_atr_60m=66.0,
            tail_bytes=10_000_000,
        )
        assert out is not None
        assert out.atr_cap_source == "fallback_prior_session"
        assert out.atr_14_60m == 66.0

    def test_cap_bind_flags_match_shelf_bound_sources(self, tmp_path):
        path = tmp_path / "tape.jsonl"
        _write_synthetic_tape(path)
        out = compute_zone_shelves(
            capture_path=path,
            vah=30500.0, val=30400.0, vpoc=30450.0,
            bin_size_ticks=8, prior_atr_60m=60.0,
            tail_bytes=10_000_000,
        )
        assert out is not None
        shelf_keys = {f"{s.family}:{s.name}" for s in out.shelves}
        assert set(out.cap_bind_flags.keys()) == shelf_keys
        for s in out.shelves:
            key = f"{s.family}:{s.name}"
            assert out.cap_bind_flags[key] == s.cap_bound
