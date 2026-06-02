"""RA-112e step 10 / Move 3 — volatility estimators for the tail-cap redesign.

Replaces the static ``0.5 × ATR(14, 60m)`` cap with two range-aware components:

1. **Yang-Zhang (YZ) volatility** — drift-independent, OHLC-based estimator.
   Unlike close-to-close σ, YZ uses high/low/open so it does NOT collapse
   during directional moves. Returns variance in log-return space; the caller
   converts to price points via ``yz_sigma_points = anchor * sqrt(yz_var)``.

2. **Empirical p99 of realized 60-min ranges** over the prior N completed
   sessions. Tail floor that history says "moves of this size are real."

3. **Bipower variation** — jump-robust integrated variance estimator. Used
   only as an *anomaly diagnostic flag* (YZ / BV divergence), NOT a hard clamp.
   See module docstring in sigma_zones_v3 for why.

Pure functions; no realtime-backend dependencies. All inputs are explicit
arrays / iterables of OHLC bars or trade ticks. Time conventions: timestamps
are integer nanoseconds, durations are float seconds.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Sequence


# Default Yang-Zhang `k` weight per Yang & Zhang (2000). With M = 60min /
# 5min = 12 sub-bars this evaluates to ~0.34. The closed form leaves it
# tunable for callers that want a different sub-bar count.
def _yz_k(n_subbars: int, alpha: float = 1.34) -> float:
    """Yang-Zhang optimal weight for the open-close component.

    k = (alpha - 1) / (alpha + (N + 1) / (N - 1))     where alpha = 1.34
    """
    if n_subbars < 2:
        return 0.0
    return (alpha - 1.0) / (alpha + (n_subbars + 1) / (n_subbars - 1))


@dataclass(frozen=True, slots=True)
class OhlcBar:
    """One sub-bar's OHLC in price units (NOT logs). Caller is responsible
    for ensuring bars are contiguous, ordered, and on the same instrument."""
    open: float
    high: float
    low: float
    close: float


@dataclass(frozen=True, slots=True)
class YangZhangEstimate:
    """Unit-safe Yang-Zhang result. ``variance_log`` and ``sigma_log`` are in
    *log-return space*; converting to MNQ points requires an anchor price.
    The class methods enforce that boundary so call sites cannot accidentally
    treat a log-space number as price-points.

    Carries the decomposed components (overnight, open-close, Rogers-Satchell)
    for audit. ``window_minutes`` is metadata passed by the caller so a result
    object self-documents its computation horizon.
    """
    variance_log: float
    sigma_log: float
    n_bars: int
    window_minutes: int
    k_weight: float
    has_overnight: bool
    # decomposition components, all in log-return space
    sigma_overnight_sq: float
    sigma_open_close_sq: float
    sigma_rs_sq: float       # Rogers-Satchell component

    def sigma_points(self, anchor_price: float) -> float:
        """Convert log-return σ to MNQ points using the anchor.

        For small log returns r, ``price * r ≈ price * (e^r - 1)`` — adequate
        for the magnitudes seen in intraday MNQ vol (r << 1).
        """
        if not math.isfinite(anchor_price) or anchor_price <= 0.0:
            return 0.0
        return anchor_price * self.sigma_log

    def ladder_span_points(
        self, anchor_price: float, sigma_multiplier: float = 3.0
    ) -> float:
        """Ladder-span-equivalent number of MNQ points.

        Default ``sigma_multiplier = 3.0`` gives a 3σ-equivalent span, used
        as the YZ contribution to the volatility-guardrail cap in
        sigma_zones_v3.
        """
        return sigma_multiplier * self.sigma_points(anchor_price)


def yang_zhang_variance(
    bars: Sequence[OhlcBar],
    *,
    window_minutes: int,
    alpha: float = 1.34,
    include_overnight: bool = False,
) -> YangZhangEstimate:
    """Estimate Yang-Zhang volatility from a sequence of OHLC sub-bars.

    Returns σ² in **log-return space** as a unit-safe :class:`YangZhangEstimate`.
    Convert to MNQ points via ``result.sigma_points(anchor)`` or
    ``result.ladder_span_points(anchor, sigma_multiplier=3.0)`` — call sites
    should never multiply by ``anchor_price`` manually.

    ``window_minutes`` is the caller-supplied horizon (e.g. 60 for a trailing
    60-min YZ) — stored on the result so it self-documents.

    ``include_overnight`` controls whether close[i-1] -> open[i] gaps
    contribute to the overnight component. For an intraday-only horizon
    (e.g. the trailing 60 minutes of RTH tape), set False — close-to-open
    "gaps" within a continuous session are zero by definition.

    Returns a zero-variance estimate if fewer than 2 bars are supplied.
    """
    n = len(bars)
    if n < 2:
        return YangZhangEstimate(
            variance_log=0.0, sigma_log=0.0, n_bars=n,
            window_minutes=window_minutes, k_weight=0.0,
            has_overnight=include_overnight,
            sigma_overnight_sq=0.0, sigma_open_close_sq=0.0, sigma_rs_sq=0.0,
        )

    k = _yz_k(n, alpha=alpha)

    overnight_sq_sum = 0.0
    open_close_sq_sum = 0.0
    rs_sq_sum = 0.0
    valid = 0

    for i in range(1, n):
        prev = bars[i - 1]
        cur = bars[i]
        if min(prev.open, prev.high, prev.low, prev.close,
               cur.open, cur.high, cur.low, cur.close) <= 0:
            # Bad data: log-domain math would diverge. Skip the bar.
            continue
        log_o = math.log(cur.open)
        log_h = math.log(cur.high)
        log_l = math.log(cur.low)
        log_c = math.log(cur.close)
        log_pc = math.log(prev.close)

        if include_overnight:
            overnight = log_o - log_pc
            overnight_sq_sum += overnight * overnight
        open_close = log_c - log_o
        open_close_sq_sum += open_close * open_close

        # Rogers-Satchell: variance estimator using only intrabar geometry,
        # zero under no-drift, finite under any drift.
        rs = (log_h - log_o) * (log_h - log_c) + (log_l - log_o) * (log_l - log_c)
        rs_sq_sum += rs
        valid += 1

    if valid == 0:
        return YangZhangEstimate(
            variance_log=0.0, sigma_log=0.0, n_bars=n,
            window_minutes=window_minutes, k_weight=k,
            has_overnight=include_overnight,
            sigma_overnight_sq=0.0, sigma_open_close_sq=0.0, sigma_rs_sq=0.0,
        )

    sigma_overnight_sq = overnight_sq_sum / valid if include_overnight else 0.0
    sigma_open_close_sq = open_close_sq_sum / valid
    sigma_rs_sq = rs_sq_sum / valid
    variance = sigma_overnight_sq + k * sigma_open_close_sq + (1.0 - k) * sigma_rs_sq
    if variance < 0.0:
        variance = 0.0
    return YangZhangEstimate(
        variance_log=variance,
        sigma_log=math.sqrt(variance),
        n_bars=n,
        window_minutes=window_minutes,
        k_weight=k,
        has_overnight=include_overnight,
        sigma_overnight_sq=sigma_overnight_sq,
        sigma_open_close_sq=sigma_open_close_sq,
        sigma_rs_sq=sigma_rs_sq,
    )


def bipower_variation(log_returns: Sequence[float]) -> float:
    """Barndorff-Nielsen / Shephard bipower variation — jump-robust estimate
    of integrated variance. Computed as:

        BV = (π / 2) * (M / (M - 1)) * Σ |r_i| * |r_{i-1}|

    where M is the number of returns. Robust to single-bar jumps because a
    jump contaminates one factor in each adjacent product but not both.

    Returns 0.0 if fewer than 2 returns are supplied. The caller can compare
    to YZ to flag jump/anomaly events (yz_bv_divergence diagnostic) — this
    module does NOT decide policy.
    """
    m = len(log_returns)
    if m < 2:
        return 0.0
    s = 0.0
    for i in range(1, m):
        s += abs(log_returns[i]) * abs(log_returns[i - 1])
    return (math.pi / 2.0) * (m / (m - 1)) * s


@dataclass(frozen=True, slots=True)
class RealizedRangeWindow:
    """One overlapping-window range observation. Kept as a dataclass so the
    calibration job can write the full sample set if desired (not just the
    p99) for later audit. Carries enough metadata to do top-window
    diagnostics ("is this large p99 actually from a bad tick?") without
    re-reading the source captures.
    """
    start_ts_ns: int
    end_ts_ns: int
    horizon_minutes: int
    range_points: float
    low_price: float
    high_price: float
    n_trades: int


def overlapping_realized_ranges(
    prices: Sequence[tuple[int, float]],
    *,
    horizon_minutes: int,
    step_minutes: int = 1,
) -> list[RealizedRangeWindow]:
    """Compute overlapping high-low ranges over ``horizon_minutes`` windows,
    stepped every ``step_minutes`` across the input series.

    ``prices`` is a sequence of ``(ts_ns, price)`` pairs ordered by time.
    Returns one ``RealizedRangeWindow`` per window whose span is fully
    contained in the input series (windows that would extend past the last
    sample are dropped — the caller's p99 should not be skewed by short
    edge windows).

    Step + horizon are in minutes. Uses minute-resolution alignment, not
    bar-aligned — fine for trade-tick streams where bars are virtual.
    """
    if not prices:
        return []
    horizon_ns = horizon_minutes * 60 * 1_000_000_000
    step_ns = step_minutes * 60 * 1_000_000_000

    # Sort defensively — caller may pass ticks out-of-order on file reload.
    ordered = sorted(prices, key=lambda x: x[0])
    start_ts = ordered[0][0]
    end_ts = ordered[-1][0]
    if end_ts - start_ts < horizon_ns:
        return []

    # For efficiency on large tick streams: use two pointers + a deque-style
    # window. For now a simple O(N×W) is acceptable since the calibration job
    # runs offline once per session.
    windows: list[RealizedRangeWindow] = []
    win_start = start_ts
    n = len(ordered)
    j_lo = 0
    while win_start + horizon_ns <= end_ts:
        win_end = win_start + horizon_ns
        # advance lower bound
        while j_lo < n and ordered[j_lo][0] < win_start:
            j_lo += 1
        # compute high/low between win_start and win_end
        hi = -math.inf
        lo = math.inf
        n_in = 0
        for k in range(j_lo, n):
            ts, px = ordered[k]
            if ts >= win_end:
                break
            if px > hi:
                hi = px
            if px < lo:
                lo = px
            n_in += 1
        if n_in > 0 and math.isfinite(hi) and math.isfinite(lo):
            windows.append(RealizedRangeWindow(
                start_ts_ns=win_start,
                end_ts_ns=win_end,
                horizon_minutes=horizon_minutes,
                range_points=hi - lo,
                low_price=lo,
                high_price=hi,
                n_trades=n_in,
            ))
        win_start += step_ns
    return windows


def percentile(values: Sequence[float], q: float) -> float:
    """Linear-interpolated percentile, q in [0, 100]. Returns 0.0 on empty
    input; max(values) when q >= 100.

    Stdlib avoided to keep this module dependency-free — easy to mirror in
    other tools (calibration script, tests) without numpy.
    """
    if not values:
        return 0.0
    if not 0.0 <= q <= 100.0:
        raise ValueError(f"percentile q must be in [0, 100], got {q}")
    s = sorted(values)
    if q >= 100.0:
        return s[-1]
    if q <= 0.0:
        return s[0]
    rank = (q / 100.0) * (len(s) - 1)
    lo = int(math.floor(rank))
    hi = int(math.ceil(rank))
    if lo == hi:
        return s[lo]
    frac = rank - lo
    return s[lo] * (1.0 - frac) + s[hi] * frac


__all__ = [
    "OhlcBar",
    "YangZhangEstimate",
    "RealizedRangeWindow",
    "yang_zhang_variance",
    "bipower_variation",
    "overlapping_realized_ranges",
    "percentile",
]
