"""Transparent heuristic probability adjustment.

This is intentionally not Bayesian or empirically calibrated. It simply makes
the prompt's multiplier model visible and auditable.
"""

from __future__ import annotations

from dataclasses import dataclass

from rithmic_dashboard.models import (
    AdjustmentFactor,
    DayTypeClassification,
    DeltaDislocationEvent,
    InstitutionalFlowEvent,
    LiveSignals,
    ScenarioDirection,
    ScenarioLifecycle,
    SweepEvent,
)

MIN_FACTOR = 0.4
MAX_FACTOR = 1.6


@dataclass(frozen=True)
class ProbabilitySignalContext:
    """Live signal context for one scenario probability adjustment."""

    direction: ScenarioDirection
    entry_zone_low: float
    entry_zone_high: float
    live_signals: LiveSignals | None = None
    confluence_method_count: int = 0
    day_type: DayTypeClassification | None = None
    scenario_id: str = ""
    scenario_name: str = ""


def get_adjustment_factors(
    *,
    distance_atr: float,
    matches_session_drift: bool,
    time_into_session_pct: float,
    state: ScenarioLifecycle,
    signal_context: ProbabilitySignalContext | None = None,
) -> tuple[AdjustmentFactor, ...]:
    """Return the multiplier breakdown used by :func:`adjust`."""

    if state in {"DORMANT", "COMPLETED"}:
        return (
            AdjustmentFactor(
                name="state",
                multiplier=1.0,
                reason=f"{state} keeps the static prior range",
            ),
        )

    factors: list[AdjustmentFactor] = []
    if distance_atr < 0.25:
        factors.append(AdjustmentFactor("distance", 1.0, "inside or very near entry zone"))
    elif distance_atr < 1.0:
        factors.append(AdjustmentFactor("distance", 0.95, "within 1 ATR of setup"))
    elif distance_atr < 2.0:
        factors.append(AdjustmentFactor("distance", 0.85, "within 2 ATR of setup"))
    else:
        factors.append(AdjustmentFactor("distance", 0.6, "more than 2 ATR away"))

    if matches_session_drift:
        factors.append(AdjustmentFactor("session drift", 1.15, "scenario bias matches drift"))
    else:
        factors.append(AdjustmentFactor("session drift", 0.85, "scenario bias opposes drift"))

    if time_into_session_pct > 0.8:
        factors.append(AdjustmentFactor("time", 0.7, "late session discount"))
    else:
        factors.append(AdjustmentFactor("time", 1.0, "normal session time window"))

    if signal_context is not None:
        factors.extend(_live_signal_factors(signal_context))
        factors.extend(_day_type_factors(signal_context))

    return tuple(factors)


def adjust(
    prior_low: float,
    prior_high: float,
    *,
    distance_atr: float,
    matches_session_drift: bool,
    time_into_session_pct: float,
    state: ScenarioLifecycle,
    signal_context: ProbabilitySignalContext | None = None,
) -> tuple[float, float]:
    """Adjust a prior range with transparent heuristic multipliers."""

    factors = get_adjustment_factors(
        distance_atr=distance_atr,
        matches_session_drift=matches_session_drift,
        time_into_session_pct=time_into_session_pct,
        state=state,
        signal_context=signal_context,
    )
    multiplier = _compose_factor(factors)

    adjusted_low = max(0.05, min(0.95, prior_low * multiplier))
    adjusted_high = max(0.05, min(0.95, prior_high * multiplier))
    return adjusted_low, adjusted_high


def _compose_factor(factors: tuple[AdjustmentFactor, ...]) -> float:
    delta = sum(factor.multiplier - 1.0 for factor in factors)
    return max(MIN_FACTOR, min(MAX_FACTOR, 1.0 + delta))


def uncapped_factor(factors: tuple[AdjustmentFactor, ...]) -> float:
    """Return the raw additive composition before the global cap."""

    return 1.0 + sum(factor.multiplier - 1.0 for factor in factors)


