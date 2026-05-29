"""Daily zone-quality scoring — RA-027.

For each zone produced for a session, classify what happened to it during the
session's price action: did price touch it? If touched, did it hold or break?

Outputs feed Neel's structural feedback loop: over a 30-session rolling
window, SUPER zones should hold 80%+, HIGH ~60%, MED ~40%, LOW ~20%. Drift
from those tiers signals either calibration drift in the VP algo or a
regime change that should change sizing.

Three layers:

1. :func:`classify_zones` — per-zone classification: ``untouched`` /
   ``held`` / ``broken`` / ``ambiguous``. Vectorised; ~50 zones × 100K
   trades runs in milliseconds.
2. :func:`score_session` — wraps the classifier and emits a
   :class:`SessionQualityReport` with per-conviction + per-role summaries.
3. :func:`aggregate_history` — rolls N session reports into a
   :class:`HistoryReport` with Wilson 95% confidence intervals on each
   conviction-tier hit-rate.

Design calls (with pointers to the pre-build sweep that produced them):

- **Functional role from price-vs-zone**, not declared ``zone.type``.
  Phase-1 zones default to ``type="support"`` regardless of price location
  (documented limitation in ``feature_reference.md``); literal-trust
  produces meaningless hit-rates. The declared type is preserved as
  ``declared_type`` for audit.
- **Internal-at-open carve-out**: if price opens inside the zone but exits
  cleanly within the first ATR-window (5 min default) and doesn't return,
  reclassify functionally based on exit direction. Otherwise leaves the
  zone as ``functional_role="internal"`` → outcome ``ambiguous``.
- **Settlement window**: a touch in the final 10 min of a session with
  no break trigger lands ``ambiguous``, not ``held``. Prevents
  late-session news wicks from polluting the hit-rate. Configurable.
- **ATR resolution order** (Q1): envelope ``atr_14`` → recompute from
  trades → contract-aware fixed (5 pts MNQ).
- **Multi-touch within a session**: ``broken`` trumps ``held`` (Q2). A
  zone touched-held-touched-broken classifies as broken.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from datetime import date
from typing import Literal

import numpy as np
import pandas as pd

from rithmic_analytics.core.contracts import ContractSpec
from rithmic_analytics.core.schema import Zone
from rithmic_analytics.features.atr import NS_5M, compute_atr_from_ticks

_LOG = logging.getLogger("rithmic_analytics.zone_quality")

_NS_PER_SECOND: int = 10**9
_DEFAULT_SETTLEMENT_WINDOW_MIN: int = 10
_DEFAULT_INTERNAL_CARVEOUT_MIN: int = 5
_REFERENCE_PRICE_FLOOR_TRADES: int = 100
_REFERENCE_PRICE_FLOOR_SECONDS: int = 60
_MIN_TRIALS_FOR_RATE: int = 5
_ATR_BREAK_MULTIPLIER: float = 0.5
_WILSON_Z_95: float = 1.96

FunctionalRole = Literal["support", "resistance", "internal"]
FinalOutcome = Literal["untouched", "held", "broken", "ambiguous"]
Conviction = Literal["SUPER", "HIGH", "MED", "LOW"]
CONVICTION_TIERS: tuple[Conviction, ...] = ("SUPER", "HIGH", "MED", "LOW")
ROLES: tuple[FunctionalRole, ...] = ("support", "resistance", "internal")
Pairing = Literal["next-day", "globex-to-rth", "same-day"]


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ZoneOutcome:
    """Per-zone classification result.

    ``functional_role`` is derived from the price-vs-zone relationship at
    session open, not ``zone.type`` — see module docstring for rationale.
    ``declared_type`` preserves ``zone.type`` for audit.

    Boolean flags follow the standard:
        - ``touched`` is always set.
        - ``held`` / ``broken`` are mutually exclusive booleans set when
          ``final_outcome in {"held", "broken"}``; both ``None`` otherwise.
    """

    zone_id: str
    declared_type: str
    functional_role: FunctionalRole
    conviction: str
    top: float
    bot: float
    touched: bool
    first_touch_ts_ns: int | None
    max_penetration_pts: float | None
    held: bool | None
    broken: bool | None
    first_break_ts_ns: int | None
    bounce_distance_pts: float | None
    continuation_distance_pts: float | None
    final_outcome: FinalOutcome
    notes: str = ""

    def to_dict(self) -> dict[str, object]:
        return {
            "zone_id": self.zone_id,
            "declared_type": self.declared_type,
            "functional_role": self.functional_role,
            "conviction": self.conviction,
            "top": self.top,
            "bot": self.bot,
            "touched": self.touched,
            "first_touch_ts_ns": self.first_touch_ts_ns,
            "max_penetration_pts": self.max_penetration_pts,
            "held": self.held,
            "broken": self.broken,
            "first_break_ts_ns": self.first_break_ts_ns,
            "bounce_distance_pts": self.bounce_distance_pts,
            "continuation_distance_pts": self.continuation_distance_pts,
            "final_outcome": self.final_outcome,
            "notes": self.notes,
        }


@dataclass(frozen=True, slots=True)
class ConvictionSummary:
    """Per-conviction counts within one session."""

    conviction: str
    n_zones: int
    n_touched: int
    n_held: int
    n_broken: int
    n_ambiguous: int
    n_untouched: int
    hit_rate: float | None  # held / (held + broken); None if denom < _MIN_TRIALS_FOR_RATE

    def to_dict(self) -> dict[str, object]:
        return {
            "conviction": self.conviction,
            "n_zones": self.n_zones,
            "n_touched": self.n_touched,
            "n_held": self.n_held,
            "n_broken": self.n_broken,
            "n_ambiguous": self.n_ambiguous,
            "n_untouched": self.n_untouched,
            "hit_rate": self.hit_rate,
        }


@dataclass(frozen=True, slots=True)
class SessionQualityReport:
    """One session's worth of classified outcomes + summary roll-ups."""

    session_id: str
    trading_date: date
    outcomes: list[ZoneOutcome]
    summary_by_conviction: dict[str, ConvictionSummary]
    summary_by_role: dict[str, ConvictionSummary]
    atr_used: float
    atr_fallback: bool
    pairing: Pairing
    reference_price: float
    settlement_window_minutes: int

    def to_dict(self) -> dict[str, object]:
        return {
            "session_id": self.session_id,
            "trading_date": self.trading_date.isoformat(),
            "outcomes": [o.to_dict() for o in self.outcomes],
            "summary_by_conviction": {
                k: v.to_dict() for k, v in self.summary_by_conviction.items()
            },
            "summary_by_role": {
                k: v.to_dict() for k, v in self.summary_by_role.items()
            },
            "atr_used": self.atr_used,
            "atr_fallback": self.atr_fallback,
            "pairing": self.pairing,
            "reference_price": self.reference_price,
            "settlement_window_minutes": self.settlement_window_minutes,
        }


