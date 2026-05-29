"""Tests for ``rithmic_analytics.features.cvd``."""

from __future__ import annotations

import time

import numpy as np
import pandas as pd
import pytest

from rithmic_analytics.core.loader import load_obs01_trades
from rithmic_analytics.features.cvd import compute_cvd, detect_divergence

from .conftest import REAL_OBS01

_NS_PER_SEC = 1_000_000_000
_NS_PER_MIN = 60 * _NS_PER_SEC


def _trades_frame(
    *,
    event_ts_ns: list[int],
    signed_qty: list[int],
    session_ids: list[str] | None = None,
    prices: list[float] | None = None,
) -> pd.DataFrame:
    n = len(event_ts_ns)
    return pd.DataFrame(
        {
            "event_ts_ns": np.array(event_ts_ns, dtype="int64"),
            "signed_qty": np.array(signed_qty, dtype="int32"),
            "session_id": session_ids if session_ids is not None else ["s1"] * n,
            "price": prices if prices is not None else [27380.0] * n,
            "quantity": [abs(q) for q in signed_qty],
        }
    )


# ---------------------------------------------------------------------------
# compute_cvd — basic semantics
# ---------------------------------------------------------------------------


def test_cvd_cumsum_matches_signed_qty_running_sum() -> None:
    df = _trades_frame(
        event_ts_ns=[1_000_000_000, 2_000_000_000, 3_000_000_000],
        signed_qty=[5, -3, 7],
    )

    out = compute_cvd(df)

    assert out["cvd"].tolist() == [5, 2, 9]
    # Sanity: final cvd == sum of signed_qty
    assert out["cvd"].iloc[-1] == df["signed_qty"].sum()


def test_cvd_rth_resets_per_session() -> None:
    df = _trades_frame(
        event_ts_ns=[1, 2, 3, 4, 5],
        signed_qty=[5, 3, 10, -2, 4],
        session_ids=["s1", "s1", "s2", "s2", "s2"],
    )

    out = compute_cvd(df)

    # Within s1: 5, 8. Within s2: 10, 8, 12. Global cvd: 5, 8, 18, 16, 20.
    assert out["cvd_rth"].tolist() == [5, 8, 10, 8, 12]
    assert out["cvd"].tolist() == [5, 8, 18, 16, 20]


def test_cvd_minute_buckets_signed_qty_per_minute() -> None:
    # Three trades in minute 0, two in minute 1.
    df = _trades_frame(
        event_ts_ns=[
            10 * _NS_PER_SEC,  # min 0
            20 * _NS_PER_SEC,  # min 0
            50 * _NS_PER_SEC,  # min 0
            70 * _NS_PER_SEC,  # min 1
            80 * _NS_PER_SEC,  # min 1
        ],
        signed_qty=[1, 2, 3, 4, -1],
    )

    out = compute_cvd(df)

    # Bucket sums: minute 0 → 6, minute 1 → 3
    assert out["cvd_minute"].iloc[0] == 6
    assert out["cvd_minute"].iloc[2] == 6
    assert out["cvd_minute"].iloc[3] == 3
    assert out["cvd_minute"].iloc[4] == 3


def test_cvd_dtypes_are_int64() -> None:
    df = _trades_frame(event_ts_ns=[1, 2, 3], signed_qty=[1, -1, 2])

    out = compute_cvd(df)

    assert out["cvd"].dtype == np.int64
    assert out["cvd_rth"].dtype == np.int64
    assert out["cvd_minute"].dtype == np.int64


def test_cvd_empty_input_returns_empty_with_columns() -> None:
    df = _trades_frame(event_ts_ns=[], signed_qty=[])

    out = compute_cvd(df)

    assert len(out) == 0
    assert "cvd" in out.columns
    assert "cvd_rth" in out.columns
    assert "cvd_minute" in out.columns


def test_cvd_preserves_input_columns() -> None:
    df = _trades_frame(event_ts_ns=[1, 2], signed_qty=[1, -1])

    out = compute_cvd(df)

    for col in df.columns:
        assert col in out.columns


# ---------------------------------------------------------------------------
# detect_divergence
# ---------------------------------------------------------------------------


def test_divergence_synthetic_price_up_cvd_flat() -> None:
    # Price ramps monotonically up; sells dominate (CVD goes down). Maximum
    # divergence at the end of the series.
    n = 1000
    prices = list(np.linspace(27000.0, 27500.0, n))
    signed = [-1] * n  # all sells → CVD strictly decreasing
    df = _trades_frame(
        event_ts_ns=list(range(n)),
        signed_qty=signed,
        prices=prices,
    )

    flagged = detect_divergence(
        df, price_window=200, cvd_window=200, min_divergence=0.8
    )

    # We expect many late-series rows flagged (price near max-rank, CVD near min-rank).
    assert len(flagged) > 0
    # Sanity: divergence column populated
    assert (flagged["divergence"] >= 0.8).all()


def test_divergence_no_signal_when_price_and_cvd_aligned() -> None:
    # Price ramps up AND buys dominate — both ranks high → low divergence.
    n = 1000
    prices = list(np.linspace(27000.0, 27500.0, n))
    signed = [1] * n  # all buys
    df = _trades_frame(event_ts_ns=list(range(n)), signed_qty=signed, prices=prices)

    flagged = detect_divergence(df, price_window=200, cvd_window=200, min_divergence=0.5)

    # Both ranks rise in lockstep → no divergence flagged
    assert len(flagged) == 0


def test_divergence_threshold_configurable() -> None:
    n = 1000
    prices = list(np.linspace(27000.0, 27500.0, n))
    df = _trades_frame(
        event_ts_ns=list(range(n)),
        signed_qty=[-1] * n,
        prices=prices,
    )

    strict = detect_divergence(df, price_window=200, cvd_window=200, min_divergence=0.95)
    loose = detect_divergence(df, price_window=200, cvd_window=200, min_divergence=0.5)

    # Stricter threshold → fewer flagged rows
    assert len(strict) <= len(loose)


def test_divergence_returns_empty_when_input_smaller_than_window() -> None:
    df = _trades_frame(event_ts_ns=list(range(50)), signed_qty=[1] * 50)

    flagged = detect_divergence(df, price_window=500, cvd_window=500)

    assert len(flagged) == 0
    # But the diagnostic columns are still defined on the empty frame
    assert "divergence" in flagged.columns


def test_divergence_emits_diagnostic_columns() -> None:
    n = 1000
    prices = list(np.linspace(27000.0, 27500.0, n))
    df = _trades_frame(
        event_ts_ns=list(range(n)),
        signed_qty=[-1] * n,
        prices=prices,
    )

    flagged = detect_divergence(df, price_window=200, cvd_window=200, min_divergence=0.7)

    if len(flagged) > 0:
        assert {"price_rank", "cvd_rank", "divergence"} <= set(flagged.columns)
        assert (flagged["price_rank"] >= 0).all()
        assert (flagged["price_rank"] <= 1).all()


# ---------------------------------------------------------------------------
# Real fixture
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real fixture not present")
def test_cvd_real_fixture_performance() -> None:
    # Acceptance: <2s on 104K trades.
    trades = load_obs01_trades(REAL_OBS01)

    t0 = time.perf_counter()
    out = compute_cvd(trades)
    elapsed = time.perf_counter() - t0

    assert elapsed < 2.0, f"compute_cvd took {elapsed:.2f}s, budget is 2s"
    assert len(out) == 104_358
    assert out["cvd"].iloc[-1] == trades["signed_qty"].sum()