def _live_signal_factors(context: ProbabilitySignalContext) -> list[AdjustmentFactor]:
    signals = context.live_signals
    factors: list[AdjustmentFactor] = []
    if signals is None:
        return factors

    session_cvd = signals.cvd.session_cvd
    if session_cvd is not None and abs(session_cvd) >= 500:
        cvd_supports_long = session_cvd > 0
        scenario_is_long = context.direction == "long"
        if cvd_supports_long == scenario_is_long:
            factors.append(
                AdjustmentFactor(
                    "cvd_direction_match",
                    1.20,
                    "session CVD supports scenario bias",
                    trigger=f"session CVD {session_cvd:+,}",
                )
            )
        else:
            factors.append(
                AdjustmentFactor(
                    "cvd_direction_oppose",
                    0.80,
                    "session CVD opposes scenario bias",
                    trigger=f"session CVD {session_cvd:+,}",
                )
            )

    last_15m = signals.cvd.last_15m_cvd
    if (
        session_cvd is not None
        and last_15m is not None
        and abs(session_cvd) >= 500
        and abs(last_15m) >= 250
        and (session_cvd > 0) != (last_15m > 0)
    ):
        factors.append(
            AdjustmentFactor(
                "cvd_momentum_flip",
                0.90,
                "last-15m CVD opposes session CVD",
                trigger=f"last-15m CVD {last_15m:+,}",
            )
        )

    entry_mid = (context.entry_zone_low + context.entry_zone_high) / 2.0
    dislocation = _entry_dislocation(
        signals,
        context.direction,
        context.entry_zone_low,
        context.entry_zone_high,
        entry_mid,
    )
    if dislocation is not None:
        name = (
            "delta_dislocation_at_entry_strong"
            if dislocation.is_strong
            else "delta_dislocation_at_entry"
        )
        if dislocation.is_strong:
            multiplier = 1.25 if dislocation.confidence == "low_tail_span" else 1.35
            base_reason = "strong candle/CVD dislocation at scenario entry"
        else:
            multiplier = 1.15 if dislocation.confidence == "low_tail_span" else 1.25
            base_reason = "candle/CVD dislocation at scenario entry"
        trigger = (
            f"{dislocation.side} at {dislocation.level_price:,.2f}; "
            f"60m candle {dislocation.candle_direction}, CVD {dislocation.hourly_cvd:+,}"
        )
        if dislocation.confidence == "low_tail_span":
            trigger = (
                f"{trigger}; degraded: tail spans "
                f"{dislocation.tail_span_minutes:.0f}min, not 60min"
            )
        factors.append(
            AdjustmentFactor(
                name,
                multiplier,
                base_reason,
                trigger=trigger,
                is_structural=True,
            )
        )

    institutional_events = _entry_institutional_events(
        signals,
        context.entry_zone_low,
        context.entry_zone_high,
        entry_mid,
    )
    concentration_events = [
        event
        for event in institutional_events
        if event.event_type == "institutional_concentration_detected"
    ]
    if concentration_events:
        net_delta = sum(event.net_delta for event in concentration_events)
        if net_delta != 0:
            flow_direction: ScenarioDirection = "long" if net_delta > 0 else "short"
            latest = sorted(
                concentration_events,
                key=lambda event: event.timestamp_ns or 0,
                reverse=True,
            )[0]
            confidence_note = (
                f"; low-tail confidence {latest.tail_span_minutes:.0f}min"
                if latest.confidence == "low_tail_span"
                else ""
            )
            if flow_direction == context.direction:
                factors.append(
                    AdjustmentFactor(
                        "institutional_flow_match",
                        1.20,
                        "institutional concentration aligns with scenario bias",
                        trigger=(
                            f"net institutional delta {net_delta:+,} at "
                            f"{latest.level_text}{confidence_note}"
                        ),
                        is_structural=True,
                    )
                )
            else:
                factors.append(
                    AdjustmentFactor(
                        "institutional_flow_oppose",
                        0.80,
                        "institutional concentration opposes scenario bias",
                        trigger=(
                            f"net institutional delta {net_delta:+,} at "
                            f"{latest.level_text}{confidence_note}"
                        ),
                        is_structural=True,
                    )
                )

    block = _entry_block_event(institutional_events, context.direction)
    if block is not None:
        factors.append(
            AdjustmentFactor(
                "block_trade_at_entry",
                1.15,
                "block trade at entry aligns with scenario bias",
                trigger=f"{block.side} block {block.largest_trade:,} at {block.level_text}",
                is_structural=True,
            )
        )

    sweep = _entry_sweep(signals, context.entry_zone_low, context.entry_zone_high, entry_mid)
    if sweep is not None and sweep.recovered_within_5min is False:
        factors.append(
            AdjustmentFactor(
                "recent_sweep_at_entry",
                1.10,
                "unrecovered sweep confirms level significance",
                trigger=f"{sweep.direction} sweep {sweep.level_price:,.2f}",
                is_structural=True,
            )
        )

    absorption_count = _absorption_count(signals, context.entry_zone_low, context.entry_zone_high)
    if absorption_count >= 2:
        factors.append(
            AdjustmentFactor(
                "absorption_proxy_at_entry",
                1.15,
                "repeated balanced heavy-volume defense near entry",
                trigger=f"{absorption_count} proxy events",
                is_structural=True,
            )
        )

    velocity = signals.velocity
    if velocity.state == "quiet":
        factors.append(
            AdjustmentFactor(
                "volume_velocity_quiet",
                0.85,
                "thin market degrades signal reliability",
                trigger=_velocity_trigger(velocity.ratio),
            )
        )
    elif velocity.state == "active":
        factors.append(
            AdjustmentFactor(
                "volume_velocity_active",
                1.05,
                "active participation improves signal reliability",
                trigger=_velocity_trigger(velocity.ratio),
            )
        )

    if context.confluence_method_count >= 3:
        bonus = 1.0 + 0.05 * (context.confluence_method_count - 2)
        factors.append(
            AdjustmentFactor(
                "multi_method_confluence_bonus",
                bonus,
                "entry zone has multiple independent methods agreeing",
                trigger=f"{context.confluence_method_count} methods",
                is_structural=True,
            )
        )

    return factors