@dataclass(frozen=True, slots=True)
class BinomialEstimate:
    """Wilson-score 95% confidence interval on a hit-rate."""

    n_trials: int   # = n_held + n_broken (excludes untouched + ambiguous)
    n_success: int  # = n_held
    rate: float | None
    ci_low: float
    ci_high: float
    insufficient_data: bool

    def to_dict(self) -> dict[str, object]:
        return {
            "n_trials": self.n_trials,
            "n_success": self.n_success,
            "rate": self.rate,
            "ci_low": self.ci_low,
            "ci_high": self.ci_high,
            "insufficient_data": self.insufficient_data,
        }


@dataclass(frozen=True, slots=True)
class HistoryReport:
    """Rolling-window aggregate of N :class:`SessionQualityReport`."""

    sessions_analyzed: int
    window_sessions: int
    pairing: Pairing
    hit_rate_by_conviction: dict[str, BinomialEstimate]
    avg_bounce_distance_by_conviction: dict[str, float | None]
    avg_continuation_distance_by_conviction: dict[str, float | None]
    insufficient_data_tiers: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "sessions_analyzed": self.sessions_analyzed,
            "window_sessions": self.window_sessions,
            "pairing": self.pairing,
            "hit_rate_by_conviction": {
                k: v.to_dict() for k, v in self.hit_rate_by_conviction.items()
            },
            "avg_bounce_distance_by_conviction": dict(
                self.avg_bounce_distance_by_conviction
            ),
            "avg_continuation_distance_by_conviction": dict(
                self.avg_continuation_distance_by_conviction
            ),
            "insufficient_data_tiers": list(self.insufficient_data_tiers),
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def wilson_ci(
    successes: int, trials: int, *, z: float = _WILSON_Z_95
) -> tuple[float, float]:
    """Wilson score 95% confidence interval for a binomial proportion.

    Better than the normal approximation for small N or extreme rates
    (near 0 / near 1). Used by :func:`aggregate_history`. Stdlib-only
    implementation — no scipy dependency.

    Args:
        successes: Count of success events.
        trials: Total trial count.
        z: Z-score for the desired confidence (default 1.96 = 95%).

    Returns:
        ``(ci_low, ci_high)`` — clamped to ``[0.0, 1.0]``. For ``trials=0``,
        returns the maximally uncertain ``(0.0, 1.0)``.
    """
    if trials <= 0:
        return (0.0, 1.0)
    p_hat = successes / trials
    z2 = z * z
    denom = 1.0 + z2 / trials
    centre = (p_hat + z2 / (2.0 * trials)) / denom
    spread = (
        z * math.sqrt(p_hat * (1.0 - p_hat) / trials + z2 / (4.0 * trials * trials))
    ) / denom
    return (max(0.0, centre - spread), min(1.0, centre + spread))


