"""Sweep detection — multiple price levels traded through in a tight burst.

A *sweep* is the inverse of absorption: aggression that *consumes* resting
liquidity across multiple price levels in a short time window. Where
absorption keeps price pinned despite heavy volume, a sweep moves price
through several levels because each level's resting size was insufficient
to halt the aggression.

Detector pipeline:
    1. Filter MBO to ``action="T"`` events with finite price.
    2. Group consecutive T events into *bursts* by **per-event gap**
       (``event_gap_max_ms``), capped at ``burst_window_max_sec`` total
       duration as a safety.
    3. For each burst: hard-gate on levels swept / duration / volume /
       one-sidedness, then score on a four-factor weighted sum (range,
       speed, displacement, one-sidedness).
    4. MBP1 confirmation in **two passes**: pre-burst (top-of-book was at
       or beyond the swept range) and post-burst (top-of-book has shifted
       past the swept range). Both flags reported separately; neither
       disqualifies but each reduces score via the displacement factor.

Direction is taken from MBO ``side`` dominance — canonical, vs noisy
price-trajectory inference.

The full methodology — defaults, score factors, hard gates, fixture-set
calibration — is documented in ``docs/sweep_methodology.md`` (companion to
``absorption_methodology.md``).
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from typing import Any, Literal, cast

import pandas as pd

from rithmic_analytics.core.contracts import ContractSpec

_NS_PER_MS: int = 10**6
_NS_PER_SECOND: int = 10**9

SweepSide = Literal["buy_sweep", "sell_sweep"]


@dataclass(frozen=True, slots=True)
class SweepConfig:
    """Tunable parameters for the sweep detector.

    Default thresholds calibrated for **MNQ** (tick=0.25 pt). ES/NQ share
    the same tick size and similar volatility regime so the defaults apply
    there too. For markets with different tick sizes or volatility, tune
    ``min_levels_swept`` and ``burst_window_max_sec`` via this dataclass.
    Per-symbol auto-tuning is intentionally NOT done — surfaced as future
    work if NQ/ES analysis shows different optima.

    Attributes:
        min_levels_swept: Hard minimum distinct price levels in a burst.
            Default 5 (= 5 ticks on MNQ = 1.25 pt).
        max_levels_swept: Hard maximum — beyond this it's a session flush,
            not a sweep. Default 50.
        event_gap_max_ms: Maximum gap between consecutive T events for the
            burst to continue. Default 200 ms.
        burst_window_max_sec: Absolute total-duration safety cap. Default 1.0.
        mbp1_pre_lookback_ms: How far before burst start to sample MBP1.
            Default 100 ms.
        mbp1_post_lookforward_ms: How far after burst end to sample MBP1.
            Default 100 ms.
        mbp1_tolerance_ms: Maximum MBP1 staleness. Default 1000 ms.
        range_weight / speed_weight / displacement_weight /
        onesidedness_weight: Score weights summing to 1.0 (validated).
        range_factor_cap: Levels-swept saturation point. Default 10.
        displacement_factor_cap: Volume-vs-resting saturation. Default 5×.
        min_emit_score: Below this, no event emitted. Default 0.5.
        min_onesidedness: Hard gate on side dominance. Default 0.5.
        min_burst_volume: Hard gate on total burst volume. Default 20.
    """

    min_levels_swept: int = 5
    max_levels_swept: int = 50
    event_gap_max_ms: int = 200
    burst_window_max_sec: float = 1.0

    mbp1_pre_lookback_ms: int = 100
    mbp1_post_lookforward_ms: int = 100
    mbp1_tolerance_ms: int = 1000

    range_weight: float = 0.35
    speed_weight: float = 0.20
    displacement_weight: float = 0.20
    onesidedness_weight: float = 0.25

    range_factor_cap: int = 10
    displacement_factor_cap: float = 5.0

    min_emit_score: float = 0.5
    min_onesidedness: float = 0.5
    min_burst_volume: int = 20

    def __post_init__(self) -> None:
        weight_sum = (
            self.range_weight
            + self.speed_weight
            + self.displacement_weight
            + self.onesidedness_weight
        )
        if abs(weight_sum - 1.0) > 1e-9:
            raise ValueError(f"sweep weights must sum to 1.0; got {weight_sum}")


@dataclass(frozen=True, slots=True)
class SweepEvent:
    """One detected sweep."""

    start_ts_ns: int
    end_ts_ns: int
    side: SweepSide
    price_low: float
    price_high: float
    levels_swept: int
    range_ticks: int
    duration_ns: int
    volume: int
    score: float
    confirmed_pre: bool
    confirmed_post: bool
    factors: dict[str, float]

    def to_dict(self) -> dict[str, Any]:
        return {
            "start_ts_ns": self.start_ts_ns,
            "end_ts_ns": self.end_ts_ns,
            "side": self.side,
            "price_low": self.price_low,
            "price_high": self.price_high,
            "levels_swept": self.levels_swept,
            "range_ticks": self.range_ticks,
            "duration_ns": self.duration_ns,
            "volume": self.volume,
            "score": self.score,
            "confirmed_pre": self.confirmed_pre,
            "confirmed_post": self.confirmed_post,
            "factors": dict(self.factors),
        }


@dataclasses.dataclass
class _Burst:
    """Internal accumulator while extending a burst."""

    rows: list[Any]  # list of pd.Series rows from the trades DataFrame

    @property
    def start_ts_ns(self) -> int:
        return int(self.rows[0].event_ts_ns)

    @property
    def end_ts_ns(self) -> int:
        return int(self.rows[-1].event_ts_ns)

    @property
    def duration_ns(self) -> int:
        return self.end_ts_ns - self.start_ts_ns


def _detect_bursts(
    trades: pd.DataFrame, config: SweepConfig
) -> list[_Burst]:
    """Group T events into bursts by per-event gap + total-duration cap."""
    event_gap_max_ns = config.event_gap_max_ms * _NS_PER_MS
    burst_window_max_ns = int(config.burst_window_max_sec * _NS_PER_SECOND)

    bursts: list[_Burst] = []
    current: list[Any] = []
    for row in trades.itertuples(index=False):
        # pandas-stubs types itertuples rows as Any; we know event_ts_ns is int64.
        row_ts = cast(int, row.event_ts_ns)
        if not current:
            current = [row]
            continue
        first_ts = cast(int, current[0].event_ts_ns)
        last_ts = cast(int, current[-1].event_ts_ns)
        gap = row_ts - last_ts
        total = row_ts - first_ts
        if gap <= event_gap_max_ns and total <= burst_window_max_ns:
            current.append(row)
        else:
            if len(current) >= 2:
                bursts.append(_Burst(rows=current))
            current = [row]
    if len(current) >= 2:
        bursts.append(_Burst(rows=current))
    return bursts


def _lookup_mbp1(
    mbp1_sorted: pd.DataFrame,
    target_ts_ns: int,
    *,
    direction: Literal["backward", "forward"],
    tolerance_ns: int,
) -> pd.Series | None:
    """Return the closest MBP1 row in the specified direction, or None if stale."""
    if len(mbp1_sorted) == 0:
        return None
    ts_arr = mbp1_sorted["event_ts_ns"].to_numpy(dtype="int64")
    if direction == "backward":
        mask = ts_arr <= target_ts_ns
        if not mask.any():
            return None
        idx = int(mask.sum()) - 1
        if target_ts_ns - int(ts_arr[idx]) > tolerance_ns:
            return None
    else:  # forward
        mask = ts_arr >= target_ts_ns
        if not mask.any():
            return None
        idx = int((~mask).sum())
        if int(ts_arr[idx]) - target_ts_ns > tolerance_ns:
            return None
    return mbp1_sorted.iloc[idx]


def _classify_burst(
    burst: _Burst,
    mbp1_sorted: pd.DataFrame,
    contract: ContractSpec,
    config: SweepConfig,
) -> SweepEvent | None:
    """Apply hard gates + MBP1 confirmation + score for a single burst."""
    # Aggregate burst stats
    prices = [float(r.price) for r in burst.rows]
    sides = [str(r.side) for r in burst.rows]
    sizes = [int(r.size) for r in burst.rows]

    price_low = min(prices)
    price_high = max(prices)
    # Levels swept = distinct tick-aligned prices
    levels_swept = len({round(p / contract.tick_size) for p in prices})
    range_ticks = round((price_high - price_low) / contract.tick_size)
    volume = sum(sizes)
    duration_ns = burst.duration_ns

    # Gate 1: levels
    if levels_swept < config.min_levels_swept or levels_swept > config.max_levels_swept:
        return None
    # Gate 2: duration (also enforced by burst-detector, redundant but explicit)
    if duration_ns > int(config.burst_window_max_sec * _NS_PER_SECOND):
        return None
    # Gate 3: volume
    if volume < config.min_burst_volume:
        return None

    # Direction from MBO side dominance
    n_a = sum(1 for s in sides if s == "A")
    n_b = sum(1 for s in sides if s == "B")
    total = n_a + n_b
    if total == 0:
        return None
    onesidedness = max(n_a, n_b) / total
    if onesidedness < config.min_onesidedness:
        return None
    side: SweepSide = "buy_sweep" if n_a >= n_b else "sell_sweep"

    # MBP1 lookups
    tolerance_ns = config.mbp1_tolerance_ms * _NS_PER_MS
    pre_ts = burst.start_ts_ns - config.mbp1_pre_lookback_ms * _NS_PER_MS
    post_ts = burst.end_ts_ns + config.mbp1_post_lookforward_ms * _NS_PER_MS
    pre_row = _lookup_mbp1(mbp1_sorted, pre_ts, direction="backward", tolerance_ns=tolerance_ns)
    post_row = _lookup_mbp1(mbp1_sorted, post_ts, direction="forward", tolerance_ns=tolerance_ns)

    confirmed_pre = _check_pre_confirm(side, price_low, price_high, pre_row)
    confirmed_post = _check_post_confirm(side, price_low, price_high, post_row)

    # Factors
    range_factor = min(levels_swept / config.range_factor_cap, 1.0)
    burst_window_ns = int(config.burst_window_max_sec * _NS_PER_SECOND)
    speed_factor = max(0.0, 1.0 - duration_ns / burst_window_ns)

    if pre_row is None:
        displacement_factor = 0.0
    else:
        resting = int(pre_row.ask_sz_00) if side == "buy_sweep" else int(pre_row.bid_sz_00)
        if resting <= 0:
            displacement_factor = 0.0
        else:
            displacement_factor = (
                min(volume / resting, config.displacement_factor_cap)
                / config.displacement_factor_cap
            )

    factors = {
        "range": range_factor,
        "speed": speed_factor,
        "displacement": displacement_factor,
        "onesidedness": onesidedness,
    }
    score = _compute_score(factors, config)
    if score < config.min_emit_score:
        return None

    return SweepEvent(
        start_ts_ns=burst.start_ts_ns,
        end_ts_ns=burst.end_ts_ns,
        side=side,
        price_low=price_low,
        price_high=price_high,
        levels_swept=levels_swept,
        range_ticks=range_ticks,
        duration_ns=duration_ns,
        volume=volume,
        score=score,
        confirmed_pre=confirmed_pre,
        confirmed_post=confirmed_post,
        factors=factors,
    )


def _check_pre_confirm(
    side: SweepSide, price_low: float, price_high: float, pre_row: pd.Series | None
) -> bool:
    """True iff pre-burst top-of-book was at or beyond the swept range."""
    if pre_row is None:
        return False
    if side == "buy_sweep":
        return float(pre_row.ask_px_00) <= price_high
    return float(pre_row.bid_px_00) >= price_low


def _check_post_confirm(
    side: SweepSide, price_low: float, price_high: float, post_row: pd.Series | None
) -> bool:
    """True iff post-burst top-of-book has shifted past the swept range."""
    if post_row is None:
        return False
    if side == "buy_sweep":
        # Buy sweep cleared the offer stack → new bid sits at or above the
        # highest swept price.
        return float(post_row.bid_px_00) >= price_high
    return float(post_row.ask_px_00) <= price_low


def _compute_score(factors: dict[str, float], config: SweepConfig) -> float:
    """Weighted sum of the four sweep factors. Exposed for direct testing."""
    return (
        config.range_weight * factors["range"]
        + config.speed_weight * factors["speed"]
        + config.displacement_weight * factors["displacement"]
        + config.onesidedness_weight * factors["onesidedness"]
    )


def detect_sweeps(
    mbo: pd.DataFrame,
    mbp1: pd.DataFrame,
    contract: ContractSpec,
    *,
    config: SweepConfig | None = None,
) -> list[SweepEvent]:
    """Detect sweep events from an MBO + MBP1 stream pair.

    Args:
        mbo: MBO loader output. Required columns: ``event_ts_ns`` (int64),
            ``action`` (category, ``"T"`` filtered), ``side`` (category,
            ``"A"`` or ``"B"``), ``price`` (float64, NaN-tolerated), ``size``
            (int).
        mbp1: MBP1 loader output. Required columns: ``event_ts_ns`` (int64),
            ``ask_px_00`` / ``ask_sz_00`` / ``bid_px_00`` / ``bid_sz_00``.
            May be empty — confirmation flags will be ``False`` and the
            displacement factor will be 0.
        contract: ``ContractSpec`` for tick-aligned price bucketing.
        config: Tuning parameters. Defaults to ``SweepConfig()``.

    Returns:
        List of ``SweepEvent`` ordered by ``start_ts_ns``. Empty if no
        bursts qualify or input is empty.

    Example:
        >>> from rithmic_analytics.core.contracts import MNQ
        >>> from rithmic_analytics.core.loader import load_mbo, load_mbp1
        >>> mbo = load_mbo(Path("mbo.jsonl"))
        >>> mbp1 = load_mbp1(Path("mbp1.jsonl"))
        >>> sweeps = detect_sweeps(mbo, mbp1, MNQ)
    """
    config = config or SweepConfig()
    if len(mbo) == 0:
        return []

    trades = mbo[(mbo["action"] == "T") & mbo["price"].notna()].sort_values("event_ts_ns")
    if len(trades) < 2:
        return []

    mbp1_sorted = mbp1.sort_values("event_ts_ns").reset_index(drop=True) if len(mbp1) else mbp1

    bursts = _detect_bursts(trades, config)
    events: list[SweepEvent] = []
    for burst in bursts:
        evt = _classify_burst(burst, mbp1_sorted, contract, config)
        if evt is not None:
            events.append(evt)
    events.sort(key=lambda e: e.start_ts_ns)
    return events
