"""Tests for ``rithmic_analytics.features.atr``."""

from __future__ import annotations

import math
import time

import numpy as np
import pandas as pd
import pytest

from rithmic_analytics.core.loader import load_obs01_trades
from rithmic_analytics.features.atr import (
    NS_1H,
    NS_1M,
    NS_5M,
    NS_15M,
    compute_atr_from_ticks,
)

from .conftest import REAL_OBS01


def _ticks_for_bars(
    bar_count: int,
    *,
    bar_size_ns: int = NS_5M,
    ohlc: tuple[float, float, float, float] = (95.0, 100.0, 90.0, 95.0),
) -> pd.DataFrame:
    """Build a tick DataFrame that produces exactly `bar_count` bars with the
    given (open, high, low, close) per bar when resampled by `bar_size_ns`.

    Each bar gets 4 ticks placed in time order: open, high, low, close. The
    first/max/min/last semantics of pandas groupby reconstruct the OHLC.
    """
    open_p, high_p, low_p, close_p = ohlc
    sub_step = bar_size_ns // 4
    event_ts: list[int] = []
    prices: list[float] = []
    for bar_idx in range(bar_count):
        base = bar_idx * bar_size_ns
        for offset, p in enumerate([open_p, high_p, low_p, close_p]):
            event_ts.append(base + offset * sub_step)
            prices.append(p)
    return pd.DataFrame({"event_ts_ns": event_ts, "price": prices})


# ---------------------------------------------------------------------------
# Synthetic OHLC — primary acceptance gate
# ---------------------------------------------------------------------------


def test_atr_synthetic_constant_range_yields_constant_value() -> None:
    # Every bar: H=100, L=90, C=95. No gaps (close[i-1] == 95 always).
    # TR[0] = H-L = 10
    # TR[i>0] = max(10, |100-95|=5, |90-95|=5) = 10
    # All TRs are 10 → Wilder ATR is exactly 10 at every step.
    trades = _ticks_for_bars(15, ohlc=(95.0, 100.0, 90.0, 95.0))
    atr = compute_atr_from_ticks(trades, period=14, bar_size_ns=NS_5M)
    assert atr == pytest.approx(10.0, abs=1e-4)


def test_atr_synthetic_against_hand_computed_wilder() -> None:
    # Variable-range bars; verify against the canonical Wilder recursion.
    # 15 bars with H-L = 10, 12, 8, 11, 9, ... and close near the middle so
    # gap contributions are dominated by H-L. Compute ATR by hand below.
    rng = np.random.RandomState(42)
    ranges = rng.uniform(8.0, 12.0, size=15)
    closes = np.full(15, 95.0)
    highs = closes + ranges / 2
    lows = closes - ranges / 2

    event_ts: list[int] = []
    prices: list[float] = []
    sub_step = NS_5M // 4
    for i in range(15):
        base = i * NS_5M
        for offset, p in enumerate([closes[i], highs[i], lows[i], closes[i]]):
            event_ts.append(base + offset * sub_step)
            prices.append(float(p))
    trades = pd.DataFrame({"event_ts_ns": event_ts, "price": prices})

    # Hand-compute Wilder ATR (period=14):
    # All closes equal → TR[i] = max(range[i], |H[i]-C[i-1]|, |L[i]-C[i-1]|)
    # With C=95 constant, |H-Cprev| = range/2, |L-Cprev| = range/2, so TR = range[i].
    tr = ranges.copy()
    seed = tr[:14].mean()
    expected = seed
    for i in range(14, 15):
        expected = (expected * 13 + tr[i]) / 14

    actual = compute_atr_from_ticks(trades, period=14, bar_size_ns=NS_5M)
    assert actual == pytest.approx(expected, abs=1e-4)


def test_atr_returns_nan_when_fewer_than_period_bars() -> None:
    # Only 10 bars but period=14 → NaN, no division-by-zero.
    trades = _ticks_for_bars(10)
    atr = compute_atr_from_ticks(trades, period=14, bar_size_ns=NS_5M)
    assert math.isnan(atr)