def _resolve_reference_price(
    ts_arr: np.ndarray, price_arr: np.ndarray
) -> float:
    """Median price over ``max(100 trades, 60 sec)`` from session open.

    Time floor protects against post-Fed-day opens that can rip 20 points
    in the first 100 prints.
    """
    if len(price_arr) == 0:
        return math.nan
    session_open_ts = int(ts_arr[0])
    sixty_sec_end = session_open_ts + _REFERENCE_PRICE_FLOOR_SECONDS * _NS_PER_SECOND
    sixty_sec_idx = int(np.searchsorted(ts_arr, sixty_sec_end, side="right"))
    ref_idx = max(_REFERENCE_PRICE_FLOOR_TRADES, sixty_sec_idx)
    ref_idx = min(ref_idx, len(price_arr))
    return float(np.median(price_arr[:ref_idx]))


def _resolve_atr(
    envelope_atr: float | None,
    trades: pd.DataFrame,
    contract: ContractSpec,
) -> tuple[float, bool]:
    """Returns ``(atr_value, atr_fallback)``.

    Resolution: envelope value → recompute → contract-aware fixed.
    ``atr_fallback`` is True iff we hit the fixed contract default.
    """
    if envelope_atr is not None and not math.isnan(envelope_atr):
        return envelope_atr, False
    if len(trades) > 0:
        recomputed = compute_atr_from_ticks(trades, period=14, bar_size_ns=NS_5M)
        if not math.isnan(recomputed):
            _LOG.info(
                f"zone_quality: envelope atr_14 was null; recomputed from trades = {recomputed:.2f}"
            )
            return recomputed, False
    # Final fallback — contract-aware (MNQ: 0.25 × 20 = 5 pts)
    fallback = contract.tick_size * 20.0
    _LOG.warning(
        f"zone_quality: ATR unavailable from envelope and trades; "
        f"falling back to {fallback:.2f} pts (= tick_size × 20)"
    )
    return fallback, True


def _classify_role_pre(reference_price: float, zone: Zone) -> FunctionalRole:
    """Initial role from reference price vs zone band. ``internal`` if inside."""
    if reference_price > zone.top:
        return "support"
    if reference_price < zone.bot:
        return "resistance"
    return "internal"


def _resolve_internal_carveout(
    zone: Zone,
    ts_arr: np.ndarray,
    price_arr: np.ndarray,
    *,
    window_minutes: int,
) -> tuple[FunctionalRole, int]:
    """Internal-at-open carve-out (~25 LOC, under the 30 LOC cap).

    If price exits the zone band cleanly within ``window_minutes`` and
    doesn't return for the rest of that window, reclassify role by exit
    direction. Returns ``(role, post_exit_start_idx)`` — when reclassified,
    ``post_exit_start_idx`` is the index of the first re-entry-or-arbitrary
    next event, so the main classifier can skip the session-open "touch".

    Returns ``("internal", 0)`` if no clean exit happens.
    """
    window_ns = window_minutes * 60 * _NS_PER_SECOND
    end_idx = int(np.searchsorted(ts_arr, int(ts_arr[0]) + window_ns, side="right"))
    window_prices = price_arr[:end_idx]
    if len(window_prices) == 0:
        return "internal", 0

    above_top = window_prices > zone.top
    below_bot = window_prices < zone.bot
    if not above_top.any() and not below_bot.any():
        return "internal", 0  # never exited

    first_above = int(np.argmax(above_top)) if above_top.any() else len(window_prices)
    first_below = int(np.argmax(below_bot)) if below_bot.any() else len(window_prices)

    if first_above < first_below:
        # Exited above first — must STAY strictly above top for the window
        # (re-entering the zone band counts as a return, not just dropping below bot)
        if (window_prices[first_above:] <= zone.top).any():
            return "internal", 0
        return "support", first_above
    # Exited below first — must STAY strictly below bot
    if (window_prices[first_below:] >= zone.bot).any():
        return "internal", 0
    return "resistance", first_below


