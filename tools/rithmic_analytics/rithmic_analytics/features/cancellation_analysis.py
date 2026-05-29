"""Tradesea cancellation pattern analytics — RA-036.

Measures Rule 7 ("post-regret window discipline") by joining
:class:`CancelledOrder` records against the live OBS-01 trade tape.
For each cancelled limit order, answers four diagnostic questions:

1. **Reached limit?** Did price print at-or-through the cancelled price
   within ``regret_window_minutes``? Tolerance configurable via
   ``regret_tolerance_ticks`` (default 1 tick — one tick away counts
   as reached).
2. **Direction**: signed `max_favorable_pts` (positive when price moved
   toward / past the limit; negative when it moved away). Direction
   enum derived: "favorable" / "unfavorable" / "neutral".
3. **Magnitude**: how far did price move in the favorable direction?
4. **Regret rebuy?** If the trader subsequently filled the same side at
   a worse price within ``rebuy_window_minutes``, flag the cancel.

Output: per-cancel :class:`CancelOutcome` + session-level
:class:`SessionSummary` carrying ``regret_cancel_rate``,
``avg_regret_pts``, ``regret_rebuy_count``. Wrapped in
:class:`CancellationAnalysisReport` with ``schema_version=1`` for
forward-compat (matches RA-035's pattern).

Direction asymmetry (per side):
    - BUY cancel at L: favorable = price went to/below L (would have
      filled at the cancelled price).
    - SELL cancel at L: favorable = price went to/above L.

"Sufficient tape" filter: a cancel near session end leaves too little
post-cancel data to be statistically meaningful. We mark
``has_sufficient_tape=False`` when `<60s` of tape after the cancel; the
session summary excludes these from the ``regret_cancel_rate``
denominator.

Cross-session boundary (e.g. cancel late in RTH whose 5-min window
extends past RTH close): ``window_truncated=True`` so consumers
interpret the "didn't reach limit" verdict with care.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Literal

import numpy as np
import pandas as pd

from rithmic_analytics.core.contracts import ContractSpec
from rithmic_analytics.core.trade_log import CancelledOrder, TradeFill

_LOG = logging.getLogger("rithmic_analytics.cancellation_analysis")

_NS_PER_SECOND: int = 10**9
_NS_PER_MINUTE: int = 60 * _NS_PER_SECOND

Direction = Literal["favorable", "unfavorable", "neutral"]
_SCHEMA_VERSION: int = 1


# ---------------------------------------------------------------------------
# Config + dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CancellationAnalysisConfig:
    """Tunable knobs for the cancellation analysis.

    Defaults match the RA-036 ticket sweep:

    - ``regret_window_minutes = 5`` — how long to look forward after a
      cancel to see if price reaches the limit.
    - ``rebuy_window_minutes = 10`` — exposed separately because rebuy
      decisions can be slower than the initial regret window.
    - ``regret_tolerance_ticks = 1`` — within 1 tick of the limit counts
      as reached. Avoids "price printed at 28,900.00, but cancel was at
      28,900.25 → didn't reach" false negatives.
    - ``min_window_seconds = 60`` — below this much post-cancel tape,
      ``has_sufficient_tape=False`` and the cancel is excluded from the
      session summary denominator.
    """

    regret_window_minutes: int = 5
    rebuy_window_minutes: int = 10
    regret_tolerance_ticks: int = 1
    min_window_seconds: int = 60


@dataclass(frozen=True, slots=True)
class CancelOutcome:
    """Per-cancel analysis result."""

    cancel_ts_ns: int
    limit_price: float | None
    side: Literal["buy", "sell"]
    reached_limit: bool
    direction: Direction
    max_favorable_pts: float | None
    """Signed: positive = price moved toward/past limit (favorable);
    negative = moved away (unfavorable). ``None`` when no tape data."""
    regret_rebuy_at_worse_price: bool
    window_truncated: bool
    """True when the regret-window extends past the input tape's last
    bar. ``reached_limit`` may be wrong in this case — consumers should
    interpret carefully."""
    has_sufficient_tape: bool
    """``False`` when ``<min_window_seconds`` of tape after cancel.
    Excluded from session-summary denominators."""
    unanalyzable_reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "cancel_ts_ns": self.cancel_ts_ns,
            "limit_price": self.limit_price,
            "side": self.side,
            "reached_limit": self.reached_limit,
            "direction": self.direction,
            "max_favorable_pts": self.max_favorable_pts,
            "regret_rebuy_at_worse_price": self.regret_rebuy_at_worse_price,
            "window_truncated": self.window_truncated,
            "has_sufficient_tape": self.has_sufficient_tape,
            "unanalyzable_reason": self.unanalyzable_reason,
        }


@dataclass(frozen=True, slots=True)
class SessionSummary:
    """Session-level roll-up of cancel outcomes.

    Excludes outcomes where ``has_sufficient_tape=False`` from the
    ``regret_cancel_rate`` denominator (statistically noisy).
    """

    n_cancels_total: int
    n_cancels_analyzed: int  # excludes unanalyzable / insufficient-tape
    n_reached_limit: int
    n_favorable: int
    n_unfavorable: int
    n_neutral: int
    n_window_truncated: int
    n_regret_rebuys: int
    regret_cancel_rate: float | None
    """``n_reached_limit / n_cancels_analyzed`` — fraction of analyzed
    cancels where price reached the limit. ``None`` when ``n_cancels_analyzed
    == 0``. **Rule 7 alarm threshold**: > 0.20 suggests discipline drift."""
    avg_regret_pts: float | None
    """Average ``max_favorable_pts`` across the favorable outcomes."""

    def to_dict(self) -> dict[str, Any]:
        return {
            "n_cancels_total": self.n_cancels_total,
            "n_cancels_analyzed": self.n_cancels_analyzed,
            "n_reached_limit": self.n_reached_limit,
            "n_favorable": self.n_favorable,
            "n_unfavorable": self.n_unfavorable,
            "n_neutral": self.n_neutral,
            "n_window_truncated": self.n_window_truncated,
            "n_regret_rebuys": self.n_regret_rebuys,
            "regret_cancel_rate": self.regret_cancel_rate,
            "avg_regret_pts": self.avg_regret_pts,
        }


@dataclass(frozen=True, slots=True)
class CancellationAnalysisReport:
    """Top-level report. ``schema_version`` for forward-compat (RA-035 pattern)."""

    schema_version: int
    per_cancel_outcomes: list[CancelOutcome]
    session_summary: SessionSummary
    config: CancellationAnalysisConfig
    trading_date: date | None = None
    sessions_covered: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "per_cancel_outcomes": [o.to_dict() for o in self.per_cancel_outcomes],
            "session_summary": self.session_summary.to_dict(),
            "metadata": {
                "regret_window_minutes": self.config.regret_window_minutes,
                "rebuy_window_minutes": self.config.rebuy_window_minutes,
                "regret_tolerance_ticks": self.config.regret_tolerance_ticks,
                "min_window_seconds": self.config.min_window_seconds,
                "trading_date": self.trading_date.isoformat() if self.trading_date else None,
                "sessions_covered": list(self.sessions_covered),
            },
        }


# ---------------------------------------------------------------------------
# Per-cancel analysis
# ---------------------------------------------------------------------------


def _reached_limit_buy(min_post: float, limit: float, tol_pts: float) -> bool:
    """For a BUY cancel: price reached the limit if it printed at or below
    ``limit + tol_pts``. One tick away counts as reached."""
    return min_post <= limit + tol_pts


def _reached_limit_sell(max_post: float, limit: float, tol_pts: float) -> bool:
    """For a SELL cancel: price reached the limit if it printed at or above
    ``limit - tol_pts``."""
    return max_post >= limit - tol_pts


def _max_favorable_pts_buy(min_post: float, limit: float) -> float:
    """For a BUY: favorable direction is price going DOWN. Returns
    ``limit - min_post`` — positive when favorable, negative when price
    only went up."""
    return limit - min_post


def _max_favorable_pts_sell(max_post: float, limit: float) -> float:
    """For a SELL: favorable direction is price going UP."""
    return max_post - limit


def _direction_from_favorable_pts(favorable_pts: float, tol_pts: float) -> Direction:
    """Classify direction based on signed favorable magnitude.

    - ``favorable_pts >= tol_pts`` → favorable (clear move toward limit)
    - ``favorable_pts <= -tol_pts`` → unfavorable (clear move away)
    - between ``±tol_pts`` → neutral (oscillation, no clear signal)
    """
    if favorable_pts >= tol_pts:
        return "favorable"
    if favorable_pts <= -tol_pts:
        return "unfavorable"
    return "neutral"


def _detect_rebuy(
    cancel: CancelledOrder,
    fills: list[TradeFill],
    *,
    rebuy_window_ns: int,
) -> bool:
    """A rebuy is a same-side fill at a worse price within ``rebuy_window_ns``.

    For a cancelled BUY at L: a subsequent BUY fill at price > L is worse.
    For a cancelled SELL at L: a subsequent SELL fill at price < L is worse.
    """
    if not fills or cancel.limit_price is None:
        return False
    window_end = cancel.cancel_ts_ns + rebuy_window_ns
    for fill in fills:
        if fill.fill_ts_ns <= cancel.cancel_ts_ns:
            continue
        if fill.fill_ts_ns > window_end:
            continue
        if fill.side != cancel.side:
            continue
        if cancel.side == "buy" and fill.price > cancel.limit_price:
            return True
        if cancel.side == "sell" and fill.price < cancel.limit_price:
            return True
    return False


def _analyze_one_cancel(
    cancel: CancelledOrder,
    ts_arr: np.ndarray,
    price_arr: np.ndarray,
    fills: list[TradeFill],
    *,
    config: CancellationAnalysisConfig,
    tol_pts: float,
) -> CancelOutcome:
    """Per-cancel analysis. ``ts_arr`` / ``price_arr`` must be sorted ascending."""
    if cancel.limit_price is None:
        return CancelOutcome(
            cancel_ts_ns=cancel.cancel_ts_ns,
            limit_price=None,
            side=cancel.side,
            reached_limit=False,
            direction="neutral",
            max_favorable_pts=None,
            regret_rebuy_at_worse_price=False,
            window_truncated=False,
            has_sufficient_tape=False,
            unanalyzable_reason="no_limit_price",
        )

    if len(ts_arr) == 0:
        return CancelOutcome(
            cancel_ts_ns=cancel.cancel_ts_ns,
            limit_price=cancel.limit_price,
            side=cancel.side,
            reached_limit=False,
            direction="neutral",
            max_favorable_pts=None,
            regret_rebuy_at_worse_price=False,
            window_truncated=False,
            has_sufficient_tape=False,
            unanalyzable_reason="empty_tape",
        )

    window_ns = config.regret_window_minutes * _NS_PER_MINUTE
    cancel_ts = cancel.cancel_ts_ns
    window_end_target = cancel_ts + window_ns

    # Find tape slice in (cancel_ts, window_end]
    # searchsorted with side="right" → first index > cancel_ts
    start_idx = int(np.searchsorted(ts_arr, cancel_ts, side="right"))
    end_idx = int(np.searchsorted(ts_arr, window_end_target, side="right"))

    last_ts_in_tape = int(ts_arr[-1])
    window_truncated = last_ts_in_tape < window_end_target

    if start_idx >= len(ts_arr):
        # No tape after cancel at all
        return CancelOutcome(
            cancel_ts_ns=cancel_ts,
            limit_price=cancel.limit_price,
            side=cancel.side,
            reached_limit=False,
            direction="neutral",
            max_favorable_pts=None,
            regret_rebuy_at_worse_price=_detect_rebuy(
                cancel, fills,
                rebuy_window_ns=config.rebuy_window_minutes * _NS_PER_MINUTE,
            ),
            window_truncated=True,
            has_sufficient_tape=False,
            unanalyzable_reason="no_tape_after_cancel",
        )

    post_prices = price_arr[start_idx:end_idx]
    if len(post_prices) == 0:
        # Same situation: no tape inside the window
        return CancelOutcome(
            cancel_ts_ns=cancel_ts,
            limit_price=cancel.limit_price,
            side=cancel.side,
            reached_limit=False,
            direction="neutral",
            max_favorable_pts=None,
            regret_rebuy_at_worse_price=_detect_rebuy(
                cancel, fills,
                rebuy_window_ns=config.rebuy_window_minutes * _NS_PER_MINUTE,
            ),
            window_truncated=window_truncated,
            has_sufficient_tape=False,
            unanalyzable_reason="no_tape_in_window",
        )

    # Insufficient-tape check: how much wall-clock tape did we actually see?
    last_observed_ts = int(ts_arr[end_idx - 1])
    observed_window_sec = (last_observed_ts - cancel_ts) / _NS_PER_SECOND
    has_sufficient = observed_window_sec >= config.min_window_seconds

    min_post = float(post_prices.min())
    max_post = float(post_prices.max())
    limit = float(cancel.limit_price)

    if cancel.side == "buy":
        reached = _reached_limit_buy(min_post, limit, tol_pts)
        fav_pts = _max_favorable_pts_buy(min_post, limit)
    else:
        reached = _reached_limit_sell(max_post, limit, tol_pts)
        fav_pts = _max_favorable_pts_sell(max_post, limit)

    direction = _direction_from_favorable_pts(fav_pts, tol_pts)

    rebuy = _detect_rebuy(
        cancel, fills,
        rebuy_window_ns=config.rebuy_window_minutes * _NS_PER_MINUTE,
    )

    return CancelOutcome(
        cancel_ts_ns=cancel_ts,
        limit_price=limit,
        side=cancel.side,
        reached_limit=reached,
        direction=direction,
        max_favorable_pts=fav_pts,
        regret_rebuy_at_worse_price=rebuy,
        window_truncated=window_truncated,
        has_sufficient_tape=has_sufficient,
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def analyze_cancellations(
    cancelled_orders: list[CancelledOrder],
    trades: pd.DataFrame,
    contract: ContractSpec,
    *,
    fills: list[TradeFill] | None = None,
    config: CancellationAnalysisConfig | None = None,
    trading_date: date | None = None,
) -> CancellationAnalysisReport:
    """Analyze cancellations against the live tape.

    Args:
        cancelled_orders: ``CancelledOrder`` records from
            :func:`rithmic_analytics.core.trade_log.load_tradesea_csv`.
            Stop / market cancels (limit_price=None) are kept in the
            output with ``unanalyzable_reason="no_limit_price"``.
        trades: OBS-01 trade tape (``event_ts_ns``, ``price`` required;
            sorted ascending). Output of
            :func:`rithmic_analytics.core.loader.load_obs01_trades`.
        contract: :class:`ContractSpec` for tick-size based tolerance.
        fills: Optional ``TradeFill`` list (the trader's own subsequent
            fills) for ``regret_rebuy_at_worse_price`` detection. When
            ``None`` or empty, the rebuy flag is always ``False`` — the
            other diagnostics still compute. (Spec signature didn't list
            fills, but criterion 4 of the spec requires them; treating
            them as an optional kwarg keeps the contract compatible
            with callers that only want regret-cancel detection.)
        config: Tuning knobs. Defaults to :class:`CancellationAnalysisConfig()`.
        trading_date: Optional metadata stamp. Derived upstream from the
            capture date when known.

    Returns:
        :class:`CancellationAnalysisReport` with per-cancel outcomes +
        session summary. Empty ``cancelled_orders`` → empty outcomes
        list + summary with all zeros (``regret_cancel_rate=None``).
    """
    config = config or CancellationAnalysisConfig()
    tol_pts = config.regret_tolerance_ticks * contract.tick_size

    if not cancelled_orders:
        return CancellationAnalysisReport(
            schema_version=_SCHEMA_VERSION,
            per_cancel_outcomes=[],
            session_summary=SessionSummary(
                n_cancels_total=0, n_cancels_analyzed=0, n_reached_limit=0,
                n_favorable=0, n_unfavorable=0, n_neutral=0,
                n_window_truncated=0, n_regret_rebuys=0,
                regret_cancel_rate=None, avg_regret_pts=None,
            ),
            config=config,
            trading_date=trading_date,
        )

    ts_arr = (
        trades["event_ts_ns"].to_numpy(dtype="int64")
        if len(trades) > 0 else np.array([], dtype="int64")
    )
    price_arr = (
        trades["price"].to_numpy(dtype="float64")
        if len(trades) > 0 else np.array([], dtype="float64")
    )

    fills = fills or []
    outcomes: list[CancelOutcome] = []
    for c in sorted(cancelled_orders, key=lambda x: x.cancel_ts_ns):
        outcomes.append(_analyze_one_cancel(
            c, ts_arr, price_arr, fills,
            config=config, tol_pts=tol_pts,
        ))

    summary = _build_session_summary(outcomes)

    sessions: list[str] = []
    if len(trades) > 0 and "session_id" in trades.columns:
        sessions = sorted({str(s) for s in trades["session_id"].dropna().unique()})

    return CancellationAnalysisReport(
        schema_version=_SCHEMA_VERSION,
        per_cancel_outcomes=outcomes,
        session_summary=summary,
        config=config,
        trading_date=trading_date,
        sessions_covered=sessions,
    )


def _build_session_summary(outcomes: list[CancelOutcome]) -> SessionSummary:
    """Roll up per-cancel outcomes. Excludes ``has_sufficient_tape=False`` from
    the ``regret_cancel_rate`` denominator (statistically noisy)."""
    n_total = len(outcomes)
    analyzed = [o for o in outcomes if o.has_sufficient_tape and not o.unanalyzable_reason]
    n_analyzed = len(analyzed)
    n_reached = sum(1 for o in analyzed if o.reached_limit)
    n_fav = sum(1 for o in analyzed if o.direction == "favorable")
    n_unfav = sum(1 for o in analyzed if o.direction == "unfavorable")
    n_neutral = sum(1 for o in analyzed if o.direction == "neutral")
    n_truncated = sum(1 for o in outcomes if o.window_truncated)
    n_rebuys = sum(1 for o in outcomes if o.regret_rebuy_at_worse_price)

    rate: float | None = None
    if n_analyzed > 0:
        rate = n_reached / n_analyzed

    fav_pts = [
        o.max_favorable_pts for o in analyzed
        if o.direction == "favorable" and o.max_favorable_pts is not None
        and not math.isnan(o.max_favorable_pts)
    ]
    avg_regret = sum(fav_pts) / len(fav_pts) if fav_pts else None

    return SessionSummary(
        n_cancels_total=n_total,
        n_cancels_analyzed=n_analyzed,
        n_reached_limit=n_reached,
        n_favorable=n_fav,
        n_unfavorable=n_unfav,
        n_neutral=n_neutral,
        n_window_truncated=n_truncated,
        n_regret_rebuys=n_rebuys,
        regret_cancel_rate=rate,
        avg_regret_pts=avg_regret,
    )
