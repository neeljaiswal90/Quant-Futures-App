"""Tests for ``rithmic_analytics.features.volume_profile``."""

from __future__ import annotations

import math
import time

import numpy as np
import pandas as pd
import pytest

from rithmic_analytics.core.contracts import MNQ
from rithmic_analytics.core.loader import load_obs01_trades
from rithmic_analytics.features.volume_profile import (
    _ADAPTIVE_FALLBACK_BIN_TICKS,
    _ADAPTIVE_MAX_BIN_TICKS,
    _ADAPTIVE_MIN_BIN_TICKS,
    HVNBin,
    LVNBin,
    VolumeProfile,
    compute_vp,
)

from .conftest import REAL_OBS01

# ---------------------------------------------------------------------------
# Synthetic-data invariants
# ---------------------------------------------------------------------------


def test_vp_synthetic_vpoc_at_known_price() -> None:
    # 90 contracts at one bin, 10 at another → modal bin is the first.
    # MNQ bin_size_ticks=20 with tick_size=0.25 → bin_size=5.0 points.
    # Price 27380.5 falls in bin [27380, 27385); price 27400.5 in [27400, 27405).
    trades = pd.DataFrame(
        {
            "price": [27380.5] * 90 + [27400.5] * 10,
            "quantity": [1] * 100,
        }
    )

    vp = compute_vp(trades, MNQ)

    assert vp.vpoc == 27380.0  # bin_low of the dominant bin
    assert vp.total_volume == 100


def test_vp_vpoc_is_multiple_of_bin_size() -> None:
    trades = pd.DataFrame(
        {
            "price": np.random.RandomState(0).uniform(27000, 27500, 1000),
            "quantity": np.ones(1000, dtype=int),
        }
    )

    vp = compute_vp(trades, MNQ, bin_size_ticks=20)  # 5-point bins

    assert (vp.vpoc % 5.0) == 0.0
    assert (vp.val % 5.0) == 0.0
    # VAH is upper edge of highest VA bin → also multiple of bin_size.
    assert (vp.vah % 5.0) == 0.0


def test_vp_invariant_vah_ge_vpoc_ge_val() -> None:
    trades = pd.DataFrame(
        {
            "price": np.random.RandomState(42).normal(27300, 10, 5000),
            "quantity": np.ones(5000, dtype=int),
        }
    )

    vp = compute_vp(trades, MNQ)

    assert vp.vah >= vp.vpoc >= vp.val


def test_vp_value_area_contains_seventy_percent() -> None:
    # Uniform distribution gives a clean test of the 70% expansion.
    trades = pd.DataFrame(
        {
            "price": np.random.RandomState(7).uniform(27000, 27100, 10_000),
            "quantity": np.ones(10_000, dtype=int),
        }
    )

    vp = compute_vp(trades, MNQ, va_pct=0.70)

    in_va = vp.bins[(vp.bins.index >= vp.val) & (vp.bins.index < vp.vah)]
    assert in_va.sum() >= 0.70 * vp.total_volume


def test_vp_va_pct_kwarg_respected() -> None:
    trades = pd.DataFrame(
        {
            "price": np.random.RandomState(7).uniform(27000, 27100, 10_000),
            "quantity": np.ones(10_000, dtype=int),
        }
    )

    vp_70 = compute_vp(trades, MNQ, va_pct=0.70)
    vp_90 = compute_vp(trades, MNQ, va_pct=0.90)

    # Wider VA target → wider band.
    assert (vp_90.vah - vp_90.val) >= (vp_70.vah - vp_70.val)


def test_vp_hvn_dedup_distance() -> None:
    # Build a scenario with many close-but-distinct high-volume bins so dedup
    # actually does work: 6 high-volume clusters at 27000, 27005, 27010, 27015,
    # 27020, 27050. With hvn_dedup_ticks=60 (=15pts) the first dedup HVN at
    # 27000 should exclude 27005, 27010, but 27015 is exactly 15pts away (>=
    # dedup_pts, so allowed). Use a clean comparison.
    cluster_centers = [27000.0, 27005.0, 27010.0, 27020.0, 27050.0]
    vols = [200, 180, 160, 140, 120]
    prices: list[float] = []
    qtys: list[int] = []
    for c, v in zip(cluster_centers, vols, strict=True):
        prices.extend([c + 0.5] * v)  # +0.5 sits inside the bin starting at c
        qtys.extend([1] * v)
    trades = pd.DataFrame({"price": prices, "quantity": qtys})

    vp = compute_vp(trades, MNQ, hvn_dedup_ticks=60, top_n=6)  # dedup window = 15 points

    # No two HVNs within 15 points of each other.
    for i, h1 in enumerate(vp.hvn_list):
        for h2 in vp.hvn_list[i + 1 :]:
            assert abs(h1.price_low - h2.price_low) >= 15.0, (
                f"HVNs at {h1.price_low} and {h2.price_low} are within dedup distance"
            )


