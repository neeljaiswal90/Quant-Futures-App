"""Absorption detection — Bookmap-equivalent signal over OBS-01 + MBP1.

A bar is flagged as *absorbed* when a meaningful slug of one-sided aggression
trades against the available resting size at the dominant price without
breaking that price level. The defining pattern: institutional refill — the
offer (or bid) gets eaten, replenished, eaten again, and price holds.

The detector emits one ``AbsorptionEvent`` per qualifying bar, scored on a
weighted four-factor formula (see ``_compute_score``). A second-pass
``apply_next_bar_confirmation`` flips ``confirmed=True`` when the absorption
held into the next bar.

The full methodology — score factors, weights, hard gates, parameters, and
calibration — is documented in ``docs/absorption_methodology.md``.

Wire shape::

    trades  (OBS-01 loader output)  ─┐
                                     ├─► compute_absorption_events ─► list[AbsorptionEvent]
    mbp1    (MBP1 loader output) ────┘                                       │
                                                                             ▼
                                                          apply_next_bar_confirmation
                                                                             │
                                                                             ▼
                                                          list[AbsorptionEvent (confirmed)]
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from typing import Literal, cast

import numpy as np
import pandas as pd

from rithmic_analytics.core.contracts import ContractSpec
from rithmic_analytics.core.schema import Zone

_NS_PER_SECOND: int = 10**9
AbsorptionSide = Literal["buy_absorbed", "sell_absorbed"]


@dataclass(frozen=True, slots=True)
class AbsorptionConfig:
    """Tunable parameters for the absorption detector.

    Score weights must sum to 1.0; ``_validate()`` is called at construction.
    Tunable for production calibration without touching the algorithm.

    Attributes:
        bar_size_sec: Time-bucket width for grouping trades. Default 5s.
        max_range_ticks: Hard gate — bars with ``range_ticks > max`` are
            rejected outright (it's a breakout, not absorption). Default 4.
        mbp1_lookback_sec: Maximum staleness for the pre-bin MBP1 snapshot.
            Older → ``mbp1_stale=True``, displacement factor = 0. Default 5s.
        no_break_grace_ticks: Tick-tolerance for the "didn't break" check.
            ``bar_high <= pre_bin_ask + grace * tick_size`` qualifies as
            held. Default 1 tick (contract-aware via ``ContractSpec.tick_size``).
        volume_weight / range_weight / onesidedness_weight /
        displacement_weight: Score weights summing to 1.0.
        volume_factor_cap / displacement_factor_cap: Saturation point for
            the volume-ratio and displacement-ratio factors.
        min_emit_score: Below this, events are not returned. Default 0.5.
        min_onesidedness: Hard gate — ``|net_delta|/volume`` must clear this
            to even consider as absorption. Default 0.6.
        min_displacement: Hard gate — displacement-factor must clear this.
            Default 0.5 (= traded ≥2.5× the resting size at the cap of 5×).
    """

    bar_size_sec: int = 5
    max_range_ticks: int = 4
    mbp1_lookback_sec: int = 5
    no_break_grace_ticks: int = 1

    volume_weight: float = 0.30
    range_weight: float = 0.25
    onesidedness_weight: float = 0.20
    displacement_weight: float = 0.25

    volume_factor_cap: float = 5.0
    displacement_factor_cap: float = 5.0

    min_emit_score: float = 0.5
    min_onesidedness: float = 0.6
    min_displacement: float = 0.5

    def __post_init__(self) -> None:
        weight_sum = (
            self.volume_weight
            + self.range_weight
            + self.onesidedness_weight
            + self.displacement_weight
        )
        if abs(weight_sum - 1.0) > 1e-9:
            raise ValueError(f"absorption weights must sum to 1.0; got {weight_sum}")


@dataclass(frozen=True, slots=True)
class AbsorptionEvent:
    """One detected absorption event."""

    start_ts_ns: int
    end_ts_ns: int
    side: AbsorptionSide
    price_center: float  # bar midpoint (high + low) / 2
    dominant_price: float  # bin with most one-sided volume
    volume: int  # bar total
    net_delta: int
    range_ticks: int
    score: float  # in [0, 1]
    confirmed: bool  # next-bar held — second-pass output
    mbp1_stale: bool  # pre-bin MBP1 snapshot missing/too old
    factors: dict[str, float]  # {volume, range, onesidedness, displacement}

    def to_dict(self) -> dict[str, object]:
        return {
            "start_ts_ns": self.start_ts_ns,
            "end_ts_ns": self.end_ts_ns,
            "side": self.side,
            "price_center": self.price_center,
            "dominant_price": self.dominant_price,
            "volume": self.volume,
            "net_delta": self.net_delta,
            "range_ticks": self.range_ticks,
            "score": self.score,
            "confirmed": self.confirmed,
            "mbp1_stale": self.mbp1_stale,
            "factors": dict(self.factors),
        }


def _compute_score(factors: dict[str, float], config: AbsorptionConfig) -> float:
    """Weighted sum of the four absorption factors. Exposed for direct testing.

    Each factor ∈ [0, 1]; weights sum to 1.0 (validated in ``AbsorptionConfig``).
    """
    return (
        config.volume_weight * factors["volume"]
        + config.range_weight * factors["range"]
        + config.onesidedness_weight * factors["onesidedness"]
        + config.displacement_weight * factors["displacement"]
    )


def _aggregate_bars(
    trades: pd.DataFrame,
    contract: ContractSpec,
    bar_size_ns: int,
) -> pd.DataFrame:
    """Per-bar OHLC + delta + dominant-price aggregation."""
    event_ts = trades["event_ts_ns"].to_numpy(dtype="int64")
    bar_start_ns = (event_ts // bar_size_ns) * bar_size_ns
    df = trades.assign(_bar_start=bar_start_ns)

    bars = df.groupby("_bar_start", sort=True, observed=True).agg(
        total_volume=("quantity", "sum"),
        net_delta=("signed_qty", "sum"),
        bar_high=("price", "max"),
        bar_low=("price", "min"),
    )
    bars["range_ticks"] = (
        ((bars["bar_high"] - bars["bar_low"]) / contract.tick_size).round().astype("int64")
    )

    # Dominant price: per bar, the price level with the most signed_qty in the
    # direction of net_delta. For ties (rare in real data), idxmax picks the
    # lowest-price tied level — deterministic.
    by_price = df.groupby(["_bar_start", "price"], sort=True, observed=True)["signed_qty"].sum()

    dominant: list[float] = []
    for bar_start in bars.index:
        levels = by_price.loc[bar_start]
        # pandas-stubs types `.at[...]` very wide; bars are constructed from
        # signed_qty (int32 cumulative sum) so we know it's an integer.
        net = cast(int, bars.at[bar_start, "net_delta"])
        dominant.append(float(levels.idxmax() if net >= 0 else levels.idxmin()))
    bars["dominant_price"] = dominant

    return bars


def _attach_mbp1(
    bars: pd.DataFrame,
    mbp1: pd.DataFrame,
    lookback_sec: int,
) -> pd.DataFrame:
    """Attach pre-bin MBP1 snapshot via ``merge_asof`` (backward direction)."""
    if len(mbp1) == 0:
        out = bars.reset_index().rename(columns={"_bar_start": "event_ts_ns"})
        for col in ("ask_px_00", "ask_sz_00", "bid_px_00", "bid_sz_00"):
            out[col] = np.nan
        out["mbp1_stale"] = True
        return out

    bars_reset = bars.reset_index().rename(columns={"_bar_start": "event_ts_ns"})
    bars_reset = bars_reset.sort_values("event_ts_ns")
    mbp1_sorted = mbp1.sort_values("event_ts_ns")

    merged = pd.merge_asof(
        bars_reset,
        mbp1_sorted[["event_ts_ns", "ask_px_00", "ask_sz_00", "bid_px_00", "bid_sz_00"]],
        on="event_ts_ns",
        direction="backward",
        tolerance=pd.Timedelta(seconds=lookback_sec).value,  # in ns
    )
    merged["mbp1_stale"] = merged["ask_px_00"].isna()
    return merged


def _classify_bar(
    bar: pd.Series,
    config: AbsorptionConfig,
    contract: ContractSpec,
    session_avg_volume: float,
    bar_size_ns: int,
) -> AbsorptionEvent | None:
    """Apply the four hard gates + score for a single bar. None → no event."""
    grace_pts = config.no_break_grace_ticks * contract.tick_size

    # Hard gate 1: range
    if int(bar["range_ticks"]) > config.max_range_ticks:
        return None

    # Hard gate 3: onesidedness (placed second; cheaper than MBP1 lookup)
    total_vol = int(bar["total_volume"])
    net = int(bar["net_delta"])
    if total_vol == 0:
        return None
    onesidedness = abs(net) / total_vol
    if onesidedness < config.min_onesidedness:
        return None

    mbp1_stale = bool(bar["mbp1_stale"])

    # Side determination + hard gate 2: no-break check + reference size
    if net > 0:
        side: AbsorptionSide = "buy_absorbed"
        if not mbp1_stale:
            ask_px = float(bar["ask_px_00"])
            if float(bar["bar_high"]) > ask_px + grace_pts:
                return None  # broke above offer
            reference_size = max(int(bar["ask_sz_00"]), 1)
        else:
            reference_size = 1  # placeholder; displacement factor → max → may fail gate 4
    else:
        side = "sell_absorbed"
        if not mbp1_stale:
            bid_px = float(bar["bid_px_00"])
            if float(bar["bar_low"]) < bid_px - grace_pts:
                return None  # broke below bid
            reference_size = max(int(bar["bid_sz_00"]), 1)
        else:
            reference_size = 1

    # Factors
    volume_ratio = total_vol / max(session_avg_volume, 1.0)
    volume_factor = min(volume_ratio, config.volume_factor_cap) / config.volume_factor_cap

    range_ticks = int(bar["range_ticks"])
    range_factor = max(0.0, 1.0 - range_ticks / config.max_range_ticks)

    if mbp1_stale:
        # No resting-size context → displacement factor is zero (not max),
        # which keeps us honest: we can't verify absorption without MBP1.
        displacement_factor = 0.0
    else:
        displacement_ratio = total_vol / reference_size
        displacement_factor = (
            min(displacement_ratio, config.displacement_factor_cap) / config.displacement_factor_cap
        )

    # Hard gate 4: displacement
    if displacement_factor < config.min_displacement:
        return None

    factors = {
        "volume": volume_factor,
        "range": range_factor,
        "onesidedness": onesidedness,
        "displacement": displacement_factor,
    }
    score = _compute_score(factors, config)
    if score < config.min_emit_score:
        return None

    start_ts = int(bar["event_ts_ns"])
    return AbsorptionEvent(
        start_ts_ns=start_ts,
        end_ts_ns=start_ts + bar_size_ns,
        side=side,
        price_center=(float(bar["bar_high"]) + float(bar["bar_low"])) / 2,
        dominant_price=float(bar["dominant_price"]),
        volume=total_vol,
        net_delta=net,
        range_ticks=range_ticks,
        score=score,
        confirmed=False,  # second pass sets this
        mbp1_stale=mbp1_stale,
        factors=factors,
    )


def compute_absorption_events(
    trades: pd.DataFrame,
    mbp1: pd.DataFrame,
    contract: ContractSpec,
    *,
    config: AbsorptionConfig | None = None,
    session_avg_volume: float | None = None,
) -> list[AbsorptionEvent]:
    """Detect absorption candidates from a trade + MBP1 stream pair.

    Args:
        trades: OBS-01 loader output (``event_ts_ns``, ``price``, ``quantity``,
            ``signed_qty`` required).
        mbp1: MBP1 loader output (``event_ts_ns``, ``ask_px_00``, ``ask_sz_00``,
            ``bid_px_00``, ``bid_sz_00`` required). May be empty — every bar
            will be flagged ``mbp1_stale``.
        contract: ``ContractSpec`` for tick→points conversion.
        config: Tuning parameters. Defaults to ``AbsorptionConfig()``.
        session_avg_volume: Optional override for the per-bar volume baseline.
            If omitted, derived from the input ``trades`` (mean bar volume).
            Useful for testing and for stable multi-session aggregation.

    Returns:
        List of ``AbsorptionEvent`` ordered by ``start_ts_ns`` ascending.
        Empty if no bars qualify or input is empty. ``confirmed`` is always
        ``False`` on first pass; call :func:`apply_next_bar_confirmation` to
        flip.
    """
    config = config or AbsorptionConfig()
    if len(trades) == 0:
        return []

    bar_size_ns = config.bar_size_sec * _NS_PER_SECOND
    bars = _aggregate_bars(trades, contract, bar_size_ns)
    merged = _attach_mbp1(bars, mbp1, config.mbp1_lookback_sec)

    if session_avg_volume is None:
        session_avg_volume = float(bars["total_volume"].mean())

    events: list[AbsorptionEvent] = []
    for _, row in merged.iterrows():
        evt = _classify_bar(row, config, contract, session_avg_volume, bar_size_ns)
        if evt is not None:
            events.append(evt)

    events.sort(key=lambda e: e.start_ts_ns)
    return events


def apply_next_bar_confirmation(
    events: list[AbsorptionEvent],
    trades: pd.DataFrame,
    contract: ContractSpec,
    *,
    config: AbsorptionConfig | None = None,
) -> list[AbsorptionEvent]:
    """Second-pass confirmation: flip ``confirmed`` for events whose next bar
    didn't break the dominant price.

    For ``buy_absorbed`` events, "didn't break" means ``next_bar_high <=
    dominant_price + grace``. Symmetric for ``sell_absorbed``. Events with no
    next-bar data (end-of-capture) keep ``confirmed=False``.

    Returns:
        New list of events with ``confirmed`` updated. Original list unchanged.
    """
    config = config or AbsorptionConfig()
    bar_size_ns = config.bar_size_sec * _NS_PER_SECOND
    grace_pts = config.no_break_grace_ticks * contract.tick_size

    if len(trades) == 0:
        return list(events)

    event_ts = trades["event_ts_ns"].to_numpy(dtype="int64")
    prices = trades["price"].to_numpy(dtype="float64")

    updated: list[AbsorptionEvent] = []
    for evt in events:
        next_start = evt.end_ts_ns
        next_end = next_start + bar_size_ns
        mask = (event_ts >= next_start) & (event_ts < next_end)
        next_prices = prices[mask]
        if len(next_prices) == 0:
            updated.append(evt)
            continue

        if evt.side == "buy_absorbed":
            broke = next_prices.max() > evt.dominant_price + grace_pts
        else:
            broke = next_prices.min() < evt.dominant_price - grace_pts

        updated.append(dataclasses.replace(evt, confirmed=not broke))

    return updated


def suggest_conviction_upgrade(
    event: AbsorptionEvent,
    zones: list[Zone],
    *,
    distance_points: float = 1.0,
) -> str | None:
    """If an absorption event overlaps an HVN zone, suggest a conviction upgrade.

    Helper for downstream conviction-grading: when absorption fires at an HVN
    level, the zone is structurally stronger than its base sources indicate.

    Args:
        event: The absorption event.
        zones: Candidate zones to test for overlap.
        distance_points: Tolerance around zone band edges. Default 1.0 pt.

    Returns:
        ``"HIGH"`` if the event overlaps an HVN-sourced zone whose conviction
        is currently MED/LOW; ``None`` otherwise (already SUPER/HIGH, no
        overlap, or zone is not HVN-backed).
    """
    for zone in zones:
        if not any("hvn" in s for s in zone.sources):
            continue
        overlaps = (
            zone.bot - distance_points <= event.dominant_price <= zone.top + distance_points
        )
        if overlaps and zone.conviction in ("LOW", "MED"):
            return "HIGH"
    return None
