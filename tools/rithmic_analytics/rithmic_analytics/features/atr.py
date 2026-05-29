"""Wilder ATR over tick data.

Resamples tick prices into OHLC bars on a configurable time bucket and computes
the standard Wilder Average True Range:

    TR[i]   = max(H[i] - L[i], |H[i] - C[i-1]|, |L[i] - C[i-1]|)
    ATR[N]  = mean(TR[1..N])                     # seed value
    ATR[i]  = (ATR[i-1] * (N - 1) + TR[i]) / N   # for i > N

Bars use ``event_ts_ns`` (canonical exchange timestamp) per the plan's Decisions
block — never ``recv_ts_ns``.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

# Pre-computed nanosecond bar sizes for the common cases.
_NS_PER_MINUTE: int = 60 * 10**9
NS_1M: int = _NS_PER_MINUTE
NS_5M: int = 5 * _NS_PER_MINUTE
NS_15M: int = 15 * _NS_PER_MINUTE
NS_1H: int = 60 * _NS_PER_MINUTE


def compute_atr_from_ticks(
    trades: pd.DataFrame,
    period: int = 14,
    bar_size_ns: int = NS_5M,
) -> float:
    """Compute Wilder ATR over tick-level trades resampled to fixed-size bars.

    Args:
        trades: DataFrame with ``event_ts_ns`` (int64) and ``price`` (float64)
            columns. Output of :func:`rithmic_analytics.core.loader.load_obs01_trades`
            is directly compatible.
        period: Wilder smoothing window. Default 14.
        bar_size_ns: Bar width in nanoseconds. Defaults to 5 minutes
            (``NS_5M``). Use ``NS_1M`` / ``NS_15M`` / ``NS_1H`` for other
            resolutions, or any other ns value for custom sizes.

    Returns:
        Final ATR value as a float, or ``math.nan`` if the input has fewer than
        ``period`` complete bars after resampling.

    Example:
        >>> import pandas as pd
        >>> from rithmic_analytics.features.atr import compute_atr_from_ticks, NS_5M
        >>> # 60 ticks spanning 15 5-min bars
        >>> trades = pd.DataFrame({"event_ts_ns": [...], "price": [...]})
        >>> atr = compute_atr_from_ticks(trades, period=14, bar_size_ns=NS_5M)
    """
    if len(trades) == 0:
        return math.nan

    event_ts = trades["event_ts_ns"].to_numpy(dtype="int64")
    prices = trades["price"].to_numpy(dtype="float64")

    bar_keys = (event_ts // bar_size_ns) * bar_size_ns
    df = pd.DataFrame({"bar_ns": bar_keys, "price": prices})

    ohlc = df.groupby("bar_ns", sort=True)["price"].agg(["first", "max", "min", "last"])
    ohlc.columns = ["open", "high", "low", "close"]

    if len(ohlc) < period:
        return math.nan

    high = ohlc["high"].to_numpy(dtype="float64")
    low = ohlc["low"].to_numpy(dtype="float64")
    close = ohlc["close"].to_numpy(dtype="float64")

    # True Range. First bar has no prior close → fall back to H-L.
    tr = np.empty(len(ohlc), dtype="float64")
    tr[0] = high[0] - low[0]
    for i in range(1, len(ohlc)):
        prev_close = close[i - 1]
        tr[i] = max(
            high[i] - low[i],
            abs(high[i] - prev_close),
            abs(low[i] - prev_close),
        )

    # Wilder smoothing: seed = mean of first `period` TRs, then recursive.
    atr = float(tr[:period].mean())
    for i in range(period, len(tr)):
        atr = (atr * (period - 1) + tr[i]) / period

    return atr