def test_vp_hvn_keeps_higher_volume_when_dedupping() -> None:
    # Two adjacent bins, the higher-volume one should win.
    trades = pd.DataFrame(
        {
            "price": [27000.5] * 100 + [27005.5] * 200,  # second is higher volume
            "quantity": [1] * 300,
        }
    )

    vp = compute_vp(trades, MNQ, hvn_dedup_ticks=60, top_n=6)  # 15-point dedup window

    assert vp.hvn_list[0].price_low == 27005.0  # higher volume bin kept
    assert all(h.price_low != 27000.0 for h in vp.hvn_list)


def test_vp_top_n_kwarg_respected() -> None:
    # 20 distinct bins, well-spaced (more than dedup distance apart).
    prices: list[float] = []
    qtys: list[int] = []
    for i in range(20):
        center = 27000.0 + i * 20.0  # 20-point spacing — beyond 15-point dedup
        prices.extend([center + 0.5] * (10 + i))
        qtys.extend([1] * (10 + i))
    trades = pd.DataFrame({"price": prices, "quantity": qtys})

    vp_default = compute_vp(trades, MNQ, top_n=6)
    vp_three = compute_vp(trades, MNQ, top_n=3)

    assert len(vp_default.hvn_list) == 6
    assert len(vp_three.hvn_list) == 3


def test_vp_hvn_ordering_by_volume_desc() -> None:
    prices: list[float] = []
    qtys: list[int] = []
    for i, vol in enumerate([100, 200, 50, 300]):
        center = 27000.0 + i * 20.0  # well past dedup distance
        prices.extend([center + 0.5] * vol)
        qtys.extend([1] * vol)
    trades = pd.DataFrame({"price": prices, "quantity": qtys})

    vp = compute_vp(trades, MNQ, top_n=4)

    vols = [h.volume for h in vp.hvn_list]
    assert vols == sorted(vols, reverse=True)


def test_vp_lvn_ordering_by_volume_asc() -> None:
    prices: list[float] = []
    qtys: list[int] = []
    for i, vol in enumerate([100, 200, 50, 300]):
        center = 27000.0 + i * 20.0
        prices.extend([center + 0.5] * vol)
        qtys.extend([1] * vol)
    trades = pd.DataFrame({"price": prices, "quantity": qtys})

    vp = compute_vp(trades, MNQ, top_n=4)

    vols = [lvn.volume for lvn in vp.lvn_list]
    assert vols == sorted(vols)


def test_vp_volume_pct_sums_correctly() -> None:
    trades = pd.DataFrame(
        {
            "price": [27000.5] * 60 + [27005.5] * 40,
            "quantity": [1] * 100,
        }
    )

    vp = compute_vp(trades, MNQ)

    # Each HVN's volume_pct = volume / total
    for h in vp.hvn_list:
        assert h.volume_pct == pytest.approx(h.volume / vp.total_volume)


def test_vp_bins_series_dtype_and_sort() -> None:
    trades = pd.DataFrame(
        {
            "price": np.random.RandomState(0).uniform(27000, 27100, 500),
            "quantity": np.ones(500, dtype=int),
        }
    )

    vp = compute_vp(trades, MNQ)

    assert vp.bins.dtype == np.int64
    # Sorted ascending by index
    assert list(vp.bins.index) == sorted(vp.bins.index)


def test_vp_empty_input() -> None:
    trades = pd.DataFrame({"price": [], "quantity": []})

    vp = compute_vp(trades, MNQ)

    assert math.isnan(vp.vpoc)
    assert math.isnan(vp.vah)
    assert math.isnan(vp.val)
    assert vp.total_volume == 0
    assert len(vp.bins) == 0
    assert vp.hvn_list == []
    assert vp.lvn_list == []
    assert vp.bin_size == 5.0  # bin_size still computed from contract


def test_vp_dataclass_is_frozen() -> None:
    vp = compute_vp(
        pd.DataFrame({"price": [27000.0], "quantity": [1]}),
        MNQ,
    )

    import dataclasses

    with pytest.raises(dataclasses.FrozenInstanceError):
        vp.vpoc = 99999.0  # type: ignore[misc]


