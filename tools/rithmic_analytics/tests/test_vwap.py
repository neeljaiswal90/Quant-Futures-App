"""Tests for ``rithmic_analytics.features.vwap`` (RA-031)."""

from __future__ import annotations

import math
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import pytest

from rithmic_analytics.features.vwap import compute_vwap

_ET = ZoneInfo("America/New_York")
_NS_PER_SEC = 10**9


def _ts_ns(year: int, month: int, day: int, hour: int, minute: int = 0,
          sec: int = 0) -> int:
    """ET wall-clock → UTC ns."""
    dt = datetime(year, month, day, hour, minute, sec, tzinfo=_ET)
    return int(dt.timestamp() * _NS_PER_SEC)


def _make_trades(rows: list[tuple[int, float, int]]) -> pd.DataFrame:
    """``[(ts_ns, price, quantity), ...]`` → trades DataFrame."""
    if not rows:
        return pd.DataFrame({
            "event_ts_ns": pd.Series(dtype="int64"),
            "price": pd.Series(dtype="float64"),
            "quantity": pd.Series(dtype="int32"),
        })
    df = pd.DataFrame(rows, columns=["event_ts_ns", "price", "quantity"])
    df["event_ts_ns"] = df["event_ts_ns"].astype("int64")
    df["price"] = df["price"].astype("float64")
    df["quantity"] = df["quantity"].astype("int32")
    return df.sort_values("event_ts_ns").reset_index(drop=True)


# ---------------------------------------------------------------------------
# Closing-VWAP correctness
# ---------------------------------------------------------------------------


def test_end_of_session_vwap_matches_simple_formula() -> None:
    """Final VWAP = Σ(p·q) / Σ(q). Tested at full float precision."""
    # 5 trades during RTH 2026-05-19
    trades = _make_trades([
        (_ts_ns(2026, 5, 19, 10, 0), 100.0, 10),  # 1000
        (_ts_ns(2026, 5, 19, 10, 5), 101.0, 20),  # 2020
        (_ts_ns(2026, 5, 19, 10, 10), 99.0, 5),   # 495
        (_ts_ns(2026, 5, 19, 10, 15), 102.0, 15),  # 1530
        (_ts_ns(2026, 5, 19, 10, 20), 100.5, 50),  # 5025
    ])
    # Σpq = 10070; Σq = 100; VWAP = 100.70
    vwap = compute_vwap(trades, anchor="rth")

    assert vwap.final_vwap() == pytest.approx(100.70, abs=1e-9)


def test_single_trade_vwap_equals_that_price() -> None:
    """N=1: VWAP = price, σ = 0."""
    trades = _make_trades([(_ts_ns(2026, 5, 19, 10, 0), 27381.25, 5)])
    vwap = compute_vwap(trades, anchor="rth")

    assert vwap.final_vwap() == 27381.25
    assert vwap.final_sigma() == pytest.approx(0.0, abs=1e-9)


def test_constant_price_sigma_is_zero() -> None:
    """All trades at the same price → σ = 0 regardless of qty distribution."""
    trades = _make_trades([
        (_ts_ns(2026, 5, 19, 10, i), 100.0, q)
        for i, q in enumerate([5, 10, 3, 7, 20])
    ])
    vwap = compute_vwap(trades, anchor="rth")

    assert vwap.final_vwap() == 100.0
    assert vwap.final_sigma() == pytest.approx(0.0, abs=1e-9)


def test_sigma_bands_symmetric_around_vwap() -> None:
    """vwap_p1sd - vwap == vwap - vwap_m1sd (and 2× for ±2σ)."""
    trades = _make_trades([
        (_ts_ns(2026, 5, 19, 10, i), 100.0 + (i % 3), 10)
        for i in range(30)
    ])
    vwap = compute_vwap(trades, anchor="rth")

    last = -1
    sigma_pos = vwap.vwap_p1sd[last] - vwap.vwap[last]
    sigma_neg = vwap.vwap[last] - vwap.vwap_m1sd[last]
    assert sigma_pos == pytest.approx(sigma_neg, abs=1e-9)
    assert (vwap.vwap_p2sd[last] - vwap.vwap[last]) == pytest.approx(2 * sigma_pos)


