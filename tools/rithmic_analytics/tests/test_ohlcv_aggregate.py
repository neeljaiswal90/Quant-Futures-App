"""Tests for ``rithmic_analytics.features.ohlcv_aggregate``."""

from __future__ import annotations

import time

import numpy as np
import pandas as pd
import pytest

from rithmic_analytics.core.loader import load_obs01_trades
from rithmic_analytics.features.ohlcv_aggregate import aggregate_to_ohlcv

from .conftest import REAL_OBS01

_NS_PER_SEC = 1_000_000_000


def _trades_frame(
    *, event_ts_ns: list[int], prices: list[float], quantities: list[int] | None = None
) -> pd.DataFrame:
    n = len(event_ts_ns)
    return pd.DataFrame(
        {
            "event_ts_ns": np.array(event_ts_ns, dtype="int64"),
            "price": np.array(prices, dtype="float64"),
            "quantity": np.array(
                quantities if quantities is not None else [1] * n, dtype="int32"
            ),
            "signed_qty": np.array([1] * n, dtype="int32"),
        }
    )


# ---------------------------------------------------------------------------
# Basic semantics
# ---------------------------------------------------------------------------


def test_returns_empty_for_empty_input() -> None:
    df = _trades_frame(event_ts_ns=[], prices=[])
    assert aggregate_to_ohlcv(df, bar_size_sec=300) == []


def test_negative_bar_size_raises() -> None:
    df = _trades_frame(event_ts_ns=[0], prices=[27380.0])
    with pytest.raises(ValueError, match="positive"):
        aggregate_to_ohlcv(df, bar_size_sec=0)
    with pytest.raises(ValueError, match="positive"):
        aggregate_to_ohlcv(df, bar_size_sec=-300)


def test_single_bar_open_high_low_close_volume() -> None:
    # 4 trades within a 5-minute bin, prices [27380, 27382, 27379, 27381]
    df = _trades_frame(
        event_ts_ns=[i * _NS_PER_SEC for i in range(4)],
        prices=[27380.0, 27382.0, 27379.0, 27381.0],
        quantities=[1, 2, 3, 4],
    )

    bars = aggregate_to_ohlcv(df, bar_size_sec=300)

    assert len(bars) == 1
    bar = bars[0]
    assert bar["time"] == 0  # floor(0 / 300) * 300 = 0
    assert bar["open"] == 27380.0
    assert bar["high"] == 27382.0
    assert bar["low"] == 27379.0
    assert bar["close"] == 27381.0
    assert bar["volume"] == 1 + 2 + 3 + 4


def test_multiple_bars_sorted_ascending() -> None:
    df = _trades_frame(
        event_ts_ns=[
            0,  # bar at time 0 (5m bin)
            299 * _NS_PER_SEC,  # last second of bar 0
            300 * _NS_PER_SEC,  # bar at time 300
            500 * _NS_PER_SEC,  # still bar at time 300
            600 * _NS_PER_SEC,  # bar at time 600
        ],
        prices=[27380.0, 27381.0, 27382.0, 27383.0, 27384.0],
    )

    bars = aggregate_to_ohlcv(df, bar_size_sec=300)

    assert len(bars) == 3
    assert [b["time"] for b in bars] == [0, 300, 600]


def test_tv_inclusive_boundary_semantics() -> None:
    # Per docstring: bar at time T covers [T, T + bar_size_sec - 1] inclusive
    # in seconds. A trade at time T - 1 belongs to the PREVIOUS bar.
    df = _trades_frame(
        event_ts_ns=[
            299 * _NS_PER_SEC,  # last instant of bar 0 (covers [0, 299])
            300 * _NS_PER_SEC,  # first instant of bar 300
        ],
        prices=[27380.0, 27381.0],
    )

    bars = aggregate_to_ohlcv(df, bar_size_sec=300)

    assert len(bars) == 2
    assert bars[0]["time"] == 0
    assert bars[1]["time"] == 300


def test_empty_bars_excluded() -> None:
    # Trades in bar 0 and bar 600, NONE in bar 300 → only 2 bars emitted.
    df = _trades_frame(
        event_ts_ns=[100 * _NS_PER_SEC, 700 * _NS_PER_SEC],
        prices=[27380.0, 27381.0],
    )

    bars = aggregate_to_ohlcv(df, bar_size_sec=300)

    assert len(bars) == 2
    assert bars[0]["time"] == 0
    assert bars[1]["time"] == 600


def test_output_dict_types() -> None:
    df = _trades_frame(
        event_ts_ns=[0, _NS_PER_SEC, 2 * _NS_PER_SEC],
        prices=[27380.0, 27381.0, 27382.0],
        quantities=[1, 2, 3],
    )

    bars = aggregate_to_ohlcv(df, bar_size_sec=300)
    bar = bars[0]

    assert isinstance(bar["time"], int)
    assert isinstance(bar["open"], float)
    assert isinstance(bar["high"], float)
    assert isinstance(bar["low"], float)
    assert isinstance(bar["close"], float)
    assert isinstance(bar["volume"], int)


def test_volume_aggregates_quantities() -> None:
    df = _trades_frame(
        event_ts_ns=[0, _NS_PER_SEC, 2 * _NS_PER_SEC],
        prices=[27380.0, 27381.0, 27382.0],
        quantities=[5, 3, 7],
    )

    bars = aggregate_to_ohlcv(df, bar_size_sec=300)

    assert bars[0]["volume"] == 15


# ---------------------------------------------------------------------------
# Bar size variations
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "bar_size_sec, expected_bars",
    [
        (60, 5),  # 5 minutes of data with 60s bars → 5 bars
        (300, 1),  # 5 minutes of data with 300s bars → 1 bar
        (900, 1),  # 5 minutes of data with 900s bars → 1 bar
    ],
)
def test_bar_size_kwarg(bar_size_sec: int, expected_bars: int) -> None:
    # 5 minutes of data, one trade per minute
    df = _trades_frame(
        event_ts_ns=[i * 60 * _NS_PER_SEC for i in range(5)],
        prices=[27380.0 + i for i in range(5)],
    )

    bars = aggregate_to_ohlcv(df, bar_size_sec=bar_size_sec)

    assert len(bars) == expected_bars


# ---------------------------------------------------------------------------
# Real fixture
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real fixture not present")
def test_aggregate_real_fixture_5m_bars() -> None:
    trades = load_obs01_trades(REAL_OBS01)

    t0 = time.perf_counter()
    bars = aggregate_to_ohlcv(trades, bar_size_sec=300)
    elapsed = time.perf_counter() - t0

    # 37-minute fixture at 5-minute bars → ~7-8 bars
    assert 5 <= len(bars) <= 10
    assert elapsed < 2.0, f"aggregation took {elapsed:.2f}s"

    # Each bar respects O/H/L/C invariants
    for bar in bars:
        assert bar["low"] <= bar["open"] <= bar["high"]
        assert bar["low"] <= bar["close"] <= bar["high"]
        assert bar["volume"] > 0


@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real fixture not present")
def test_aggregate_real_fixture_total_volume_preserved() -> None:
    trades = load_obs01_trades(REAL_OBS01)

    bars = aggregate_to_ohlcv(trades, bar_size_sec=60)
    total_bar_volume = sum(b["volume"] for b in bars)

    # Sum of bar volumes == sum of trade quantities (tick-level total).
    expected = int(trades["quantity"].sum())
    assert total_bar_volume == expected
