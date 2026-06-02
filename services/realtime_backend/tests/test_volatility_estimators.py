"""Tests for the RA-112e step 10 volatility estimators (Move 3 foundation).

Test list follows the user's revised spec — does NOT include the original
"YZ ≥ std on synthetic trends" invariant, which is not generally guaranteed.
"""

from __future__ import annotations

import math

import pytest

from realtime_backend.volatility_estimators import (
    OhlcBar,
    bipower_variation,
    overlapping_realized_ranges,
    percentile,
    yang_zhang_variance,
)


# ---------------------------------------------------------------------------
# Yang-Zhang
# ---------------------------------------------------------------------------


def _bar(o: float, h: float, l: float, c: float) -> OhlcBar:
    return OhlcBar(open=o, high=h, low=l, close=c)


def test_constant_price_series_yields_zero_yz():
    """If every bar is flat (O=H=L=C and unchanged across bars), variance
    must be exactly zero in log-return space."""
    bars = [_bar(30500.0, 30500.0, 30500.0, 30500.0) for _ in range(12)]
    r = yang_zhang_variance(bars, window_minutes=60)
    assert r.variance_log == 0.0
    assert r.sigma_log == 0.0
    assert r.sigma_rs_sq == 0.0
    assert r.sigma_open_close_sq == 0.0
    assert r.window_minutes == 60
    assert r.sigma_points(30500.0) == 0.0
    assert r.ladder_span_points(30500.0) == 0.0


def test_monotonic_intrabar_trend_does_not_collapse_to_close_to_close():
    """Critical motivation for YZ in this build: when price moves
    directionally inside each bar (high-low expansion) but close-to-close
    looks tame, close-to-close std understates volatility. YZ must include
    the high/low component so it stays above the OC-only number."""
    # Each bar opens at C[i-1], rises strongly intrabar, but closes near
    # the open. Close-to-close moves are tiny; intrabar ranges are large.
    bars = []
    base = 30500.0
    for i in range(12):
        o = base
        h = base + 8.0          # 8pt intrabar high
        l = base - 0.5
        c = base + 0.1          # close-to-close drifts 0.1 each bar
        bars.append(_bar(o, h, l, c))
        base = c
    r = yang_zhang_variance(bars, window_minutes=60)
    # OC component alone is tiny (drift of 0.1pt / 30500 ≈ 3.3e-6 per bar):
    assert r.sigma_open_close_sq < 1e-9
    # The point of this test: RS captures intrabar high/low expansion that
    # OC misses entirely. RS must dominate OC by *several orders of magnitude*
    # for the YZ result to materially differ from a close-to-close estimator.
    assert r.sigma_rs_sq > 100.0 * r.sigma_open_close_sq
    # Net YZ inherits the RS magnitude — does NOT collapse to OC-only.
    assert r.variance_log > 0.0
    assert r.variance_log > 10.0 * r.sigma_open_close_sq
    # Sanity: sigma_points() (unit-safe API, not manual multiply) is positive.
    assert r.sigma_points(30500.0) > 0.0
    # ladder_span_points at default sigma_multiplier=3.0 is 3x sigma_points.
    assert r.ladder_span_points(30500.0) == pytest.approx(3.0 * r.sigma_points(30500.0))


def test_yz_drops_bad_data_silently():
    """Negative / zero prices must not blow up the log math."""
    bars = [
        _bar(30500.0, 30500.0, 30500.0, 30500.0),
        _bar(0.0, 0.0, 0.0, 0.0),  # corrupt
        _bar(30500.0, 30501.0, 30499.0, 30500.5),
    ]
    r = yang_zhang_variance(bars, window_minutes=60)
    # Did not crash; at least one valid bar pair contributed.
    assert math.isfinite(r.variance_log)


def test_yz_unit_safe_conversion_via_methods():
    """The conversion from log-return σ to MNQ points goes through the
    unit-safe methods on YangZhangEstimate — call sites should never multiply
    by anchor manually. This test pins the API contract."""
    bars = []
    base = 30000.0
    # 0.5pt close-to-close drift over 12 bars, no intrabar expansion.
    for i in range(12):
        bars.append(_bar(base, base, base, base + 0.5))
        base += 0.5
    r = yang_zhang_variance(bars, window_minutes=60)
    # Estimator output is in log-return space (private field).
    assert r.sigma_log > 0.0
    # Method-based conversion to MNQ points:
    yz_sigma_points_a = r.sigma_points(30500.0)
    yz_sigma_points_b = r.sigma_points(30600.0)
    # Same log-σ → different point σ at different anchors. That's the
    # behavior we WANT to preserve.
    assert yz_sigma_points_b > yz_sigma_points_a
    assert yz_sigma_points_a > 0.0
    # ladder_span_points at default 3.0 = 3 * sigma_points
    assert r.ladder_span_points(30500.0) == pytest.approx(3.0 * yz_sigma_points_a)
    # Custom multiplier
    assert r.ladder_span_points(30500.0, sigma_multiplier=2.0) == pytest.approx(
        2.0 * yz_sigma_points_a
    )
    # Boundary: nonsense anchor should not crash, yields 0.
    assert r.sigma_points(0.0) == 0.0
    assert r.sigma_points(-100.0) == 0.0
    assert r.sigma_points(float("nan")) == 0.0