def test_sigma_expands_with_dispersion() -> None:
    """High-vol session has wider σ than low-vol session."""
    low_vol = _make_trades([
        (_ts_ns(2026, 5, 19, 10, i), 100.0 + (i % 2) * 0.1, 5)  # ±0.1pt
        for i in range(50)
    ])
    high_vol = _make_trades([
        (_ts_ns(2026, 5, 19, 10, i), 100.0 + (i % 2) * 20.0, 5)  # ±20pt
        for i in range(50)
    ])

    sig_low = compute_vwap(low_vol, anchor="rth").final_sigma()
    sig_high = compute_vwap(high_vol, anchor="rth").final_sigma()

    assert sig_high > 100 * sig_low


# ---------------------------------------------------------------------------
# Anchor independence
# ---------------------------------------------------------------------------


def test_rth_vwap_excludes_pre_open_globex_trades() -> None:
    """A Globex print at 09:25 ET shouldn't be in the 09:30 RTH-anchored VWAP."""
    # Globex print at 09:25, RTH prints from 09:30 onward
    trades = _make_trades([
        (_ts_ns(2026, 5, 19, 9, 25), 50.0, 100),  # Globex — should be excluded
        (_ts_ns(2026, 5, 19, 9, 30), 100.0, 10),
        (_ts_ns(2026, 5, 19, 9, 35), 100.0, 10),
    ])
    vwap = compute_vwap(trades, anchor="rth")

    # If Globex bled in: VWAP would be (50·100 + 100·10 + 100·10) / 120 = 58.3
    # If correctly excluded: VWAP = 100.0
    assert vwap.final_vwap() == pytest.approx(100.0, abs=1e-9)
    assert len(vwap.event_ts_ns) == 2  # only RTH trades counted


def test_globex_vwap_anchors_at_17_et_prior_day() -> None:
    """A trade at 18:00 ET 5/18 (Globex) anchors at 17:00 ET 5/18, not 5/19."""
    # Globex opens 17:00 ET 5/18 → 17:00 5/18 is the anchor for 18:00 prints
    trade_ts = _ts_ns(2026, 5, 18, 18, 0)
    expected_anchor = _ts_ns(2026, 5, 18, 17, 0)

    trades = _make_trades([(trade_ts, 100.0, 10)])
    vwap = compute_vwap(trades, anchor="globex")

    assert vwap.anchor_ts_ns == expected_anchor


def test_globex_vwap_pre_open_anchors_at_prior_day() -> None:
    """A 13:00 ET print on 5/19 (before that night's Globex) anchors at 5/18 17:00."""
    trade_ts = _ts_ns(2026, 5, 19, 13, 0)
    expected_anchor = _ts_ns(2026, 5, 18, 17, 0)

    trades = _make_trades([(trade_ts, 100.0, 10)])
    vwap = compute_vwap(trades, anchor="globex")

    assert vwap.anchor_ts_ns == expected_anchor


def test_weekly_vwap_anchors_at_sunday_17_et() -> None:
    """Weekly VWAP anchors at the most recent Sunday 17:00 ET."""
    # 2026-05-19 is a Tuesday. Most recent Sunday = 2026-05-17.
    trade_ts = _ts_ns(2026, 5, 19, 10, 0)
    expected_anchor = _ts_ns(2026, 5, 17, 17, 0)

    trades = _make_trades([(trade_ts, 100.0, 10)])
    vwap = compute_vwap(trades, anchor="weekly")

    assert vwap.anchor_ts_ns == expected_anchor


def test_rth_anchor_handles_weekend_lookback() -> None:
    """A pre-open trade on Monday should anchor at Friday's RTH open, not Sunday."""
    # 2026-05-18 is Monday. Pre-open Monday at 08:00 ET → Friday 5/15 09:30 ET
    trade_ts = _ts_ns(2026, 5, 18, 8, 0)
    expected_anchor = _ts_ns(2026, 5, 15, 9, 30)

    trades = _make_trades([(trade_ts, 100.0, 10)])
    vwap = compute_vwap(trades, anchor="rth")

    assert vwap.anchor_ts_ns == expected_anchor