def _day_type_factors(context: ProbabilitySignalContext) -> list[AdjustmentFactor]:
    day_type = context.day_type
    if day_type is None or day_type.status != "classified" or day_type.day_type == "pending":
        return []
    style = _scenario_style(context)
    direction = context.direction
    day = day_type.day_type
    multiplier = 1.0
    bias: str = direction
    if day == "trend_day_up":
        if style == "mean_reversion":
            multiplier = 0.60
            bias = "mean_reversion"
        else:
            multiplier = 1.25 if direction == "long" else 0.70
    elif day == "trend_day_down":
        if style == "mean_reversion":
            multiplier = 0.60
            bias = "mean_reversion"
        else:
            multiplier = 1.25 if direction == "short" else 0.70
    elif day == "normal_day":
        if style == "mean_reversion":
            multiplier = 1.20
            bias = "mean_reversion"
        else:
            multiplier = 1.05
    elif day == "normal_variation_up":
        if style == "mean_reversion":
            multiplier = 1.10
            bias = "mean_reversion"
        else:
            multiplier = 1.15 if direction == "long" else 0.90
    elif day == "normal_variation_down":
        if style == "mean_reversion":
            multiplier = 1.10
            bias = "mean_reversion"
        else:
            multiplier = 1.15 if direction == "short" else 0.90
    elif day == "neutral_day_extreme":
        if style == "mean_reversion":
            multiplier = 0.90
            bias = "mean_reversion"
        else:
            multiplier = 0.95
    elif day == "neutral_day_center":
        if style == "mean_reversion":
            multiplier = 1.30
            bias = "mean_reversion"
        else:
            multiplier = 0.90
    elif day == "double_distribution_up":
        if style == "mean_reversion":
            multiplier = 1.15
            bias = "mean_reversion"
        else:
            multiplier = 1.20 if direction == "long" else 0.90
    elif day == "double_distribution_down":
        if style == "mean_reversion":
            multiplier = 1.15
            bias = "mean_reversion"
        else:
            multiplier = 1.20 if direction == "short" else 0.90
    if multiplier == 1.0:
        return []
    label = day.replace("_", " ").upper()
    return [
        AdjustmentFactor(
            f"day_type_{day}_{bias}",
            multiplier,
            f"{label} structural conditioning applies after live-event factors",
            trigger=day_type.reason,
            is_structural=True,
        )
    ]


def _scenario_style(context: ProbabilitySignalContext) -> str:
    scenario_id = context.scenario_id.upper()
    name = context.scenario_name.lower()
    if scenario_id in {"A", "B1", "B2", "C", "G", "M"}:
        return "mean_reversion"
    if "fade" in name or "reversion" in name or "magnet" in name:
        return "mean_reversion"
    return "continuation"


def _entry_dislocation(
    signals: LiveSignals,
    direction: ScenarioDirection,
    low: float,
    high: float,
    entry_mid: float,
) -> DeltaDislocationEvent | None:
    matching = [
        event
        for event in signals.delta_dislocations
        if event.side == direction
        and (low <= event.level_price <= high or abs(event.level_price - entry_mid) <= 5.0)
    ]
    if not matching:
        return None
    return sorted(matching, key=lambda event: event.timestamp_ns or 0, reverse=True)[0]


def _entry_sweep(
    signals: LiveSignals,
    low: float,
    high: float,
    entry_mid: float,
) -> SweepEvent | None:
    for sweep in signals.sweeps:
        if low <= sweep.level_price <= high or abs(sweep.level_price - entry_mid) <= 5.0:
            return sweep
    return None


def _entry_institutional_events(
    signals: LiveSignals,
    low: float,
    high: float,
    entry_mid: float,
) -> list[InstitutionalFlowEvent]:
    return [
        event
        for event in signals.institutional_flow_events
        if low <= event.level_price <= high or abs(event.level_price - entry_mid) <= 5.0
    ]


def _entry_block_event(
    events: list[InstitutionalFlowEvent],
    direction: ScenarioDirection,
) -> InstitutionalFlowEvent | None:
    matching = [
        event
        for event in events
        if event.event_type == "block_trade_at_zone" and _event_direction(event) == direction
    ]
    if not matching:
        return None
    return sorted(matching, key=lambda event: event.timestamp_ns or 0, reverse=True)[0]


def _event_direction(event: InstitutionalFlowEvent) -> ScenarioDirection:
    return "long" if event.side == "buy" else "short"


def _absorption_count(signals: LiveSignals, low: float, high: float) -> int:
    return sum(1 for event in signals.absorption_proxies if low <= event.price <= high)


def _velocity_trigger(ratio: float | None) -> str:
    return "velocity ratio n/a" if ratio is None else f"velocity ratio {ratio:.2f}x"