def test_yz_excludes_overnight_by_default():
    """Default is intraday-only. close-to-open gaps between session-internal
    bars are zero by definition, but a real overnight gap would skew an
    intraday window if we accidentally counted it. Verify the toggle works."""
    # Continuous tape: each bar's open equals the previous bar's close.
    # With this construction, include_overnight should produce zero overnight.
    bars = [
        _bar(30500.0, 30501.0, 30499.0, 30500.5),
        _bar(30500.5, 30501.5, 30499.5, 30501.0),
        _bar(30501.0, 30502.0, 30500.0, 30501.5),
    ]
    r_off = yang_zhang_variance(bars, window_minutes=60, include_overnight=False)
    r_on = yang_zhang_variance(bars, window_minutes=60, include_overnight=True)
    assert r_off.has_overnight is False
    assert r_on.has_overnight is True
    # Both components have to be present in the result struct regardless.
    assert r_off.sigma_overnight_sq == 0.0
    assert r_on.sigma_overnight_sq == 0.0  # no actual gap → zero contribution

    # Now insert a real overnight gap and verify it shows up only when toggled on.
    bars_with_gap = [
        _bar(30500.0, 30501.0, 30499.0, 30500.5),
        _bar(30510.0, 30511.0, 30509.0, 30510.5),  # 9.5pt gap from prev close
        _bar(30510.5, 30511.5, 30509.5, 30511.0),
    ]
    r_off2 = yang_zhang_variance(bars_with_gap, window_minutes=60, include_overnight=False)
    r_on2 = yang_zhang_variance(bars_with_gap, window_minutes=60, include_overnight=True)
    assert r_off2.sigma_overnight_sq == 0.0
    assert r_on2.sigma_overnight_sq > 0.0
    # Variance reflects the gap only when overnight is included:
    assert r_on2.variance_log > r_off2.variance_log


# ---------------------------------------------------------------------------
# Bipower variation
# ---------------------------------------------------------------------------


def test_bipower_zero_on_constant_returns():
    assert bipower_variation([0.0] * 10) == 0.0


def test_bipower_finite_and_positive_on_random_returns():
    returns = [0.001, -0.002, 0.0015, -0.001, 0.003, -0.0025, 0.001]
    bv = bipower_variation(returns)
    assert bv > 0.0
    assert math.isfinite(bv)


def test_bipower_robust_to_single_jump():
    """The defining property — a single large jump contaminates one factor
    in each adjacent product but not both. BV stays close to the no-jump
    baseline; close-to-close variance would blow up."""
    base_returns = [0.0005] * 50  # tiny steady moves
    cc_var_base = sum(r * r for r in base_returns) / len(base_returns)

    with_jump = list(base_returns)
    with_jump[25] = 0.05  # one large jump (5%)
    cc_var_jump = sum(r * r for r in with_jump) / len(with_jump)

    bv_base = bipower_variation(base_returns)
    bv_jump = bipower_variation(with_jump)

    cc_ratio = cc_var_jump / max(cc_var_base, 1e-12)
    bv_ratio = bv_jump / max(bv_base, 1e-12)

    # Close-to-close variance blows up by orders of magnitude.
    assert cc_ratio > 20.0
    # Bipower is materially more robust — at least 10× less inflated than CC.
    # This is the *relative* robustness property, which is what BV is for.
    # (Absolute threshold would depend on jump size and series length.)
    assert bv_ratio < cc_ratio / 10.0


def test_bipower_short_input_returns_zero():
    assert bipower_variation([]) == 0.0
    assert bipower_variation([0.001]) == 0.0


# ---------------------------------------------------------------------------
# Overlapping realized ranges (60m, step 1)
# ---------------------------------------------------------------------------


SEC_NS = 1_000_000_000
MIN_NS = 60 * SEC_NS