def test_unknown_anchor_raises_value_error() -> None:
    trades = _make_trades([(_ts_ns(2026, 5, 19, 10, 0), 100.0, 10)])
    with pytest.raises(ValueError, match="anchor"):
        compute_vwap(trades, anchor="asia")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Numerical stability (the load-bearing test for RA-031)
# ---------------------------------------------------------------------------


def test_numerical_stability_100k_bars_high_magnitude() -> None:
    """100K bars with MNQ-magnitude prices — running VWAP must not drift >0.1pt
    from the analytical-truth VWAP."""
    rng = np.random.default_rng(42)
    n = 100_000
    base = _ts_ns(2026, 5, 19, 10, 0)
    ts = base + np.arange(n, dtype="int64") * 1_000_000  # 1ms spacing
    # MNQ prices around 27000 with realistic variance
    prices = 27000.0 + rng.normal(0, 50, size=n)
    quantities = rng.integers(1, 10, size=n).astype("int32")

    trades = pd.DataFrame({
        "event_ts_ns": ts,
        "price": prices,
        "quantity": quantities,
    })
    vwap = compute_vwap(trades, anchor="rth")

    # Analytical truth: weighted mean
    truth = float((prices * quantities).sum() / quantities.sum())

    drift = abs(vwap.final_vwap() - truth)
    assert drift < 0.1, f"VWAP drifted {drift:.6f} pts from analytical truth"


def test_numerical_stability_extreme_price_magnitude() -> None:
    """Million-dollar synthetic prices — confirms no catastrophic cancellation."""
    rng = np.random.default_rng(0)
    n = 50_000
    base = _ts_ns(2026, 5, 19, 10, 0)
    ts = base + np.arange(n, dtype="int64") * 1_000_000
    prices = 1_000_000.0 + rng.normal(0, 100, size=n)
    quantities = rng.integers(1, 5, size=n).astype("int32")

    trades = pd.DataFrame({"event_ts_ns": ts, "price": prices, "quantity": quantities})
    vwap = compute_vwap(trades, anchor="rth")

    truth = float((prices * quantities).sum() / quantities.sum())
    drift = abs(vwap.final_vwap() - truth)
    # Looser tolerance at this magnitude but still tight (relative error <1e-6)
    assert drift < 1.0, f"VWAP drifted {drift:.6f} from analytical truth at $1M magnitude"


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


def test_empty_trades_returns_empty_series() -> None:
    empty = _make_trades([])
    vwap = compute_vwap(empty, anchor="rth")

    assert len(vwap.event_ts_ns) == 0
    assert math.isnan(vwap.final_vwap())
    assert math.isnan(vwap.final_sigma())


def test_all_trades_before_anchor_returns_empty_window() -> None:
    """If anchor resolves AFTER all trades (shouldn't happen but defensive),
    return empty event_ts_ns array.

    Construct this by passing a trade at 09:00 ET Monday → RTH anchor is
    Friday 09:30 ET, which is BEFORE the trade. So all trades are in-window.
    To get all trades BEFORE the anchor we'd need to construct a case
    where _resolve_anchor_ts returns something later — not possible with the
    current logic, since the anchor is always derived from first_trade_ts.

    So this test verifies the contract: anchor_ts <= first_trade_ts always.
    """
    trades = _make_trades([
        (_ts_ns(2026, 5, 19, 10, 0), 100.0, 10),
        (_ts_ns(2026, 5, 19, 10, 5), 101.0, 10),
    ])
    vwap = compute_vwap(trades, anchor="rth")
    assert vwap.anchor_ts_ns <= int(trades["event_ts_ns"].iloc[0])


