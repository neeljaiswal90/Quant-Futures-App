"""Template-based active posture synthesis."""

from __future__ import annotations

from typing import Any

from rithmic_dashboard.models import (
    ActivePosture,
    DashboardSession,
    DayTypeClassification,
    LiveSignals,
    OrderflowPulse,
    ScenarioState,
)


def synthesize_active_posture(
    *,
    envelope: dict[str, Any] | None,
    current_price: float | None,
    atr: float,
    scenarios: list[ScenarioState],
    pulse: OrderflowPulse | None,
    session: DashboardSession,
    live_signals: LiveSignals | None = None,
    day_type: DayTypeClassification | None = None,
) -> ActivePosture:
    """Render a three-sentence posture summary from current dashboard state."""

    title = f"ACTIVE POSTURE ({session.now_pt.strftime('%H:%M PT')})"
    if envelope is None or current_price is None:
        return ActivePosture(
            title=title,
            sentences=(
                "Current posture is unavailable because the dashboard is missing "
                "a price or zone envelope.",
                "Scenario and orderflow sections below show the specific missing data warnings.",
                "No trading action is implied by this dashboard.",
            ),
        )

    vwap = _line(envelope, "vwap_rth", default=_number(envelope.get("vpoc"), current_price))
    regime = _price_regime(envelope, current_price, vwap)
    distance_atr = (current_price - vwap) / atr if atr > 0 else 0.0
    sentence_one = (
        f"{session.session.upper()} trading {current_price:,.2f}: {regime} "
        f"({distance_atr:+.1f} ATR vs VWAP). {_regime_guidance(regime)}"
    )

    live = [
        scenario
        for scenario in scenarios
        if scenario.state in {"ACTIVE", "IN_PROGRESS", "WATCHING"}
    ]
    live = sorted(
        live,
        key=lambda scenario: (
            0 if scenario.state in {"ACTIVE", "IN_PROGRESS"} else 1,
            scenario.scenario_id,
        ),
    )
    if live:
        label = " and ".join(
            f"{scenario.scenario_id} {scenario.state} {scenario.direction}"
            f" {scenario.entry_zone_low:,.0f}-{scenario.entry_zone_high:,.0f}"
            for scenario in live[:3]
        )
        sentence_two = f"Focus scenarios: {label}. These are closest by price."
    else:
        nearest = min(scenarios, key=lambda scenario: abs(current_price - _entry_mid(scenario)))
        sentence_two = (
            f"No ACTIVE/WATCHING/IN_PROGRESS scenario; nearest template is "
            f"{nearest.scenario_id} around {_entry_mid(nearest):,.0f}."
        )

    sentence_three = _cvd_sentence(pulse, live, live_signals)
    sentences: tuple[str, ...] = (sentence_one, sentence_two, sentence_three)
    day_sentence = _day_type_sentence(day_type)
    if day_sentence is not None:
        sentences = (day_sentence, *sentences)
    vol_sentence = _volatility_sentence(live_signals)
    if vol_sentence is not None:
        sentences = (vol_sentence, *sentences)
    return ActivePosture(title=title, sentences=sentences)


def _day_type_sentence(day_type: DayTypeClassification | None) -> str | None:
    if day_type is None or day_type.status != "classified":
        return None
    label = day_type.day_type.replace("_", " ").upper()
    if (
        day_type.ib_low is None
        or day_type.ib_high is None
        or day_type.current_extension_pts is None
        or day_type.current_extension_x_ib is None
    ):
        return f"Day type: {label}. Probabilities include session-character conditioning."
    return (
        f"Day type: {label} - IB {day_type.ib_low:,.0f}-{day_type.ib_high:,.0f}, "
        f"current extension {day_type.current_extension_pts:+.0f}pt "
        f"({day_type.current_extension_x_ib:+.1f}x IB). "
        "Scenario probabilities include day-type conditioning."
    )


def _volatility_sentence(live_signals: LiveSignals | None) -> str | None:
    if live_signals is None or live_signals.volatility_regime is None:
        return None
    regime = live_signals.volatility_regime
    if regime.status != "active" or regime.ewma_sigma_pts is None:
        return None
    ratio = f"{regime.ratio:.2f}x" if regime.ratio is not None else "n/a"
    effective = (
        f", effective sigma {regime.sigma_effective_pts:.1f}pt"
        if regime.sigma_effective_pts is not None
        else ""
    )
    return (
        f"Volatility regime: {regime.regime} - EWMA sigma {regime.ewma_sigma_pts:.1f}pt "
        f"({ratio} corpus median){effective}."
    )


def _price_regime(envelope: dict[str, Any], price: float, vwap: float) -> str:
    plus1 = _line(envelope, "vwap_rth_band_p1sd", default=vwap)
    minus1 = _line(envelope, "vwap_rth_band_m1sd", default=vwap)
    plus2 = _line(envelope, "vwap_rth_band_p2sd", default=vwap + 2.0 * abs(plus1 - vwap))
    minus2 = _line(envelope, "vwap_rth_band_m2sd", default=vwap - 2.0 * abs(vwap - minus1))
    if price >= plus2:
        return "deep-above-value extension"
    if price >= plus1:
        return "upper-band extension"
    if price <= minus2:
        return "deep-below-value extension"
    if price <= minus1:
        return "lower-band test"
    return "fair-value band"