def test_realized_ranges_constant_price_yields_zero_range():
    prices = [(i * MIN_NS, 30500.0) for i in range(120)]  # 2h of flat
    windows = overlapping_realized_ranges(
        prices, horizon_minutes=60, step_minutes=1
    )
    assert len(windows) > 0
    for w in windows:
        assert w.range_points == 0.0
        assert w.horizon_minutes == 60


def test_realized_ranges_synthetic_session_recovers_known_60m_max():
    """Build a 2-hour synthetic series with a known 60-min high-low span.
    The maximum range across all 60-min windows must equal the constructed
    span exactly."""
    prices: list[tuple[int, float]] = []
    # First 30 min: 30500 flat
    for i in range(30):
        prices.append((i * MIN_NS, 30500.0))
    # Next 30 min: spike to 30620, back to 30500 (range 120pt inside a 30min window)
    for i in range(30, 45):
        prices.append((i * MIN_NS, 30620.0))
    for i in range(45, 60):
        prices.append((i * MIN_NS, 30500.0))
    # Next 60 min: flat at 30500
    for i in range(60, 120):
        prices.append((i * MIN_NS, 30500.0))
    windows = overlapping_realized_ranges(
        prices, horizon_minutes=60, step_minutes=1
    )
    max_range = max(w.range_points for w in windows)
    assert max_range == pytest.approx(120.0)


def test_realized_ranges_skips_windows_that_exceed_input_span():
    prices = [(i * MIN_NS, 30500.0 + i * 0.1) for i in range(70)]  # 70 minutes
    windows = overlapping_realized_ranges(
        prices, horizon_minutes=60, step_minutes=1
    )
    # Span is 70 min; step 1 min; horizon 60 min. Valid windows: starts at
    # min 0..10 inclusive (10 starts → 11 windows). Edge windows that would
    # extend past minute 70 must be dropped.
    assert len(windows) <= 11
    for w in windows:
        assert w.start_ts_ns + 60 * MIN_NS <= prices[-1][0]


def test_realized_ranges_handles_out_of_order_input():
    """Defensive: caller may pass ticks out-of-order on file reload."""
    base = [(i * MIN_NS, 30500.0 + i * 0.05) for i in range(120)]
    import random
    rng = random.Random(42)
    shuffled = list(base)
    rng.shuffle(shuffled)
    windows = overlapping_realized_ranges(
        shuffled, horizon_minutes=60, step_minutes=1
    )
    expected = overlapping_realized_ranges(
        base, horizon_minutes=60, step_minutes=1
    )
    assert [w.range_points for w in windows] == [w.range_points for w in expected]


def test_realized_ranges_empty_input():
    assert overlapping_realized_ranges([], horizon_minutes=60) == []


def test_realized_ranges_carries_low_high_n_trades_for_diagnostics():
    """top-window diagnostics need low/high/n_trades on each window so the
    operator can audit whether a high p99 is from a real move or a bad
    tick. Pin the new fields here."""
    # 90 min of ticks; one obvious 60-min window has a 50pt spike.
    prices: list[tuple[int, float]] = []
    for i in range(20):
        prices.append((i * MIN_NS, 30500.0))
    prices.append((25 * MIN_NS, 30550.0))  # spike
    for i in range(30, 90):
        prices.append((i * MIN_NS, 30500.0))
    windows = overlapping_realized_ranges(
        prices, horizon_minutes=60, step_minutes=1
    )
    # All windows have low/high/n_trades populated
    for w in windows:
        assert w.high_price >= w.low_price
        assert w.high_price - w.low_price == pytest.approx(w.range_points)
        assert w.n_trades >= 1
    # The window containing the spike has high=30550, low=30500, range=50.
    big = max(windows, key=lambda w: w.range_points)
    assert big.high_price == 30550.0
    assert big.low_price == 30500.0
    assert big.range_points == 50.0


# ---------------------------------------------------------------------------
# Percentile
# ---------------------------------------------------------------------------


def test_percentile_p99_picks_near_max_of_distribution():
    # 100 evenly-spaced values from 1..100
    values = [float(i) for i in range(1, 101)]
    assert percentile(values, 99.0) == pytest.approx(99.01, abs=0.5)
    assert percentile(values, 50.0) == pytest.approx(50.5)


def test_percentile_boundaries():
    values = [1.0, 2.0, 3.0]
    assert percentile(values, 0.0) == 1.0
    assert percentile(values, 100.0) == 3.0
    assert percentile([], 50.0) == 0.0


def test_percentile_invalid_q_raises():
    with pytest.raises(ValueError):
        percentile([1.0, 2.0], -1.0)
    with pytest.raises(ValueError):
        percentile([1.0, 2.0], 101.0)
