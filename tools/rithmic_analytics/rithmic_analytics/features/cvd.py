"""True CVD (Cumulative Volume Delta) + price/CVD divergence detection.

CVD = running sum of ``signed_qty`` (buy aggression = +qty, sell = -qty). Three
flavors are produced:

- ``cvd``      — cumulative across the entire input DataFrame.
- ``cvd_rth``  — cumulative within each ``session_id`` group (resets at session
                 boundaries; matches what Neel watches on Bookmap).
- ``cvd_minute`` — signed-qty sum per 1-minute event-time bucket. Same value
                   broadcast to every row falling in that bucket. Useful as a
                   "delta strength" feature for footprint overlays.

Divergence detector flags rows where rolling-window percentile rank of price
diverges from the same window's rank of CVD by ≥ ``min_divergence`` (default
0.5). The rationale: when price punches a new high relative to recent prints
but CVD doesn't, aggressive buying has stalled — a classic bearish divergence
signal.
"""

from __future__ import annotations

import pandas as pd

_NS_PER_MINUTE: int = 60 * 10**9


def compute_cvd(trades: pd.DataFrame) -> pd.DataFrame:
    """Add CVD columns to a trades DataFrame.

    Bucketing for ``cvd_minute`` uses ``event_ts_ns`` per architecture.md D-004
    (canonical timestamp throughout the analytics layer).

    Args:
        trades: DataFrame with at least ``signed_qty`` (int), ``event_ts_ns``
            (int64), and ``session_id`` (str/categorical) columns. The output
            of :func:`rithmic_analytics.core.loader.load_obs01_trades` is
            directly compatible.

    Returns:
        Copy of ``trades`` with three int64 columns appended:

        - ``cvd``: cumulative ``signed_qty`` over the full DataFrame.
        - ``cvd_rth``: cumulative ``signed_qty`` within each ``session_id``
          (resets at session boundaries).
        - ``cvd_minute``: 1-minute event-time bucket sum, broadcast to every
          row in the bucket.

        Empty input returns an empty DataFrame with the same three columns.

    Example:
        >>> from rithmic_analytics.core.loader import load_obs01_trades
        >>> from rithmic_analytics.features.cvd import compute_cvd
        >>> df = load_obs01_trades(path)
        >>> df = compute_cvd(df)
        >>> df["cvd_rth"].iloc[-1]  # net delta for the latest session
    """
    if len(trades) == 0:
        out = trades.copy()
        for col in ("cvd", "cvd_rth", "cvd_minute"):
            out[col] = pd.Series(dtype="int64")
        return out

    result = trades.copy()
    signed = trades["signed_qty"]

    result["cvd"] = signed.cumsum().astype("int64")
    result["cvd_rth"] = (
        trades.groupby("session_id", observed=True)["signed_qty"].cumsum().astype("int64")
    )

    event_ts_arr = trades["event_ts_ns"].to_numpy(dtype="int64")
    minute_bucket = (event_ts_arr // _NS_PER_MINUTE) * _NS_PER_MINUTE
    result["cvd_minute"] = (
        trades.assign(_bucket=minute_bucket)
        .groupby("_bucket", observed=True)["signed_qty"]
        .transform("sum")
        .astype("int64")
    )

    return result


def detect_divergence(
    trades: pd.DataFrame,
    *,
    price_window: int = 500,
    cvd_window: int = 500,
    min_divergence: float = 0.5,
) -> pd.DataFrame:
    """Flag rows where rolling price percentile-rank diverges from rolling CVD rank.

    For each row at index i (after the warmup window), compute:

        price_rank[i] = percentile rank of price[i] within price[i-W .. i]
        cvd_rank[i]   = percentile rank of cvd[i]   within cvd[i-W .. i]
        divergence    = |price_rank - cvd_rank|

    Rows with ``divergence >= min_divergence`` are returned with three extra
    diagnostic columns. Rows in the warmup window (insufficient data) are
    silently dropped.

    Args:
        trades: DataFrame with ``price`` (float) and ``signed_qty`` (int).
        price_window: Rolling window for price rank. Default 500 trades.
        cvd_window: Rolling window for CVD rank. Default 500 trades.
        min_divergence: Threshold in [0, 1] for the absolute rank difference.
            Default 0.5 (price and CVD ranks differ by half the range).

    Returns:
        Subset of ``trades`` with three columns added: ``price_rank``,
        ``cvd_rank``, ``divergence``. Empty if no divergences detected or
        ``trades`` has fewer rows than the max window size.

    Example:
        >>> events = detect_divergence(df, min_divergence=0.6)
        >>> events[["event_ts_ns", "price", "cvd", "divergence"]]
    """
    if len(trades) < max(price_window, cvd_window):
        empty = trades.iloc[0:0].copy()
        empty["price_rank"] = pd.Series(dtype="float64")
        empty["cvd_rank"] = pd.Series(dtype="float64")
        empty["divergence"] = pd.Series(dtype="float64")
        return empty

    price_rank = trades["price"].rolling(price_window).rank(pct=True)
    cvd_series = trades["signed_qty"].cumsum()
    cvd_rank = cvd_series.rolling(cvd_window).rank(pct=True)
    divergence = (price_rank - cvd_rank).abs()

    mask = divergence >= min_divergence
    mask = mask.fillna(False)
    flagged = trades[mask].copy()
    flagged["price_rank"] = price_rank[mask].astype("float64")
    flagged["cvd_rank"] = cvd_rank[mask].astype("float64")
    flagged["divergence"] = divergence[mask].astype("float64")
    return flagged
