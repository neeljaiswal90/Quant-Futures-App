"""Tests for ``rithmic_analytics.features.sigma_zones_v2`` (RA-098).

Each gap from the v1 audit closes via one or more tests below:
  1. Asymmetric σ_above ≠ σ_below on skewed sessions
  2. Trend-tracking trailing-window VWAP (not session-anchored)
  3. ATR cap clamps wide-σ zones
  4. VPOC band uses bin width
  5. Multi-session bonus enters confluence_score_v2
  + defensive handling of empty / single-sided sessions
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from rithmic_analytics.features.sigma_zones_v2 import (
    compute_sigma_zones_v2,
    confluence_score_v2,
)

_NS_PER_MINUTE = 60 * 10**9


def _trades(
    prices: list[float],
    *,
    quantities: list[int] | None = None,
    start_ns: int = 0,
    step_ns: int = _NS_PER_MINUTE,
) -> pd.DataFrame:
    """Build a synthetic trades DataFrame for tests."""
    n = len(prices)
    qty = quantities or [1] * n
    return pd.DataFrame(
        {
            "event_ts_ns": np.arange(n, dtype="int64") * step_ns + start_ns,
            "price": np.asarray(prices, dtype="float64"),
            "quantity": np.asarray(qty, dtype="int64"),
        }
    )


# ---------------------------------------------------------------------------
# Audit gap 1: asymmetric σ
# ---------------------------------------------------------------------------


def test_asymmetric_sigma_skewed_session():
    """Up-skewed session: more dispersion above VWAP than below → σ_above > σ_below."""
    # Heavy excursions above the mean, tight below.
    prices = [100.0] * 10 + [101.0, 102.0, 103.0, 104.0, 105.0, 100.0, 99.8, 100.2, 99.9, 100.1]
    trades = _trades(prices)
    out = compute_sigma_zones_v2(
        trades,
        vah=101.0,
        val=99.5,
        vpoc=100.0,
        bin_size_ticks=4,
        atr_14=10.0,
    )
    assert out.sigma_above > out.sigma_below
    assert out.sigma_above > 0
    # Symmetric ±σ from v1 would not see this.


def test_constant_prices_yield_zero_sigma_both_sides():
    """Degenerate case: all prices identical → both σ_above and σ_below = 0.

    (A truly one-sided distribution is impossible by construction: VWAP is
    the volume-weighted mean, so residuals always exist on both sides unless
    every price equals VWAP exactly.)
    """
    # Constant prices AT VPOC keep VWAP centered inside value area, so both
    # supply (no extension above VAH) and demand (no extension below VAL)
    # collapse cleanly without VWAP-vs-VAH/VAL geometry leaking width.
    trades = _trades([100.0] * 10)
    out = compute_sigma_zones_v2(
        trades, vah=100.5, val=99.5, vpoc=100.0, bin_size_ticks=4, atr_14=5.0
    )
    assert out.sigma_above == 0.0
    assert out.sigma_below == 0.0
    # Supply collapses to zero-width AT VAH (invariant top>=VAH; σ_extension=VWAP=100<VAH).
    assert out.sigma_1_supply.top == 100.5
    assert out.sigma_1_supply.bottom == 100.5
    assert out.sigma_1_supply.width_pts == 0.0
    # Demand collapses to zero-width AT VAL (invariant bottom<=VAL; σ_extension=VWAP=100>VAL).
    assert out.sigma_2_demand.top == 99.5
    assert out.sigma_2_demand.bottom == 99.5
    assert out.sigma_2_demand.width_pts == 0.0


# ---------------------------------------------------------------------------
# Audit gap 2: trend-tracking trailing-window VWAP
# ---------------------------------------------------------------------------


def test_trailing_window_tracks_recent_price(monkeypatch):
    """A long quiet baseline followed by a sharp recent move should produce a
    VWAP near the RECENT prices (trailing window), not the session average."""
    # First 200 minutes flat at 100; last 30 minutes climb to 110.
    quiet = [100.0] * 200
    climb = list(np.linspace(101.0, 110.0, 30))
    trades = _trades(quiet + climb)
    out = compute_sigma_zones_v2(
        trades,
        vah=105.0,
        val=99.0,
        vpoc=100.0,
        bin_size_ticks=4,
        atr_14=8.0,
        window_minutes=60,  # default — only the last 60 trades count
    )
    # Trailing-window VWAP should be well above 100 (closer to ~107 since the
    # last 60 trades include 30 climbers + 30 flat-100 tail).
    # Without windowing (v1-style anchored), the session VWAP would be near 101.
    assert out.vwap_window > 102.0, f"trailing VWAP too low: {out.vwap_window}"


# ---------------------------------------------------------------------------
# Audit gap 3: ATR cap clamps wide-σ zones
# ---------------------------------------------------------------------------


def test_atr_cap_clamps_wide_supply_zone():
    """When σ-driven extension exceeds ATR_cap, top is clamped and bound_source flips."""
    # Synthetic wide-dispersion session: residuals above VWAP routinely 5+ pts.
    prices = [100.0, 105.0, 100.0, 108.0, 100.0, 110.0, 100.0, 107.0, 100.0, 106.0]
    trades = _trades(prices, quantities=[1] * len(prices))
    out = compute_sigma_zones_v2(
        trades,
        vah=101.0,
        val=99.0,
        vpoc=100.0,
        bin_size_ticks=4,
        atr_14=2.0,  # ATR_cap = 1.0 — well below the σ-driven 2σ extension
        cap_atr_fraction=0.5,
    )
    # 2σ_supply: σ_above is large → cap should clamp.
    assert out.sigma_2_supply.bound_source == "atr_cap"
    assert out.sigma_2_supply.top == pytest.approx(101.0 + 1.0)  # VAH + atr_cap
    # 1σ_supply: cap is atr_cap/2 = 0.5.
    assert out.sigma_1_supply.bound_source == "atr_cap"
    assert out.sigma_1_supply.top == pytest.approx(101.0 + 0.5)


def test_no_atr_falls_back_to_pure_sigma():
    """When ATR(14) is NaN (warmup), zones use pure σ-driven width with no cap."""
    prices = [100.0, 102.0, 100.0, 103.0, 100.0]
    trades = _trades(prices)
    out = compute_sigma_zones_v2(
        trades,
        vah=101.0,
        val=99.0,
        vpoc=100.0,
        bin_size_ticks=4,
        atr_14=math.nan,
    )
    # ATR_cap effectively infinity → both supply zones bound by σ.
    assert out.sigma_1_supply.bound_source == "sigma"
    assert out.sigma_2_supply.bound_source == "sigma"
    # And the recorded atr_cap audit field is 0 (sentinel for "no cap applied").
    assert out.atr_cap == 0.0


# ---------------------------------------------------------------------------
# Audit gap 4: VPOC band uses bin width
# ---------------------------------------------------------------------------


def test_vpoc_band_uses_bin_width():
    """VPOC band width = bin_size_ticks × tick_size, centered on VPOC."""
    trades = _trades([100.0, 100.5, 100.25, 100.75])
    out = compute_sigma_zones_v2(
        trades,
        vah=100.5,
        val=100.0,
        vpoc=100.25,
        bin_size_ticks=7,   # Friday's MNQ value, 7 × 0.25 = 1.75pt
        atr_14=5.0,
    )
    assert out.vpoc_band.width_pts == pytest.approx(1.75)
    assert out.vpoc_band.top == pytest.approx(100.25 + 0.875)
    assert out.vpoc_band.bottom == pytest.approx(100.25 - 0.875)
    assert out.vpoc_band.bound_source == "bin"


# ---------------------------------------------------------------------------
# Defensive cases
# ---------------------------------------------------------------------------


def test_empty_trades_returns_degenerate_zones():
    """No trades → all σ-driven zones degenerate to their VAH/VAL anchors;
    VPOC band still renders from inputs."""
    trades = _trades([])
    out = compute_sigma_zones_v2(
        trades,
        vah=101.0,
        val=99.0,
        vpoc=100.0,
        bin_size_ticks=4,
        atr_14=5.0,
    )
    assert out.sigma_above == 0.0
    assert out.sigma_below == 0.0
    assert out.sigma_1_supply.top == 101.0
    assert out.sigma_1_supply.width_pts == 0.0
    assert out.sigma_2_demand.bottom == 99.0
    # VPOC band always present.
    assert out.vpoc_band.width_pts == 4 * 0.25
    assert out.vpoc_band.top == 100.5
    assert out.vpoc_band.bottom == 99.5


def test_zone_dict_serializable():
    """SigmaZonesV2.to_dict() roundtrips through JSON cleanly."""
    import json
    trades = _trades([100.0, 100.5, 99.5, 100.25])
    out = compute_sigma_zones_v2(
        trades,
        vah=100.5,
        val=99.5,
        vpoc=100.0,
        bin_size_ticks=4,
        atr_14=5.0,
    )
    blob = json.dumps(out.to_dict())
    parsed = json.loads(blob)
    assert "sigma_1_supply" in parsed
    assert "vpoc_band" in parsed
    assert parsed["sigma_above"] == out.sigma_above


# ---------------------------------------------------------------------------
# Audit gap 5: multi-session bonus in confluence_score_v2
# ---------------------------------------------------------------------------


def test_confluence_score_components():
    """Each component contributes additively, clamped to [0,1]."""
    # Base volume only — no multi-session, no depth.
    s = confluence_score_v2(volume_pct=0.4, multi_session_count=None)
    assert s == pytest.approx(0.4)

    # Multi-session at threshold: full 0.5 bonus.
    s = confluence_score_v2(
        volume_pct=0.2, multi_session_count=3, structural_threshold=3
    )
    assert s == pytest.approx(0.7)

    # Multi-session above threshold doesn't keep growing.
    s = confluence_score_v2(
        volume_pct=0.2, multi_session_count=10, structural_threshold=3
    )
    assert s == pytest.approx(0.7)

    # With depth hook populated.
    s = confluence_score_v2(
        volume_pct=0.2,
        multi_session_count=3,
        depth_resting_fraction=0.6,
    )
    # 0.2 + 0.5 (multi) + 0.5*0.6 (depth) = 1.0, clamped.
    assert s == pytest.approx(1.0)

    # Pure depth-only is half-weighted.
    s = confluence_score_v2(
        volume_pct=0.0, multi_session_count=None, depth_resting_fraction=1.0
    )
    assert s == pytest.approx(0.5)


def test_confluence_score_clamps():
    """Volume %, multi-session count, and depth fraction all clamp to valid ranges."""
    # Negative volume → clamps to 0.
    s = confluence_score_v2(volume_pct=-0.5, multi_session_count=None)
    assert s == 0.0
    # Over-1 volume → clamps to 1.
    s = confluence_score_v2(volume_pct=2.0, multi_session_count=None)
    assert s == 1.0
    # Over-1 depth fraction → clamps.
    s = confluence_score_v2(
        volume_pct=0.0,
        multi_session_count=None,
        depth_resting_fraction=10.0,
    )
    assert s == 0.5  # 0 + 0 + 0.5*1.0
