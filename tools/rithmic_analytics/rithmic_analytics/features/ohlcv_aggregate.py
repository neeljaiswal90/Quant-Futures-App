"""Aggregate tick trades into TradingView-compatible OHLCV bars.

Used by the RA-020 retrofits of ``D:\\MNQ-Futures\\tools\\vp_*.py``: when
``--source rithmic`` is passed, the scripts call :func:`aggregate_to_ohlcv` to
convert Rithmic OBS-01 trades into the same bar shape they normally consume
from TradingView's cached OHLCV JSON. The scripts' existing VP algorithms
then run unchanged.

Bar boundary semantics match TradingView: a trade at ``event_ts_ns = T``
contributes to the bar at unix-timestamp ``time = floor(T / 10**9 /
bar_size_sec) * bar_size_sec``.

Wire shape (matches the dicts produced by ``vp_*.py::load_bars``)::

    {"time": 1778767200, "open": 29380.25, "high": 29382.50,
     "low": 29379.75, "close": 29381.00, "volume": 247}

Empty bars (no trades in the bucket) are excluded from the output — matching
TradingView's behavior of only emitting bars that actually have volume.
"""

from __future__ import annotations

from typing import Any, cast

import pandas as pd

_NS_PER_SECOND: int = 10**9


def aggregate_to_ohlcv(trades: pd.DataFrame, bar_size_sec: int) -> list[dict[str, Any]]:
    """Aggregate tick trades into TV-compatible OHLCV bars.

    A trade with ``event_ts_ns = T`` contributes to bar ``B`` where::

        B.time_ns <= T < B.time_ns + bar_size_sec * 10**9

    This matches TradingView's bar semantics: the bar at unix-timestamp
    ``time`` covers trades from ``time`` through ``time + bar_size_sec - 1``
    (inclusive). The output is sorted by ``time`` ascending.

    Args:
        trades: DataFrame with ``event_ts_ns`` (int64), ``price`` (float64),
            ``quantity`` (int) — output of
            :func:`rithmic_analytics.core.loader.load_obs01_trades`.
        bar_size_sec: Bar width in seconds. Must be positive.

    Returns:
        List of dicts with keys ``time`` (unix seconds, int), ``open``,
        ``high``, ``low``, ``close`` (float), ``volume`` (int). Sorted by
        ``time`` ascending. Empty bars (no trades) are excluded. Returns
        ``[]`` for empty input.

    Raises:
        ValueError: If ``bar_size_sec <= 0``.

    Example:
        >>> from rithmic_analytics.core.loader import load_obs01_trades
        >>> trades = load_obs01_trades(Path("l1-trade.jsonl"))
        >>> bars_5m = aggregate_to_ohlcv(trades, bar_size_sec=300)
        >>> len(bars_5m)
        8
        >>> bars_5m[0]
        {'time': 1777301400, 'open': 27381.25, 'high': 27382.5, ...}
    """
    if bar_size_sec <= 0:
        raise ValueError(f"bar_size_sec must be positive, got {bar_size_sec}")
    if len(trades) == 0:
        return []

    bar_size_ns = bar_size_sec * _NS_PER_SECOND
    event_ts = trades["event_ts_ns"].to_numpy(dtype="int64")
    bar_starts_ns = (event_ts // bar_size_ns) * bar_size_ns

    df = trades.assign(_bar_ns=bar_starts_ns)
    grouped = df.groupby("_bar_ns", sort=True, observed=True).agg(
        open=("price", "first"),
        high=("price", "max"),
        low=("price", "min"),
        close=("price", "last"),
        volume=("quantity", "sum"),
    )

    result: list[dict[str, Any]] = []
    for bar_ns, row in grouped.iterrows():
        # pandas-stubs types `.iterrows()` indexes as Hashable; bar_ns is an int64
        # we put into the groupby ourselves.
        bar_ns_int = cast(int, bar_ns)
        result.append(
            {
                "time": bar_ns_int // _NS_PER_SECOND,
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": int(row["volume"]),
            }
        )
    return result