def test_atr_empty_input_returns_nan() -> None:
    trades = pd.DataFrame({"event_ts_ns": pd.Series(dtype="int64"), "price": []})
    atr = compute_atr_from_ticks(trades)
    assert math.isnan(atr)


def test_atr_exactly_period_bars_uses_seed() -> None:
    # With exactly `period` bars, ATR equals the seed (mean of first 14 TRs).
    # Constant 10-range → seed = 10 → ATR = 10.
    trades = _ticks_for_bars(14, ohlc=(95.0, 100.0, 90.0, 95.0))
    atr = compute_atr_from_ticks(trades, period=14, bar_size_ns=NS_5M)
    assert atr == pytest.approx(10.0, abs=1e-4)


# ---------------------------------------------------------------------------
# Bar-size kwarg
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bar_size_ns", [NS_1M, NS_5M, NS_15M, NS_1H])
def test_atr_supports_multiple_bar_sizes(bar_size_ns: int) -> None:
    # 20 bars of constant H/L → ATR = H-L regardless of bar size.
    trades = _ticks_for_bars(20, bar_size_ns=bar_size_ns, ohlc=(50.0, 55.0, 45.0, 50.0))
    atr = compute_atr_from_ticks(trades, period=14, bar_size_ns=bar_size_ns)
    assert atr == pytest.approx(10.0, abs=1e-4)


def test_atr_period_kwarg_respected() -> None:
    # Different period → different ATR for ramping TRs.
    rng = np.random.RandomState(0)
    ranges = rng.uniform(5.0, 15.0, 30)
    closes = np.full(30, 50.0)
    event_ts: list[int] = []
    prices: list[float] = []
    sub_step = NS_5M // 4
    for i in range(30):
        base = i * NS_5M
        for offset, p in enumerate(
            [closes[i], closes[i] + ranges[i] / 2, closes[i] - ranges[i] / 2, closes[i]]
        ):
            event_ts.append(base + offset * sub_step)
            prices.append(float(p))
    trades = pd.DataFrame({"event_ts_ns": event_ts, "price": prices})

    atr_14 = compute_atr_from_ticks(trades, period=14, bar_size_ns=NS_5M)
    atr_7 = compute_atr_from_ticks(trades, period=7, bar_size_ns=NS_5M)

    # Different periods → different values for non-constant TR series
    assert atr_14 != pytest.approx(atr_7, abs=1e-6)


# ---------------------------------------------------------------------------
# Real-fixture performance
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real fixture not present")
def test_atr_real_fixture_performance() -> None:
    # Acceptance: <500ms on the 104,358-row fixture at 5m bars.
    trades = load_obs01_trades(REAL_OBS01)
    t0 = time.perf_counter()
    atr = compute_atr_from_ticks(trades, period=14, bar_size_ns=NS_5M)
    elapsed = time.perf_counter() - t0

    assert elapsed < 0.5, f"ATR took {elapsed * 1000:.0f}ms, budget is 500ms"
    # 37-minute fixture has only ~7 5m bars → expect NaN (insufficient bars).
    # That's the right behavior; perf budget is the gate, not the value.
    assert math.isnan(atr) or atr > 0


@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real fixture not present")
def test_atr_real_fixture_1m_bars_returns_finite() -> None:
    # 37-min fixture at 1m bars → ~37 bars, > 14 → ATR should be finite.
    # Soft-plausible sanity check: MNQ ATR for an RTH 1-min in 2026 is in the
    # 5–50 point range, not 0.01 or 10000. Loose bounds; primary gate is finiteness.
    trades = load_obs01_trades(REAL_OBS01)
    atr = compute_atr_from_ticks(trades, period=14, bar_size_ns=NS_1M)
    assert not math.isnan(atr)
    assert 0.5 < atr < 200.0
