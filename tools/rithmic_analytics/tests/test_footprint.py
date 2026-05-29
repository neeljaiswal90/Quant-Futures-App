"""Tests for ``rithmic_analytics.features.footprint``."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from rithmic_analytics.core.contracts import MNQ
from rithmic_analytics.features.footprint import Footprint, compute_footprint

_NS_PER_SEC = 1_000_000_000


def _trades_frame(
    *,
    event_ts_ns: list[int],
    prices: list[float],
    signed_qty: list[int],
) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "event_ts_ns": np.array(event_ts_ns, dtype="int64"),
            "price": np.array(prices, dtype="float64"),
            "quantity": np.array([abs(q) for q in signed_qty], dtype="int32"),
            "signed_qty": np.array(signed_qty, dtype="int32"),
        }
    )


# ---------------------------------------------------------------------------
# Basic shape
# ---------------------------------------------------------------------------


def test_footprint_pivot_shape() -> None:
    # 4 trades in one 30s bin at 2 distinct price levels.
    df = _trades_frame(
        event_ts_ns=[0, _NS_PER_SEC, 2 * _NS_PER_SEC, 3 * _NS_PER_SEC],
        prices=[27380.00, 27380.00, 27380.25, 27380.25],
        signed_qty=[2, -1, 3, -2],
    )

    fp = compute_footprint(df, MNQ)

    # 1 time bin × 2 price levels
    assert fp.deltas.shape == (1, 2)
    assert 27380.00 in fp.deltas.columns
    assert 27380.25 in fp.deltas.columns


def test_footprint_cell_net_delta_correct() -> None:
    df = _trades_frame(
        event_ts_ns=[0, _NS_PER_SEC, 2 * _NS_PER_SEC, 3 * _NS_PER_SEC],
        prices=[27380.00, 27380.00, 27380.25, 27380.25],
        signed_qty=[2, -1, 3, -2],
    )

    fp = compute_footprint(df, MNQ)

    # At 27380.00: 2 + (-1) = 1; at 27380.25: 3 + (-2) = 1
    row = fp.deltas.iloc[0]
    assert row[27380.00] == 1.0
    assert row[27380.25] == 1.0


def test_footprint_row_delta_matches_cvd_sum() -> None:
    # Sum of cells in a time bin equals the sum of signed_qty for that bin.
    df = _trades_frame(
        event_ts_ns=[0, _NS_PER_SEC, 2 * _NS_PER_SEC, 3 * _NS_PER_SEC],
        prices=[27380.00, 27380.00, 27380.25, 27380.25],
        signed_qty=[2, -1, 3, -2],
    )

    fp = compute_footprint(df, MNQ)

    row_sum = fp.deltas.sum(axis=1).iloc[0]
    expected = df["signed_qty"].sum()
    assert row_sum == expected


# ---------------------------------------------------------------------------
# NaN for empty cells
# ---------------------------------------------------------------------------


def test_footprint_empty_cells_are_nan_not_zero() -> None:
    # Two time bins, each with trades at different prices → opposite cells are NaN.
    df = _trades_frame(
        event_ts_ns=[
            10 * _NS_PER_SEC,  # bin 0
            10 * _NS_PER_SEC,  # bin 0
            40 * _NS_PER_SEC,  # bin 1
            40 * _NS_PER_SEC,  # bin 1
        ],
        prices=[27380.00, 27380.00, 27381.00, 27381.00],
        signed_qty=[1, -1, 2, -1],
    )

    fp = compute_footprint(df, MNQ, time_bin_sec=30)

    # bin 0 at 27381.00 is NaN; bin 1 at 27380.00 is NaN
    assert pd.isna(fp.deltas.iloc[0][27381.00])
    assert pd.isna(fp.deltas.iloc[1][27380.00])
    assert fp.deltas.iloc[0][27380.00] == 0.0  # 1 + (-1)
    assert fp.deltas.iloc[1][27381.00] == 1.0  # 2 + (-1)


# ---------------------------------------------------------------------------
# Bin sizes
# ---------------------------------------------------------------------------


def test_footprint_30s_bin_default() -> None:
    df = _trades_frame(
        event_ts_ns=[0, 25 * _NS_PER_SEC, 35 * _NS_PER_SEC],
        prices=[27380.0, 27380.0, 27380.0],
        signed_qty=[1, 1, 1],
    )

    fp = compute_footprint(df, MNQ)  # default 30s

    # First two trades in bin [0, 30); third in bin [30, 60)
    assert fp.deltas.shape[0] == 2


def test_footprint_60s_bin() -> None:
    df = _trades_frame(
        event_ts_ns=[0, 25 * _NS_PER_SEC, 35 * _NS_PER_SEC],
        prices=[27380.0, 27380.0, 27380.0],
        signed_qty=[1, 1, 1],
    )

    fp = compute_footprint(df, MNQ, time_bin_sec=60)

    # All three in bin [0, 60)
    assert fp.deltas.shape[0] == 1


def test_footprint_300s_bin() -> None:
    df = _trades_frame(
        event_ts_ns=[0, 100 * _NS_PER_SEC, 200 * _NS_PER_SEC, 310 * _NS_PER_SEC],
        prices=[27380.0] * 4,
        signed_qty=[1, 1, 1, 1],
    )

    fp = compute_footprint(df, MNQ, time_bin_sec=300)

    # First three in bin [0, 300); fourth in bin [300, 600)
    assert fp.deltas.shape[0] == 2


def test_footprint_uses_event_ts_ns_not_recv_ts_ns() -> None:
    # Add recv_ts_ns as a "decoy" column — should NOT be used for binning.
    df = _trades_frame(
        event_ts_ns=[0, 35 * _NS_PER_SEC],
        prices=[27380.0, 27380.0],
        signed_qty=[1, 1],
    )
    df["recv_ts_ns"] = [9999, 9999]  # if loader used this, both rows → same bin

    fp = compute_footprint(df, MNQ, time_bin_sec=30)

    # Two distinct bins because event_ts_ns differ by >30s
    assert fp.deltas.shape[0] == 2


# ---------------------------------------------------------------------------
# Price bucketing
# ---------------------------------------------------------------------------


def test_footprint_price_bucket_1_tick() -> None:
    # Price bin = 1 tick (0.25 for MNQ).
    df = _trades_frame(
        event_ts_ns=[0, _NS_PER_SEC],
        prices=[27380.25, 27380.50],
        signed_qty=[1, 1],
    )

    fp = compute_footprint(df, MNQ, price_bin_ticks=1)

    # Two distinct price levels
    assert fp.deltas.shape[1] == 2
    assert fp.price_bin == 0.25


def test_footprint_price_bucket_4_ticks_collapses_levels() -> None:
    # Price bin = 4 ticks (1 point). Adjacent ticks collapse.
    df = _trades_frame(
        event_ts_ns=[0, _NS_PER_SEC, 2 * _NS_PER_SEC],
        prices=[27380.25, 27380.50, 27380.75],
        signed_qty=[1, 1, 1],
    )

    fp = compute_footprint(df, MNQ, price_bin_ticks=4)

    # All three prices fall in the same 1-pt bucket [27380.0, 27381.0)
    assert fp.deltas.shape[1] == 1
    assert 27380.0 in fp.deltas.columns
    assert fp.price_bin == 1.0


# ---------------------------------------------------------------------------
# Aux outputs
# ---------------------------------------------------------------------------


def test_total_volume_per_bin() -> None:
    df = _trades_frame(
        event_ts_ns=[0, _NS_PER_SEC, 35 * _NS_PER_SEC],
        prices=[27380.0, 27380.0, 27380.0],
        signed_qty=[2, -3, 5],
    )

    fp = compute_footprint(df, MNQ, time_bin_sec=30)

    # bin 0: |2| + |3| = 5; bin 1: |5| = 5
    assert fp.total_volume_per_bin.iloc[0] == 5
    assert fp.total_volume_per_bin.iloc[1] == 5
    assert fp.total_volume_per_bin.dtype == np.int64


def test_imbalance_per_level_pure_buy() -> None:
    df = _trades_frame(
        event_ts_ns=[0, _NS_PER_SEC],
        prices=[27380.0, 27380.0],
        signed_qty=[3, 2],  # all buys
    )

    fp = compute_footprint(df, MNQ)

    # +5 net delta / 5 total volume = +1.0
    assert fp.imbalance_per_level.iloc[0][27380.0] == pytest.approx(1.0)


def test_imbalance_per_level_pure_sell() -> None:
    df = _trades_frame(
        event_ts_ns=[0, _NS_PER_SEC],
        prices=[27380.0, 27380.0],
        signed_qty=[-3, -2],  # all sells
    )

    fp = compute_footprint(df, MNQ)

    # -5 / 5 = -1.0
    assert fp.imbalance_per_level.iloc[0][27380.0] == pytest.approx(-1.0)


def test_imbalance_per_level_balanced() -> None:
    df = _trades_frame(
        event_ts_ns=[0, _NS_PER_SEC],
        prices=[27380.0, 27380.0],
        signed_qty=[3, -3],
    )

    fp = compute_footprint(df, MNQ)

    # 0 / 6 = 0.0
    assert fp.imbalance_per_level.iloc[0][27380.0] == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# Empty input
# ---------------------------------------------------------------------------


def test_footprint_empty_input() -> None:
    df = _trades_frame(event_ts_ns=[], prices=[], signed_qty=[])

    fp = compute_footprint(df, MNQ)

    assert isinstance(fp, Footprint)
    assert fp.deltas.empty
    assert fp.total_volume_per_bin.empty
    assert fp.imbalance_per_level.empty
    # bin_size still computed from contract
    assert fp.price_bin == 0.25
    assert fp.time_bin_sec == 30


# ---------------------------------------------------------------------------
# Dataclass safety
# ---------------------------------------------------------------------------


def test_footprint_dataclass_is_frozen() -> None:
    import dataclasses

    df = _trades_frame(event_ts_ns=[0], prices=[27380.0], signed_qty=[1])
    fp = compute_footprint(df, MNQ)

    with pytest.raises(dataclasses.FrozenInstanceError):
        fp.time_bin_sec = 999  # type: ignore[misc]