def _regime_guidance(regime: str) -> str:
    if "extension" in regime:
        return "Wait for acceptance outside value or a failed-break reversal."
    if "upper" in regime:
        return "Longs need fresh confirmation; shorts watch for rejection."
    if "lower" in regime:
        return "Shorts need fresh confirmation; longs watch for arrest."
    return "Inside value, avoid chasing; nearby levels matter more than directional conviction."


def _cvd_sentence(
    pulse: OrderflowPulse | None,
    live: list[ScenarioState],
    live_signals: LiveSignals | None,
) -> str:
    if live_signals is not None and live_signals.delta_dislocations:
        dislocation = live_signals.delta_dislocations[0]
        confidence_note = (
            " (signal confidence reduced - capture tail short)"
            if dislocation.confidence == "low_tail_span"
            else ""
        )
        return (
            f"Delta dislocation {dislocation.side} at {dislocation.level_text} "
            f"({dislocation.level_price:,.2f}); CVD {dislocation.hourly_cvd:+,}. "
            f"Matching scenarios are up-weighted.{confidence_note}"
        )

    if live_signals is not None and live_signals.institutional_flow_events:
        institutional = live_signals.institutional_flow_events[0]
        bias = "long" if institutional.side == "buy" else "short"
        confidence_note = (
            " (tail-span confidence low)"
            if institutional.confidence == "low_tail_span"
            else ""
        )
        return (
            f"Institutional flow {bias} at {institutional.level_text} "
            f"({institutional.level_price:,.2f}); net delta {institutional.net_delta:+,}, "
            f"{institutional.trade_count} trade(s), largest {institutional.largest_trade:,}."
            f"{confidence_note}"
        )

    if live_signals is not None and live_signals.iceberg_events:
        iceberg = live_signals.iceberg_events[0]
        return (
            f"Iceberg check: {iceberg.side}-side refill at {iceberg.level_text} "
            f"({iceberg.level_price:,.2f}); {iceberg.refill_count} refills, "
            f"{iceberg.total_consumed:,} consumed via OBS confirmation; "
            f"favors {iceberg.direction}."
        )

    if live_signals is not None and live_signals.aggressor_flow_events:
        event = live_signals.aggressor_flow_events[0]
        if event.event_type == "aggressor_imbalance_extreme":
            return f"Orderflow: {event.description}. Initiative is one-sided in the fast tape."
        if event.event_type == "v_delta_sign_flip":
            return f"Orderflow: {event.description}. Treat momentum direction as freshly changed."
        if event.event_type == "stacked_footprint_imbalance":
            return (
                f"Orderflow: {event.description}. "
                "Watch the stack zone for continuation or absorption."
            )

    if live_signals is not None and live_signals.cvd.last_15m_cvd is not None:
        if live_signals.cvd.momentum_flip:
            return (
                f"CVD divergence: session {live_signals.cvd.session_direction}, "
                f"last-15m {live_signals.cvd.last_15m_direction} "
                f"({live_signals.cvd.last_15m_cvd:+,}); probabilities are discounted "
                "where momentum opposes the scenario."
            )
        velocity = live_signals.velocity.state
        return (
            f"Orderflow: live CVD is {live_signals.cvd.session_direction} "
            f"({live_signals.cvd.session_cvd:+,}) with {velocity} volume velocity. "
            "Probabilities include these live multipliers."
        )

    if pulse is None or pulse.last_60m_cvd is None:
        return "Orderflow: CVD unavailable. Lean on structure until artifacts update."
    direction = _cvd_direction(pulse.last_60m_cvd)
    if not live:
        return (
            f"Last-60m CVD is {direction} ({pulse.last_60m_cvd:+,}); "
            "no nearby scenario is armed yet."
        )
    live_bias = _dominant_direction(live)
    if direction == "neutral":
        return f"Last-60m CVD is neutral ({pulse.last_60m_cvd:+,}); scenario confirmation is mixed."
    if live_bias == "mixed":
        return (
            f"Last-60m CVD is {direction} ({pulse.last_60m_cvd:+,}), "
            "while active scenario bias is mixed."
        )
    if (direction == "bullish" and live_bias == "long") or (
        direction == "bearish" and live_bias == "short"
    ):
        return (
            f"Last-60m CVD is {direction} ({pulse.last_60m_cvd:+,}), "
            "confirming the active scenario bias."
        )
    return (
        f"Last-60m CVD is {direction} ({pulse.last_60m_cvd:+,}), "
        "opposing the active scenario bias."
    )


def _cvd_direction(value: int) -> str:
    if value > 250:
        return "bullish"
    if value < -250:
        return "bearish"
    return "neutral"


def _dominant_direction(scenarios: list[ScenarioState]) -> str:
    longs = sum(1 for scenario in scenarios if scenario.direction == "long")
    shorts = sum(1 for scenario in scenarios if scenario.direction == "short")
    if longs == shorts:
        return "mixed"
    return "long" if longs >= shorts else "short"


def _entry_mid(scenario: ScenarioState) -> float:
    return (scenario.entry_zone_low + scenario.entry_zone_high) / 2.0


def _line(envelope: dict[str, Any], source: str, *, default: float) -> float:
    for line in envelope.get("reference_lines", []):
        if isinstance(line, dict) and str(line.get("source", "")) == source:
            return _number(line.get("price"), default)
    return default


def _number(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default