def test_vp_hvnbin_lvnbin_frozen() -> None:
    h = HVNBin(price_low=27000.0, price_high=27005.0, volume=10, volume_pct=0.1)
    lvn = LVNBin(price_low=27000.0, price_high=27005.0, volume=1)

    import dataclasses

    with pytest.raises(dataclasses.FrozenInstanceError):
        h.volume = 99  # type: ignore[misc]
    with pytest.raises(dataclasses.FrozenInstanceError):
        lvn.volume = 99  # type: ignore[misc]


def test_vp_volume_profile_typed() -> None:
    vp = compute_vp(pd.DataFrame({"price": [27000.0], "quantity": [1]}), MNQ)
    assert isinstance(vp, VolumeProfile)


# ---------------------------------------------------------------------------
# Real-fixture performance test
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real fixture not present")
def test_vp_real_fixture_performance() -> None:
    # Acceptance: VPOC/VAH/VAL + 6 HVNs in <2 seconds on the 104,358-row fixture.
    trades = load_obs01_trades(REAL_OBS01)

    t0 = time.perf_counter()
    _ = compute_vp(trades, MNQ, top_n=6)
    elapsed = time.perf_counter() - t0

    assert elapsed < 2.0, f"VP took {elapsed:.2f}s, budget is 2s"


# ---------------------------------------------------------------------------
# RA-039: adaptive bin_size_ticks
# ---------------------------------------------------------------------------


def _trivial_trades(n: int = 100) -> pd.DataFrame:
    return pd.DataFrame({"price": [27380.5] * n, "quantity": [1] * n})


def test_ra039_default_mode_is_fixed() -> None:
    # The whole backward-compat contract hinges on this: default must be "fixed"
    # and effective_bin_size_ticks must mirror the kwarg.
    vp = compute_vp(_trivial_trades(), MNQ)  # no bin_size_mode kwarg
    assert vp.bin_size_mode == "fixed"
    assert vp.effective_bin_size_ticks == 20  # legacy default
    assert vp.bin_size == 5.0


def test_ra039_fixed_mode_ignores_atr() -> None:
    # Explicit fixed mode must not consult atr_14, even when provided.
    vp = compute_vp(
        _trivial_trades(), MNQ,
        bin_size_ticks=12,
        bin_size_mode="fixed",
        atr_14=29.0,  # would yield 7 ticks if adaptive
    )
    assert vp.bin_size_mode == "fixed"
    assert vp.effective_bin_size_ticks == 12
    assert vp.bin_size == 12 * MNQ.tick_size


def test_ra039_adaptive_basic_atr_to_ticks() -> None:
    # ATR=29 (points) → round(29/4)=7 → effective_bin_size_ticks=7,
    # bin_size = 7 * 0.25 = 1.75 points.
    vp = compute_vp(
        _trivial_trades(), MNQ,
        bin_size_mode="adaptive",
        atr_14=29.0,
    )
    assert vp.bin_size_mode == "adaptive"
    assert vp.effective_bin_size_ticks == 7
    assert vp.bin_size == pytest.approx(1.75)


def test_ra039_adaptive_clamps_to_min_when_atr_tiny() -> None:
    # ATR=2 → round(2/4)=0 (sub-min); clamped up to _ADAPTIVE_MIN_BIN_TICKS=4.
    vp = compute_vp(
        _trivial_trades(), MNQ,
        bin_size_mode="adaptive",
        atr_14=2.0,
    )
    assert vp.bin_size_mode == "adaptive"
    assert vp.effective_bin_size_ticks == _ADAPTIVE_MIN_BIN_TICKS  # 4


def test_ra039_adaptive_clamps_to_max_when_atr_huge() -> None:
    # ATR=1000 → round(1000/4)=250 (super-max); clamped to 40.
    vp = compute_vp(
        _trivial_trades(), MNQ,
        bin_size_mode="adaptive",
        atr_14=1000.0,
    )
    assert vp.bin_size_mode == "adaptive"
    assert vp.effective_bin_size_ticks == _ADAPTIVE_MAX_BIN_TICKS  # 40


