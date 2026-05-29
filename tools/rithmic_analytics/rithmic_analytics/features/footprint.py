"""Footprint chart compute: time × price net-delta pivot.

A "footprint" cell at (time_bin, price_level) is the sum of ``signed_qty`` for
all trades whose ``event_ts_ns`` falls in that time bucket and whose ``price``
falls in that price bucket. Empty cells are NaN (not 0) — the downstream
renderer differentiates "no trade" from "balanced".

Three views are returned bundled in a ``Footprint`` dataclass:

- ``deltas``: signed net delta per cell.
- ``total_volume_per_bin``: row-total volume (sum of ``quantity``), useful for
  proportional cell sizing in the renderer.
- ``imbalance_per_level``: per-cell ratio ``net_delta / total_volume`` in
  ``[-1, +1]``. +1 = pure buying, -1 = pure selling, 0 = balanced.

Time and price bins use floor-bucketing on ``event_ts_ns`` (per architecture.md
D-004) and ``price`` respectively. ``time_bin_sec=30`` and ``price_bin_ticks=1``
are the documented defaults.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from rithmic_analytics.core.contracts import ContractSpec

_NS_PER_SECOND: int = 10**9


@dataclass(frozen=True, slots=True)
class Footprint:
    """Result of :func:`compute_footprint`.

    Attributes:
        deltas: DataFrame indexed by ``time_bin_ns`` (int64) with float columns
            named by price-level (bin lower edge). Cells = ``signed_qty`` sum;
            NaN where no trades.
        total_volume_per_bin: Series indexed by ``time_bin_ns`` with total
            ``quantity`` summed per row.
        imbalance_per_level: DataFrame same shape as ``deltas``; cells =
            ``net_delta / total_volume`` ∈ ``[-1, +1]``. NaN where no trades.
        time_bin_sec: Time bucket width used.
        price_bin: Price bucket width in points (= ``price_bin_ticks ×
            tick_size``).
    """

    deltas: pd.DataFrame
    total_volume_per_bin: pd.Series
    imbalance_per_level: pd.DataFrame
    time_bin_sec: int
    price_bin: float


def _empty_footprint(time_bin_sec: int, price_bin: float) -> Footprint:
    return Footprint(
        deltas=pd.DataFrame(),
        total_volume_per_bin=pd.Series(dtype="int64"),
        imbalance_per_level=pd.DataFrame(),
        time_bin_sec=time_bin_sec,
        price_bin=price_bin,
    )


def compute_footprint(
    trades: pd.DataFrame,
    contract: ContractSpec,
    *,
    time_bin_sec: int = 30,
    price_bin_ticks: int = 1,
) -> Footprint:
    """Pivot trades into a time × price grid of net deltas.

    Args:
        trades: DataFrame with ``event_ts_ns`` (int64), ``price`` (float64),
            ``quantity`` (int), ``signed_qty`` (int). Output of
            ``load_obs01_trades`` is directly compatible.
        contract: Provides ``tick_size`` for price bucketing.
        time_bin_sec: Time bucket width in seconds. Default 30.
        price_bin_ticks: Price bucket width in ticks. Default 1.

    Returns:
        ``Footprint`` dataclass. Empty bundle if ``trades`` is empty.

    Example:
        >>> from rithmic_analytics.core.contracts import MNQ
        >>> fp = compute_footprint(trades, MNQ, time_bin_sec=60)
        >>> fp.deltas.shape  # (num_time_bins, num_price_levels)
    """
    price_bin = price_bin_ticks * contract.tick_size
    if len(trades) == 0:
        return _empty_footprint(time_bin_sec, price_bin)

    time_bin_ns = time_bin_sec * _NS_PER_SECOND

    event_ts = trades["event_ts_ns"].to_numpy(dtype="int64")
    prices = trades["price"].to_numpy(dtype="float64")
    quantities = trades["quantity"].to_numpy(dtype="int64")
    signed = trades["signed_qty"].to_numpy(dtype="int64")

    time_bucket = (event_ts // time_bin_ns) * time_bin_ns
    price_bucket = np.floor(prices / price_bin) * price_bin

    agg = pd.DataFrame(
        {
            "time_bin_ns": time_bucket,
            "price_bin": price_bucket,
            "quantity": quantities,
            "signed_qty": signed,
        }
    )

    grouped = agg.groupby(["time_bin_ns", "price_bin"], sort=True, observed=True).agg(
        net_delta=("signed_qty", "sum"),
        total_volume=("quantity", "sum"),
    )

    # Pivot: rows = time, cols = price. NaN preserved where no trades (no fill_value).
    deltas = grouped["net_delta"].unstack(level="price_bin").astype("float64")
    totals_per_cell = grouped["total_volume"].unstack(level="price_bin").astype("float64")
    imbalance = (deltas / totals_per_cell).astype("float64")

    total_volume_per_bin = (
        agg.groupby("time_bin_ns", sort=True, observed=True)["quantity"]
        .sum()
        .astype("int64")
    )

    return Footprint(
        deltas=deltas,
        total_volume_per_bin=total_volume_per_bin,
        imbalance_per_level=imbalance,
        time_bin_sec=time_bin_sec,
        price_bin=price_bin,
    )