def _classify_one_zone(
    zone: Zone,
    ts_arr: np.ndarray,
    price_arr: np.ndarray,
    *,
    reference_price: float,
    atr_break_pts: float,
    settlement_ns: int,
    internal_carveout_minutes: int,
) -> ZoneOutcome:
    """Classify one zone against the trade tape."""
    role = _classify_role_pre(reference_price, zone)
    notes = ""
    # Where to start looking for touches. Default: full tape from index 0.
    search_start_idx = 0

    if role == "internal":
        resolved, post_exit_idx = _resolve_internal_carveout(
            zone, ts_arr, price_arr,
            window_minutes=internal_carveout_minutes,
        )
        if resolved == "internal":
            # Truly stuck inside — emit ambiguous
            penetration = float(zone.top - zone.bot)
            return ZoneOutcome(
                zone_id=zone.id, declared_type=zone.type, functional_role="internal",
                conviction=zone.conviction, top=zone.top, bot=zone.bot,
                touched=True, first_touch_ts_ns=int(ts_arr[0]),
                max_penetration_pts=penetration, held=None, broken=None,
                first_break_ts_ns=None, bounce_distance_pts=None,
                continuation_distance_pts=None, final_outcome="ambiguous",
                notes="started_inside_zone",
            )
        role = resolved
        search_start_idx = post_exit_idx
        notes = "internal_at_open_carveout"

    # Touch detection (only consider trades from search_start_idx onwards)
    relevant_prices = price_arr[search_start_idx:]
    relevant_ts = ts_arr[search_start_idx:]
    in_zone = (relevant_prices >= zone.bot) & (relevant_prices <= zone.top)

    if not in_zone.any():
        return ZoneOutcome(
            zone_id=zone.id, declared_type=zone.type, functional_role=role,
            conviction=zone.conviction, top=zone.top, bot=zone.bot,
            touched=False, first_touch_ts_ns=None, max_penetration_pts=None,
            held=None, broken=None, first_break_ts_ns=None,
            bounce_distance_pts=None, continuation_distance_pts=None,
            final_outcome="untouched", notes=notes,
        )

    first_touch_local = int(np.argmax(in_zone))
    first_touch_ts = int(relevant_ts[first_touch_local])
    in_zone_prices = relevant_prices[in_zone]

    if role == "support":
        penetration = float(zone.top - in_zone_prices.min())
        break_threshold = zone.bot - atr_break_pts
        post = relevant_prices[first_touch_local:]
        post_ts = relevant_ts[first_touch_local:]
        broken_mask = post < break_threshold
    else:  # resistance
        penetration = float(in_zone_prices.max() - zone.bot)
        break_threshold = zone.top + atr_break_pts
        post = relevant_prices[first_touch_local:]
        post_ts = relevant_ts[first_touch_local:]
        broken_mask = post > break_threshold

    if broken_mask.any():
        first_break_local = int(np.argmax(broken_mask))
        first_break_ts = int(post_ts[first_break_local])
        post_break = post[first_break_local:]
        if role == "support":
            continuation = float(zone.bot - post_break.min())
        else:
            continuation = float(post_break.max() - zone.top)
        continuation = max(0.0, continuation)
        return ZoneOutcome(
            zone_id=zone.id, declared_type=zone.type, functional_role=role,
            conviction=zone.conviction, top=zone.top, bot=zone.bot,
            touched=True, first_touch_ts_ns=first_touch_ts,
            max_penetration_pts=penetration, held=False, broken=True,
            first_break_ts_ns=first_break_ts, bounce_distance_pts=None,
            continuation_distance_pts=continuation, final_outcome="broken",
            notes=notes,
        )

    # Not broken — settlement-window check
    end_ts = int(ts_arr[-1])
    time_after_touch_ns = end_ts - first_touch_ts
    if time_after_touch_ns < settlement_ns:
        ambiguous_notes = (notes + "; " if notes else "") + "settlement_window_too_short"
        return ZoneOutcome(
            zone_id=zone.id, declared_type=zone.type, functional_role=role,
            conviction=zone.conviction, top=zone.top, bot=zone.bot,
            touched=True, first_touch_ts_ns=first_touch_ts,
            max_penetration_pts=penetration, held=None, broken=None,
            first_break_ts_ns=None, bounce_distance_pts=None,
            continuation_distance_pts=None, final_outcome="ambiguous",
            notes=ambiguous_notes,
        )

    # Held — compute bounce
    if role == "support":
        bounce = max(0.0, float(post.max() - zone.top))
    else:
        bounce = max(0.0, float(zone.bot - post.min()))

    return ZoneOutcome(
        zone_id=zone.id, declared_type=zone.type, functional_role=role,
        conviction=zone.conviction, top=zone.top, bot=zone.bot,
        touched=True, first_touch_ts_ns=first_touch_ts,
        max_penetration_pts=penetration, held=True, broken=False,
        first_break_ts_ns=None, bounce_distance_pts=bounce,
        continuation_distance_pts=None, final_outcome="held", notes=notes,
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def classify_zones(
    zones: list[Zone],
    trades: pd.DataFrame,
    contract: ContractSpec,
    *,
    atr_14: float | None = None,
    settlement_window_minutes: int = _DEFAULT_SETTLEMENT_WINDOW_MIN,
    internal_carveout_minutes: int = _DEFAULT_INTERNAL_CARVEOUT_MIN,
) -> list[ZoneOutcome]:
    """Classify each zone against the trade tape.

    Args:
        zones: Zones to classify. Typically ``envelope.zones`` from a daily
            zone JSON.
        trades: OBS-01 loader output (``event_ts_ns`` ascending sorted).
        contract: :class:`ContractSpec` for the contract-aware ATR fallback.
        atr_14: Optional ATR(14) in price points. If ``None`` or NaN,
            recomputes from trades; final fallback is ``tick_size × 20``.
        settlement_window_minutes: Minimum minutes between first touch and
            end of capture for a no-break to count as ``held`` (else
            ``ambiguous``). Default 10.
        internal_carveout_minutes: Window for the internal-at-open
            carveout. Default 5.

    Returns:
        One :class:`ZoneOutcome` per zone, same order as input.

    Example:
        >>> from rithmic_analytics.core.contracts import MNQ
        >>> outcomes = classify_zones(envelope.zones, trades, MNQ,
        ...                           atr_14=envelope.atr_14)
        >>> [o for o in outcomes if o.final_outcome == "held"]
    """
    if not zones:
        return []

    if len(trades) == 0:
        return [
            ZoneOutcome(
                zone_id=z.id, declared_type=z.type, functional_role="internal",
                conviction=z.conviction, top=z.top, bot=z.bot,
                touched=False, first_touch_ts_ns=None, max_penetration_pts=None,
                held=None, broken=None, first_break_ts_ns=None,
                bounce_distance_pts=None, continuation_distance_pts=None,
                final_outcome="untouched", notes="empty_trades",
            )
            for z in zones
        ]

    ts_arr = trades["event_ts_ns"].to_numpy(dtype="int64")
    price_arr = trades["price"].to_numpy(dtype="float64")

    atr_value, _atr_fallback = _resolve_atr(atr_14, trades, contract)
    atr_break = atr_value * _ATR_BREAK_MULTIPLIER
    settlement_ns = settlement_window_minutes * 60 * _NS_PER_SECOND
    reference_price = _resolve_reference_price(ts_arr, price_arr)

    return [
        _classify_one_zone(
            z, ts_arr, price_arr,
            reference_price=reference_price,
            atr_break_pts=atr_break,
            settlement_ns=settlement_ns,
            internal_carveout_minutes=internal_carveout_minutes,
        )
        for z in zones
    ]


def _summarise(
    outcomes: list[ZoneOutcome], *, key: Literal["conviction", "functional_role"]
) -> dict[str, ConvictionSummary]:
    """Group outcomes by ``key`` and produce per-bucket counts + hit rate."""
    bucket_to_outcomes: dict[str, list[ZoneOutcome]] = {}
    for o in outcomes:
        k = getattr(o, key)
        bucket_to_outcomes.setdefault(k, []).append(o)

    result: dict[str, ConvictionSummary] = {}
    # Always include all canonical tier names when key=conviction (Neel's
    # "render empty rows explicitly" requirement)
    canonical: tuple[str, ...] = (
        CONVICTION_TIERS if key == "conviction" else ROLES
    )
    for k in canonical:
        bucket = bucket_to_outcomes.get(k, [])
        n_held = sum(1 for o in bucket if o.final_outcome == "held")
        n_broken = sum(1 for o in bucket if o.final_outcome == "broken")
        n_amb = sum(1 for o in bucket if o.final_outcome == "ambiguous")
        n_unt = sum(1 for o in bucket if o.final_outcome == "untouched")
        n_touched = sum(1 for o in bucket if o.touched)
        trials = n_held + n_broken
        hit_rate = n_held / trials if trials >= _MIN_TRIALS_FOR_RATE else None
        result[k] = ConvictionSummary(
            conviction=k, n_zones=len(bucket), n_touched=n_touched,
            n_held=n_held, n_broken=n_broken, n_ambiguous=n_amb,
            n_untouched=n_unt, hit_rate=hit_rate,
        )
    # Include any non-canonical bucket too (defensive — schema may grow)
    for k, bucket in bucket_to_outcomes.items():
        if k in result:
            continue
        n_held = sum(1 for o in bucket if o.final_outcome == "held")
        n_broken = sum(1 for o in bucket if o.final_outcome == "broken")
        n_amb = sum(1 for o in bucket if o.final_outcome == "ambiguous")
        n_unt = sum(1 for o in bucket if o.final_outcome == "untouched")
        n_touched = sum(1 for o in bucket if o.touched)
        trials = n_held + n_broken
        hit_rate = n_held / trials if trials >= _MIN_TRIALS_FOR_RATE else None
        result[k] = ConvictionSummary(
            conviction=k, n_zones=len(bucket), n_touched=n_touched,
            n_held=n_held, n_broken=n_broken, n_ambiguous=n_amb,
            n_untouched=n_unt, hit_rate=hit_rate,
        )
    return result


def _extract_trading_date(session_id: str) -> date:
    """``"mnq-2026-05-19-rth"`` → ``date(2026, 5, 19)``. Falls back to epoch."""
    parts = session_id.split("-")
    if len(parts) >= 4:
        try:
            return date.fromisoformat("-".join(parts[1:4]))
        except ValueError:
            pass
    return date(1970, 1, 1)


def score_session(
    zones: list[Zone],
    trades: pd.DataFrame,
    contract: ContractSpec,
    *,
    atr_14: float | None = None,
    settlement_window_minutes: int = _DEFAULT_SETTLEMENT_WINDOW_MIN,
    internal_carveout_minutes: int = _DEFAULT_INTERNAL_CARVEOUT_MIN,
    pairing: Pairing = "next-day",
    session_id_override: str | None = None,
    trading_date_override: date | None = None,
) -> SessionQualityReport:
    """Wrap :func:`classify_zones` and emit a :class:`SessionQualityReport`.

    ``session_id`` is taken from ``trades["session_id"].iloc[0]`` if present;
    override via kwarg for empty-trades / synthetic inputs.

    Args:
        zones, trades, contract: As :func:`classify_zones`.
        atr_14: As :func:`classify_zones`.
        settlement_window_minutes, internal_carveout_minutes: As
            :func:`classify_zones`.
        pairing: Tag carried into the report metadata so a HistoryReport
            doesn't accidentally mix pairing modes.
        session_id_override, trading_date_override: Test hooks.

    Returns:
        :class:`SessionQualityReport`.
    """
    outcomes = classify_zones(
        zones, trades, contract,
        atr_14=atr_14,
        settlement_window_minutes=settlement_window_minutes,
        internal_carveout_minutes=internal_carveout_minutes,
    )

    if session_id_override is not None:
        session_id = session_id_override
    elif len(trades) > 0 and "session_id" in trades.columns:
        sid_val = trades["session_id"].iloc[0]
        session_id = str(sid_val) if sid_val is not None else "unknown"
    else:
        session_id = "unknown"

    if trading_date_override is not None:
        trading_date = trading_date_override
    else:
        trading_date = _extract_trading_date(session_id)

    atr_value, atr_fallback = _resolve_atr(atr_14, trades, contract)
    if len(trades) == 0:
        reference_price = math.nan
    else:
        ts_arr = trades["event_ts_ns"].to_numpy(dtype="int64")
        price_arr = trades["price"].to_numpy(dtype="float64")
        reference_price = _resolve_reference_price(ts_arr, price_arr)

    return SessionQualityReport(
        session_id=session_id,
        trading_date=trading_date,
        outcomes=outcomes,
        summary_by_conviction=_summarise(outcomes, key="conviction"),
        summary_by_role=_summarise(outcomes, key="functional_role"),
        atr_used=atr_value,
        atr_fallback=atr_fallback,
        pairing=pairing,
        reference_price=reference_price,
        settlement_window_minutes=settlement_window_minutes,
    )


def aggregate_history(
    reports: list[SessionQualityReport],
    *,
    window_sessions: int = 30,
) -> HistoryReport:
    """Roll the most recent ``window_sessions`` reports into a :class:`HistoryReport`.

    Per-conviction Wilson 95% CI on hit-rate. Bounce/continuation averages
    use simple mean over the non-None values for that conviction.

    Args:
        reports: List of :class:`SessionQualityReport`. Caller decides
            ordering; we take the trailing ``window_sessions`` for the
            rolling window.
        window_sessions: How many trailing reports to include. Default 30.

    Returns:
        :class:`HistoryReport` with per-conviction estimates.

    Raises:
        ValueError: If reports use mixed pairing modes (would mix
            apples and oranges).
    """
    if not reports:
        return HistoryReport(
            sessions_analyzed=0,
            window_sessions=window_sessions,
            pairing="next-day",
            hit_rate_by_conviction={
                tier: BinomialEstimate(
                    n_trials=0, n_success=0, rate=None,
                    ci_low=0.0, ci_high=1.0, insufficient_data=True,
                )
                for tier in CONVICTION_TIERS
            },
            avg_bounce_distance_by_conviction={tier: None for tier in CONVICTION_TIERS},
            avg_continuation_distance_by_conviction={
                tier: None for tier in CONVICTION_TIERS
            },
            insufficient_data_tiers=list(CONVICTION_TIERS),
        )

    pairings = {r.pairing for r in reports}
    if len(pairings) > 1:
        raise ValueError(
            f"aggregate_history: reports use mixed pairings {pairings}; "
            f"aggregate per-pairing or use a single pairing mode upstream"
        )
    pairing: Pairing = reports[0].pairing

    window = reports[-window_sessions:]

    # Pool outcomes across the window
    pooled: list[ZoneOutcome] = []
    for r in window:
        pooled.extend(r.outcomes)

    hit_rate_by_conv: dict[str, BinomialEstimate] = {}
    bounce_by_conv: dict[str, float | None] = {}
    cont_by_conv: dict[str, float | None] = {}
    insufficient_tiers: list[str] = []

    for tier in CONVICTION_TIERS:
        tier_outcomes = [o for o in pooled if o.conviction == tier]
        n_held = sum(1 for o in tier_outcomes if o.final_outcome == "held")
        n_broken = sum(1 for o in tier_outcomes if o.final_outcome == "broken")
        n_trials = n_held + n_broken
        if n_trials < _MIN_TRIALS_FOR_RATE:
            rate = None
            insufficient_tiers.append(tier)
        else:
            rate = n_held / n_trials
        ci_low, ci_high = wilson_ci(n_held, n_trials)
        hit_rate_by_conv[tier] = BinomialEstimate(
            n_trials=n_trials, n_success=n_held, rate=rate,
            ci_low=ci_low, ci_high=ci_high,
            insufficient_data=n_trials < _MIN_TRIALS_FOR_RATE,
        )

        bounce_values = [
            o.bounce_distance_pts for o in tier_outcomes
            if o.bounce_distance_pts is not None
        ]
        bounce_by_conv[tier] = (
            sum(bounce_values) / len(bounce_values) if bounce_values else None
        )

        cont_values = [
            o.continuation_distance_pts for o in tier_outcomes
            if o.continuation_distance_pts is not None
        ]
        cont_by_conv[tier] = (
            sum(cont_values) / len(cont_values) if cont_values else None
        )

    return HistoryReport(
        sessions_analyzed=len(window),
        window_sessions=window_sessions,
        pairing=pairing,
        hit_rate_by_conviction=hit_rate_by_conv,
        avg_bounce_distance_by_conviction=bounce_by_conv,
        avg_continuation_distance_by_conviction=cont_by_conv,
        insufficient_data_tiers=insufficient_tiers,
    )