def test_running_vwap_is_monotonic_in_information() -> None:
    """At each step, VWAP is the weighted mean of all PRIOR trades' p·q."""
    trades = _make_trades([
        (_ts_ns(2026, 5, 19, 10, 0), 100.0, 10),
        (_ts_ns(2026, 5, 19, 10, 1), 200.0, 10),
    ])
    vwap = compute_vwap(trades, anchor="rth")

    # After trade 1: VWAP = 100
    # After trade 2: VWAP = (100·10 + 200·10) / 20 = 150
    assert vwap.vwap[0] == pytest.approx(100.0)
    assert vwap.vwap[1] == pytest.approx(150.0)


def test_final_bands_dict_shape() -> None:
    trades = _make_trades([
        (_ts_ns(2026, 5, 19, 10, i), 100.0 + i, 10)
        for i in range(20)
    ])
    bands = compute_vwap(trades, anchor="rth").final_bands()

    assert set(bands.keys()) == {"vwap", "p1", "m1", "p2", "m2"}
    assert bands["p2"] - bands["vwap"] == pytest.approx(2 * (bands["p1"] - bands["vwap"]))
    assert bands["vwap"] - bands["m2"] == pytest.approx(2 * (bands["vwap"] - bands["m1"]))


# ---------------------------------------------------------------------------
# Dataclass invariants
# ---------------------------------------------------------------------------


def test_vwap_series_is_frozen() -> None:
    import dataclasses
    trades = _make_trades([(_ts_ns(2026, 5, 19, 10, 0), 100.0, 10)])
    s = compute_vwap(trades, anchor="rth")
    with pytest.raises(dataclasses.FrozenInstanceError):
        s.anchor = "globex"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Integration with grade_zone (RA-031's load-bearing assertion)
# ---------------------------------------------------------------------------


def test_grade_zone_hvn_plus_vwap_band_plus_structural_elevates_to_HIGH() -> None:
    """The whole reason RA-031 exists: HVN + VWAP band + structural → HIGH.

    Pre-RA-031: ``grade_zone`` had no way for a VWAP-band source to match
    ``has_band`` (the regex was ``avwap``/``_band``-suffix only). After
    RA-031's substring extension, ``vwap_rth_band_p1sd`` matches.
    """
    from rithmic_analytics.core.schema import grade_zone

    conviction = grade_zone([
        "hvn_5m",                  # HVN component
        "vwap_rth_band_p1sd",      # VWAP band — must match has_band
        "ema50",                   # structural component
    ])
    assert conviction == "HIGH"


def test_grade_zone_hvn_plus_avwap_legacy_still_HIGH() -> None:
    """Legacy AVWAP-band source-tag still elevates to HIGH (backward-compat)."""
    from rithmic_analytics.core.schema import grade_zone

    assert grade_zone(["hvn_5m", "weekly_avwap_band", "ema50"]) == "HIGH"


def test_grade_zone_vwap_centerline_alone_is_LOW() -> None:
    """A VWAP centerline alone is just a midpoint reference, not a band — LOW.

    Documents the intentional asymmetry: ``vwap_rth`` (the line) ≠ band;
    only ``_band_`` sources match has_band. Otherwise every VWAP-tagged
    zone would auto-grade up.
    """
    from rithmic_analytics.core.schema import grade_zone

    assert grade_zone(["vwap_rth"]) == "LOW"


def test_grade_zone_vwap_band_alone_is_MED() -> None:
    """A σ-band source alone (no HVN, no structural) grades MED."""
    from rithmic_analytics.core.schema import grade_zone

    assert grade_zone(["vwap_rth_band_p1sd"]) == "MED"


def test_vwap_series_arrays_aligned() -> None:
    """All five band arrays + event_ts_ns must be the same length."""
    trades = _make_trades([
        (_ts_ns(2026, 5, 19, 10, i), 100.0 + i, 10)
        for i in range(15)
    ])
    s = compute_vwap(trades, anchor="rth")
    n = len(s.event_ts_ns)
    assert len(s.vwap) == n
    assert len(s.vwap_p1sd) == n
    assert len(s.vwap_m1sd) == n
    assert len(s.vwap_p2sd) == n
    assert len(s.vwap_m2sd) == n