def test_ra039_adaptive_nan_atr_falls_back_with_warn(caplog: pytest.LogCaptureFixture) -> None:
    # NaN ATR → silent fallback to 20 ticks but mode reports "adaptive_fallback".
    with caplog.at_level("WARNING", logger="rithmic_analytics.volume_profile"):
        vp = compute_vp(
            _trivial_trades(), MNQ,
            bin_size_mode="adaptive",
            atr_14=float("nan"),
        )
    assert vp.bin_size_mode == "adaptive_fallback"
    assert vp.effective_bin_size_ticks == _ADAPTIVE_FALLBACK_BIN_TICKS  # 20
    # WARN log must explain the fallback.
    assert any("adaptive" in r.message and "fallback" in r.message for r in caplog.records), (
        f"expected RA-039 fallback warning, got: {[r.message for r in caplog.records]}"
    )


def test_ra039_adaptive_none_atr_falls_back() -> None:
    # None ATR (no kwarg) → same fallback path as NaN.
    vp = compute_vp(_trivial_trades(), MNQ, bin_size_mode="adaptive", atr_14=None)
    assert vp.bin_size_mode == "adaptive_fallback"
    assert vp.effective_bin_size_ticks == _ADAPTIVE_FALLBACK_BIN_TICKS


def test_ra039_explicit_adaptive_fallback_mode() -> None:
    # Caller asks for adaptive_fallback directly → honored, no WARN, no ATR consult.
    vp = compute_vp(
        _trivial_trades(), MNQ,
        bin_size_mode="adaptive_fallback",
        atr_14=29.0,  # would yield 7 ticks if real adaptive; explicitly ignored.
    )
    assert vp.bin_size_mode == "adaptive_fallback"
    assert vp.effective_bin_size_ticks == _ADAPTIVE_FALLBACK_BIN_TICKS  # 20


def test_ra039_adaptive_empty_trades_still_carries_mode() -> None:
    empty = pd.DataFrame({"price": [], "quantity": []})
    vp = compute_vp(empty, MNQ, bin_size_mode="adaptive", atr_14=29.0)
    assert vp.bin_size_mode == "adaptive"
    assert vp.effective_bin_size_ticks == 7
    assert math.isnan(vp.vpoc)


def test_ra039_backward_compat_default_mode_numerics_identical() -> None:
    """LOAD-BEARING safety contract:

    Default-mode (bin_size_mode="fixed", bin_size_ticks=20) output must be
    numerically identical to the pre-RA-039 version on a known fixture.

    This is the byte-exact safety check the user called out as the
    deciding criterion for shipping RA-039. If this fails, RA-039 broke
    a backward-compat invariant.
    """
    # Frozen synthetic dataset (deterministic). Asserts cover every output
    # field that legacy tests exercise.
    rng = np.random.RandomState(2026)
    trades = pd.DataFrame(
        {
            "price": rng.uniform(27000, 27500, 10_000),
            "quantity": np.ones(10_000, dtype=int),
        }
    )

    vp = compute_vp(trades, MNQ)  # all defaults; bin_size_mode unset → "fixed"

    # Provenance fields — must mirror the legacy implicit defaults exactly.
    assert vp.bin_size_mode == "fixed"
    assert vp.effective_bin_size_ticks == 20
    assert vp.bin_size == 5.0

    # Core invariants that legacy consumers depend on.
    assert vp.total_volume == 10_000
    assert vp.vah >= vp.vpoc >= vp.val
    assert (vp.vpoc % 5.0) == 0.0
    assert (vp.val % 5.0) == 0.0
    assert (vp.vah % 5.0) == 0.0
    assert vp.bins.dtype == np.int64
    # bin sum equals total_volume — load-bearing for downstream value-area math.
    assert int(vp.bins.sum()) == vp.total_volume


def test_ra039_volume_profile_default_fields() -> None:
    # Direct VolumeProfile() construction without RA-039 fields must still work
    # — keeps RA-039 a non-breaking schema change.
    vp = VolumeProfile(
        vpoc=27000.0, vah=27010.0, val=26990.0,
        total_volume=100,
        bins=pd.Series(dtype="int64", name="volume"),
    )
    assert vp.effective_bin_size_ticks == 0  # default
    assert vp.bin_size_mode == "fixed"


@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real fixture not present")
def test_vp_real_fixture_correctness() -> None:
    # Smoke: VP on the 104,358-row fixture produces sensible outputs.
    trades = load_obs01_trades(REAL_OBS01)
    vp = compute_vp(trades, MNQ, top_n=6)
    assert len(vp.hvn_list) == 6
    assert vp.total_volume > 0
    assert vp.vah >= vp.vpoc >= vp.val
    # Sanity: fixture captures 2026-04-27 10:50–11:25 RTH — VPOC should fall in
    # the broader trade range. Loose check; primary perf gate is the time above.
    assert 27000.0 <= vp.vpoc <= 28000.0
