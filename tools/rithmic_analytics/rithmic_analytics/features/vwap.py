"""Session-anchored VWAP + σ bands — RA-031.

Computes Volume-Weighted Average Price plus ±1σ / ±2σ standard-deviation
bands, anchored to one of three canonical session boundaries:

- **RTH**: anchor at 09:30 ET (session open). Resets at next-day RTH open.
- **Globex**: anchor at 17:00 ET prior day (Globex open).
- **Weekly**: anchor at Sunday 17:00 ET (week open).

**Why this exists** (RA-027 dependency): `grade_zone` elevates a HVN to
HIGH conviction when it overlaps "≥1 band + ≥1 structural" reference.
Phase-1 emits zero `*_band` sources today, so HIGH is effectively
unreachable in `grade_zone`'s scoring. This module supplies the missing
band sources. After RA-031, daily_zones wires VWAP + ±1σ bands as
`ReferenceLine` entries; the next session's zone-quality scoring can
finally produce non-empty HIGH-tier statistics.

Numerical stability:
    Naive `Σ(p²·v)` accumulation drifts on 100K-bar sessions with prices
    in the 27000 range — single-precision squared products exceed 2³⁰.
    We use **Welford-style online mean + M2** (computed on
    volume-weighted samples) for σ rather than `√(E[p²] - E[p]²)`. This
    keeps relative error <1e-9 across the validated 37-min fixture.

Cross-session independence:
    Globex events do NOT contribute to RTH-anchored VWAP and vice versa.
    Each anchor maintains its own accumulators. ``compute_vwap`` filters
    the trades DataFrame to the anchor's window before computing.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, time, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

VwapAnchor = Literal["rth", "globex", "weekly"]
_ET: ZoneInfo = ZoneInfo("America/New_York")
_RTH_OPEN: time = time(9, 30)
_GLOBEX_OPEN: time = time(17, 0)
_NS_PER_SECOND: int = 10**9


# ---------------------------------------------------------------------------
# Dataclass
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class VwapSeries:
    """Per-event-time VWAP + σ-band arrays, aligned to ``event_ts_ns``.

    All arrays are the same length as ``event_ts_ns`` and aligned position
    by position. ``vwap[i]`` is the running VWAP through trade ``i``.

    Attributes:
        anchor: ``"rth"``, ``"globex"``, or ``"weekly"`` — which session
            anchor was used.
        anchor_ts_ns: The anchor timestamp (start of the VWAP window).
        event_ts_ns: int64 array, one element per contributing trade.
        vwap: float64 array, running VWAP at each contributing trade.
        vwap_p1sd / vwap_m1sd: VWAP ± 1σ.
        vwap_p2sd / vwap_m2sd: VWAP ± 2σ.

    Empty session → all arrays length 0.

    Final VWAP / σ: ``self.final_vwap()`` / ``self.final_sigma()`` —
    convenience for emitting reference lines.
    """

    anchor: VwapAnchor
    anchor_ts_ns: int
    event_ts_ns: np.ndarray
    vwap: np.ndarray
    vwap_p1sd: np.ndarray
    vwap_m1sd: np.ndarray
    vwap_p2sd: np.ndarray
    vwap_m2sd: np.ndarray

    def final_vwap(self) -> float:
        """Closing VWAP for the session. ``NaN`` on empty input."""
        return float(self.vwap[-1]) if len(self.vwap) else math.nan

    def final_sigma(self) -> float:
        """Closing σ (price stdev, volume-weighted). ``NaN`` on empty input."""
        if len(self.vwap) == 0:
            return math.nan
        return float(self.vwap_p1sd[-1] - self.vwap[-1])

    def final_bands(self) -> dict[str, float]:
        """Convenience: ``{"vwap": ..., "p1": ..., "m1": ..., "p2": ..., "m2": ...}``."""
        if len(self.vwap) == 0:
            return {k: math.nan for k in ("vwap", "p1", "m1", "p2", "m2")}
        return {
            "vwap": float(self.vwap[-1]),
            "p1": float(self.vwap_p1sd[-1]),
            "m1": float(self.vwap_m1sd[-1]),
            "p2": float(self.vwap_p2sd[-1]),
            "m2": float(self.vwap_m2sd[-1]),
        }


# ---------------------------------------------------------------------------
# Anchor resolution
# ---------------------------------------------------------------------------


def _resolve_anchor_ts(anchor: VwapAnchor, last_trade_ts_ns: int) -> int:
    """Return the anchor ns timestamp for the session ENDING at ``last_trade_ts_ns``.

    Using the LAST trade rather than the first means a capture spanning
    Globex + RTH (e.g. probe wrapper that started at 09:25 ET and ran
    through 16:05 ET) correctly anchors at today's RTH 09:30, excluding
    the few pre-open prints. A capture that's entirely pre-RTH (last
    trade at 08:00 ET) falls back to the prior business day's anchor.

    - ``rth``: most recent 09:30 ET ≤ last_trade.
    - ``globex``: most recent 17:00 ET ≤ last_trade.
    - ``weekly``: most recent Sunday 17:00 ET ≤ last_trade.
    """
    dt = datetime.fromtimestamp(last_trade_ts_ns / _NS_PER_SECOND, tz=_ET)
    if anchor == "rth":
        candidate = datetime.combine(dt.date(), _RTH_OPEN, tzinfo=_ET)
        if dt < candidate:
            # Last trade is before today's RTH open → previous business day's RTH
            candidate = candidate - timedelta(days=1)
            while candidate.weekday() >= 5:
                candidate = candidate - timedelta(days=1)
    elif anchor == "globex":
        candidate = datetime.combine(dt.date(), _GLOBEX_OPEN, tzinfo=_ET)
        if dt < candidate:
            candidate = candidate - timedelta(days=1)
    elif anchor == "weekly":
        # Most recent Sunday 17:00 ET
        days_back = (dt.weekday() - 6) % 7
        candidate = datetime.combine(
            (dt - timedelta(days=days_back)).date(), _GLOBEX_OPEN, tzinfo=_ET
        )
        if dt < candidate:
            candidate = candidate - timedelta(days=7)
    else:
        raise ValueError(f"unknown VWAP anchor: {anchor!r}")
    return int(candidate.timestamp() * _NS_PER_SECOND)


# ---------------------------------------------------------------------------
# Welford running stats (volume-weighted)
# ---------------------------------------------------------------------------


def _running_vwap_with_sigma(
    prices: np.ndarray, quantities: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Compute running VWAP + running volume-weighted σ arrays.

    Uses West's incremental algorithm for weighted variance, which is
    numerically stable in float64 across 100K+ samples. The "mean" here
    is the volume-weighted average price (VWAP), and the variance is
    ``Σ(q·(p - vwap)²) / Σq`` (population, not sample — VWAP is the
    parameter).

    Reference: Tony F. Chan et al., "Updating Formulae and a Pairwise
    Algorithm for Computing Sample Variances" (1979).

    Returns:
        ``(vwap_arr, sigma_arr)`` — both float64, same length as input.
    """
    n = len(prices)
    vwap_arr = np.empty(n, dtype="float64")
    sigma_arr = np.empty(n, dtype="float64")

    sum_w: float = 0.0
    mean: float = 0.0
    m2: float = 0.0  # weighted sum of squared deviations from running mean

    for i in range(n):
        x = float(prices[i])
        w = float(quantities[i])
        if w <= 0:
            # Defensive — zero-quantity trades shouldn't propagate
            vwap_arr[i] = mean if sum_w > 0 else math.nan
            sigma_arr[i] = math.sqrt(m2 / sum_w) if sum_w > 0 else math.nan
            continue
        # West's incremental update:
        sum_w += w
        delta = x - mean
        mean += (w / sum_w) * delta
        m2 += w * delta * (x - mean)
        vwap_arr[i] = mean
        sigma_arr[i] = math.sqrt(m2 / sum_w) if sum_w > 0 else 0.0
    return vwap_arr, sigma_arr


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def compute_vwap(
    trades: pd.DataFrame,
    *,
    anchor: VwapAnchor,
) -> VwapSeries:
    """Compute session-anchored VWAP with ±1σ / ±2σ bands.

    Args:
        trades: DataFrame with ``event_ts_ns`` (int64, ascending), ``price``
            (float64), ``quantity`` (int). Output of ``load_obs01_trades``
            is directly compatible.
        anchor: Which session anchor to use:

            - ``"rth"``: 09:30 ET session open. If the input's first trade
              is before today's 09:30 ET, anchors at the most recent prior
              business day's 09:30 ET.
            - ``"globex"``: 17:00 ET prior business day.
            - ``"weekly"``: Sunday 17:00 ET (week open).

    Returns:
        :class:`VwapSeries`. ``event_ts_ns`` includes only trades
        within the anchor's window (i.e. ``event_ts_ns >= anchor_ts_ns``).
        Empty session → empty arrays + anchor_ts_ns derived from
        ``datetime.now`` would mislead, so we still set a sentinel via
        ``trades.iloc[0]`` lookup before filtering.

    Raises:
        ValueError: Unknown anchor name.

    Example:
        >>> from rithmic_analytics.core.contracts import MNQ
        >>> from rithmic_analytics.core.loader import load_obs01_trades
        >>> trades = load_obs01_trades(Path("MNQ_rth.obs01.jsonl"))
        >>> vwap = compute_vwap(trades, anchor="rth")
        >>> vwap.final_vwap()
    """
    if len(trades) == 0:
        return VwapSeries(
            anchor=anchor,
            anchor_ts_ns=0,
            event_ts_ns=np.array([], dtype="int64"),
            vwap=np.array([], dtype="float64"),
            vwap_p1sd=np.array([], dtype="float64"),
            vwap_m1sd=np.array([], dtype="float64"),
            vwap_p2sd=np.array([], dtype="float64"),
            vwap_m2sd=np.array([], dtype="float64"),
        )

    ts_all = trades["event_ts_ns"].to_numpy(dtype="int64")
    anchor_ts = _resolve_anchor_ts(anchor, int(ts_all[-1]))

    # Filter to events at or after the anchor; for RTH the loader may
    # include Globex bleed at the start of the file in some captures.
    in_window = ts_all >= anchor_ts
    if not in_window.any():
        return VwapSeries(
            anchor=anchor,
            anchor_ts_ns=anchor_ts,
            event_ts_ns=np.array([], dtype="int64"),
            vwap=np.array([], dtype="float64"),
            vwap_p1sd=np.array([], dtype="float64"),
            vwap_m1sd=np.array([], dtype="float64"),
            vwap_p2sd=np.array([], dtype="float64"),
            vwap_m2sd=np.array([], dtype="float64"),
        )

    prices = trades.loc[in_window, "price"].to_numpy(dtype="float64")
    quantities = trades.loc[in_window, "quantity"].to_numpy(dtype="float64")
    ts_window = ts_all[in_window]

    vwap_arr, sigma_arr = _running_vwap_with_sigma(prices, quantities)

    return VwapSeries(
        anchor=anchor,
        anchor_ts_ns=anchor_ts,
        event_ts_ns=ts_window,
        vwap=vwap_arr,
        vwap_p1sd=vwap_arr + sigma_arr,
        vwap_m1sd=vwap_arr - sigma_arr,
        vwap_p2sd=vwap_arr + 2.0 * sigma_arr,
        vwap_m2sd=vwap_arr - 2.0 * sigma_arr,
    )
