"""Scenario template mapping and per-session state machine."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from typing import Any, cast

from rithmic_dashboard.models import (
    AdjustmentFactor,
    AuditEntry,
    DayTypeClassification,
    LiveSignals,
    ScenarioDirection,
    ScenarioLifecycle,
    ScenarioState,
)
from rithmic_dashboard.probability_adjuster import (
    MAX_FACTOR,
    MIN_FACTOR,
    ProbabilitySignalContext,
    adjust,
    get_adjustment_factors,
    uncapped_factor,
)
from rithmic_dashboard.session_state import PT

TICK_SIZE = 0.25


@dataclass(frozen=True)
class ScenarioTemplate:
    scenario_id: str
    name: str
    direction: ScenarioDirection
    entry_zone_low: float
    entry_zone_high: float
    stop: float
    target_1: float
    target_2: float | None
    target_3: float | None
    prior_prob_low: float
    prior_prob_high: float


def compute_scenario_states(
    envelope: dict[str, Any],
    current_price: float,
    atr: float,
    audit_trail: list[AuditEntry],
    scenario_store: dict[str, Any] | None = None,
    *,
    session_key: str = "",
    now_pt: datetime | None = None,
    time_into_session_pct: float = 0.0,
    live_signals: LiveSignals | None = None,
    day_type: DayTypeClassification | None = None,
) -> list[ScenarioState]:
    """Compute all scenario cards and update persisted scenario state."""

    store = scenario_store if scenario_store is not None else {}
    now = now_pt or datetime.now(PT)
    templates = _build_templates(envelope, atr, day_type=day_type)
    states: list[ScenarioState] = []
    drift = _session_drift(envelope, current_price)

    for template in templates:
        key = f"{session_key}_{template.scenario_id}" if session_key else template.scenario_id
        raw_persisted = store.get(key)
        persisted: dict[str, Any] = raw_persisted if isinstance(raw_persisted, dict) else {}
        previous_state = _stored_state(persisted)
        lifecycle, reason, outcome = _resolve_lifecycle(
            template,
            current_price=current_price,
            atr=atr,
            previous_state=previous_state,
        )
        if previous_state != lifecycle:
            audit_trail.append(
                AuditEntry(
                    timestamp_pt=now.astimezone(PT).strftime("%Y-%m-%d %H:%M:%S PT"),
                    event_type="scenario_state_change",
                    description=(
                        f"Scenario {template.scenario_id} {previous_state} -> {lifecycle}"
                        f" ({reason})"
                    ),
                    related_level_id=f"scenario-{template.scenario_id}",
                )
            )

        store[key] = {
            "state": lifecycle,
            "entry_price": _entry_mid(template),
            "last_price": current_price,
            "last_update_pt": now.astimezone(PT).isoformat(),
            "outcome": outcome,
        }
        if lifecycle in {"ACTIVE", "IN_PROGRESS"} and "entry_pt" not in persisted:
            store[key]["entry_pt"] = now.astimezone(PT).isoformat()
            store[key]["entry_ts_ns"] = None
        elif "entry_pt" in persisted:
            store[key]["entry_pt"] = persisted.get("entry_pt")
            store[key]["entry_ts_ns"] = persisted.get("entry_ts_ns")
        distance_atr = abs(current_price - _entry_mid(template)) / atr if atr > 0 else 99.0
        matches = _matches_drift(template.direction, drift)
        signal_context = ProbabilitySignalContext(
            direction=template.direction,
            entry_zone_low=template.entry_zone_low,
            entry_zone_high=template.entry_zone_high,
            live_signals=live_signals,
            confluence_method_count=_entry_confluence_method_count(envelope, template),
            day_type=day_type,
            scenario_id=template.scenario_id,
            scenario_name=template.name,
        )
        factors = get_adjustment_factors(
            distance_atr=distance_atr,
            matches_session_drift=matches,
            time_into_session_pct=time_into_session_pct,
            state=lifecycle,
            signal_context=signal_context,
        )
        adjusted = adjust(
            template.prior_prob_low,
            template.prior_prob_high,
            distance_atr=distance_atr,
            matches_session_drift=matches,
            time_into_session_pct=time_into_session_pct,
            state=lifecycle,
            signal_context=signal_context,
        )
        display_low, display_high = adjusted
        display_factors = factors
        if lifecycle == "COMPLETED" and previous_state in {"ACTIVE", "IN_PROGRESS"}:
            persisted_low = _optional_number(persisted.get("displayed_prob_low"))
            persisted_high = _optional_number(persisted.get("displayed_prob_high"))
            persisted_factors = _persisted_factors(persisted)
            if persisted_low is not None and persisted_high is not None:
                display_low, display_high = persisted_low, persisted_high
            if persisted_factors:
                display_factors = persisted_factors
        scenario_state = ScenarioState(
            scenario_id=template.scenario_id,
            name=template.name,
            direction=template.direction,
            state=lifecycle,
            entry_zone_low=template.entry_zone_low,
            entry_zone_high=template.entry_zone_high,
            stop=template.stop,
            target_1=template.target_1,
            target_2=template.target_2,
            target_3=template.target_3,
            prior_prob_low=template.prior_prob_low,
            prior_prob_high=template.prior_prob_high,
            adjusted_prob_low=display_low,
            adjusted_prob_high=display_high,
            r_multiple_t1=_r_multiple(template.direction, template, template.target_1),
            r_multiple_t2=_optional_r(template.direction, template, template.target_2),
            r_multiple_t3=_optional_r(template.direction, template, template.target_3),
            current_r=_current_r(template, current_price, lifecycle),
            adjustment_factors=display_factors,
            tooltip=_tooltip(template, display_factors),
            reason=reason,
        )
        states.append(scenario_state)
        store[key]["displayed_prob_low"] = display_low
        store[key]["displayed_prob_high"] = display_high
        store[key]["applied_multipliers"] = [
            {
                "name": factor.name,
                "multiplier": factor.multiplier,
                "reason": factor.reason,
                "trigger": factor.trigger,
                "is_structural": factor.is_structural,
            }
            for factor in display_factors
        ]

    return sorted(states, key=_scenario_sort_key)


def reset_store_for_session(scenario_store: dict[str, Any], session_key: str) -> dict[str, Any]:
    """Keep only scenario entries for the active session."""

    meta = {"_meta": {"session_key": session_key}}
    for key, value in scenario_store.items():
        if key.startswith(f"{session_key}_"):
            meta[key] = value
    return meta


def _build_templates(
    envelope: dict[str, Any],
    atr: float,
    *,
    day_type: DayTypeClassification | None = None,
) -> list[ScenarioTemplate]:
    from rithmic_dashboard.features.ib_scenarios import build_ib_templates

    vpoc = _number(envelope.get("vpoc"), 0.0)
    vah = _number(envelope.get("vah"), vpoc + 100.0)
    val = _number(envelope.get("val"), vpoc - 100.0)
    vwap = _line(envelope, "vwap_", default=vpoc)
    plus1 = _line(envelope, "_band_p1sd", default=vwap + max(30.0, vah - vpoc))
    minus1 = _line(envelope, "_band_m1sd", default=vwap - max(30.0, vpoc - val))
    plus2 = _line(envelope, "_band_p2sd", default=vwap + 2.0 * abs(plus1 - vwap))
    minus2 = _line(envelope, "_band_m2sd", default=vwap - 2.0 * abs(vwap - minus1))
    plus15 = vwap + 1.5 * abs(plus1 - vwap)
    plus25 = vwap + 2.5 * abs(plus1 - vwap)
    plus3 = vwap + 3.0 * abs(plus1 - vwap)
    all_prices = _all_prices(envelope)
    cycle_high = max([vah, plus2, *all_prices])
    rth_low = min([val, minus2, *all_prices])
    upper_confluence = _upper_confluence(envelope, vwap, fallback=plus2)
    scenario_a_entry_low = vpoc - 5.0
    scenario_a_entry_high = vpoc + 5.0
    scenario_a_stop = _cap_stop(
        "long",
        scenario_a_entry_low,
        scenario_a_entry_high,
        _scenario_a_stop(envelope, scenario_a_entry_low),
        atr,
        1.5,
    )

    b1_low = minus1 - 5.0
    b1_high = minus1 + 5.0
    b1_stop = _cap_stop("long", b1_low, b1_high, minus2 - 5.0, atr, 1.5)
    b2_low = plus1 - 5.0
    b2_high = plus1 + 5.0
    b2_stop = _cap_stop("short", b2_low, b2_high, plus2 + 5.0, atr, 1.5)
    c_low = upper_confluence - 5.0
    c_high = upper_confluence + 5.0
    c_stop = _cap_stop("short", c_low, c_high, max(c_high + 5.0, cycle_high + 10.0), atr, 0.5)
    d_low = vpoc - 10.0
    d_high = vpoc
    d_stop = _cap_stop("short", d_low, d_high, d_high + 1.5 * TICK_SIZE, atr, 0.75)
    breakout_buffer = _breakout_buffer(atr)
    e_low = c_high + breakout_buffer
    e_high = e_low + max(5.0, breakout_buffer)
    e_stop = _cap_stop("long", e_low, e_high, cycle_high - 5.0, atr, 0.75)
    e_target_1 = max(
        cycle_high + 0.272 * max(1.0, cycle_high - val),
        e_high + max(5.0, breakout_buffer),
    )
    g_low = minus2 - 5.0
    g_high = minus2 + 5.0
    g_stop = _cap_stop("long", g_low, g_high, g_low - 20.0, atr, 1.5)
    j_low = min(vah, plus1) - 2.0
    j_high = max(vah, plus1) + 2.0
    j_stop = _cap_stop("long", j_low, j_high, min(plus1, vah) - 15.0, atr, 0.75)
    m_low = plus15 - 6.0
    m_high = plus15 + 6.0
    m_stop = _cap_stop("short", m_low, m_high, plus2 + 5.0, atr, 1.0)
    l_low = plus2 - 5.0
    l_high = plus2 + 5.0
    l_stop = _cap_stop("long", l_low, l_high, plus15 - 10.0, atr, 1.0)

    templates = [
        ScenarioTemplate(
            "A",
            "Confluence reversion long",
            "long",
            scenario_a_entry_low,
            scenario_a_entry_high,
            scenario_a_stop,
            vwap,
            plus1,
            cycle_high,
            0.60,
            0.72,
        ),
        ScenarioTemplate(
            "B1",
            "VWAP magnet scalp from -1sd",
            "long",
            b1_low,
            b1_high,
            b1_stop,
            vwap,
            None,
            None,
            0.55,
            0.65,
        ),
        ScenarioTemplate(
            "B2",
            "VWAP magnet scalp from +1sd",
            "short",
            b2_low,
            b2_high,
            b2_stop,
            vwap,
            None,
            None,
            0.55,
            0.65,
        ),
        ScenarioTemplate(
            "C",
            "Cycle-high rejection fade",
            "short",
            c_low,
            c_high,
            c_stop,
            plus1,
            vwap,
            None,
            0.55,
            0.70,
        ),
        ScenarioTemplate(
            "D",
            "Breakdown short",
            "short",
            d_low,
            d_high,
            d_stop,
            val,
            rth_low,
            rth_low - 25.0,
            0.45,
            0.58,
        ),
        ScenarioTemplate(
            "E",
            "Breakout continuation above cycle high",
            "long",
            e_low,
            e_high,
            e_stop,
            e_target_1,
            _next_round_number(e_target_1),
            None,
            0.45,
            0.55,
        ),
        ScenarioTemplate(
            "G",
            "Stab-and-reverse long",
            "long",
            g_low,
            g_high,
            g_stop,
            minus1,
            vwap,
            None,
            0.55,
            0.65,
        ),
        ScenarioTemplate(
            "J",
            "VAH/+1sd continuation pullback",
            "long",
            j_low,
            j_high,
            j_stop,
            plus15,
            plus2,
            plus25,
            0.55,
            0.65,
        ),
        ScenarioTemplate(
            "M",
            "+1.5sd exhaustion fade",
            "short",
            m_low,
            m_high,
            m_stop,
            max(vah, plus1),
            vpoc,
            vwap,
            0.52,
            0.65,
        ),
        ScenarioTemplate(
            "L",
            "+2sd/30k squeeze continuation",
            "long",
            l_low,
            l_high,
            l_stop,
            plus25,
            plus3,
            _next_round_number(plus3),
            0.45,
            0.56,
        ),
    ]
    templates.extend(build_ib_templates(day_type))
    return templates


def _resolve_lifecycle(
    template: ScenarioTemplate,
    *,
    current_price: float,
    atr: float,
    previous_state: ScenarioLifecycle,
) -> tuple[ScenarioLifecycle, str, str | None]:
    if previous_state == "COMPLETED":
        return "COMPLETED", "completed earlier this session", "persisted"

    if _hit_stop(template, current_price) and previous_state in {"ACTIVE", "IN_PROGRESS"}:
        return "COMPLETED", "stop crossed", "stop_hit"
    if _hit_target(template, current_price) and previous_state in {"ACTIVE", "IN_PROGRESS"}:
        return "COMPLETED", "T1 crossed", "target_hit"

    entry_mid = _entry_mid(template)
    distance = abs(current_price - entry_mid)
    if _inside_entry(template, current_price):
        return "ACTIVE", "price inside entry zone", None
    if previous_state == "IN_PROGRESS":
        return "IN_PROGRESS", "managing open scenario", None

    if previous_state == "ACTIVE":
        if _favorable_move(template, current_price, 5.0):
            return "IN_PROGRESS", "price moved more than 5pt favorable past entry", None
        if _outside_entry_by(template, current_price, 5.0):
            return "WATCHING", "price left entry zone by more than 5pt", None
        return "ACTIVE", "price within active-zone buffer", None

    if template.scenario_id == "C" and current_price >= template.stop:
        return "DORMANT", "fade invalidated; price accepted above cycle-high zone", None

    if template.scenario_id == "E" and current_price < template.entry_zone_low:
        return "DORMANT", "breakout not confirmed; price below acceptance trigger", None

    if previous_state == "WATCHING":
        if atr > 0 and distance > 2.2 * atr:
            return "DORMANT", "price more than 2.2 ATR from entry", None
        return "WATCHING", "price within 2 ATR of entry", None

    if atr > 0 and distance <= 2.0 * atr:
        return "WATCHING", "price within 2 ATR of entry", None
    return "DORMANT", "price more than 2 ATR from entry", None


def _stored_state(value: dict[str, Any]) -> ScenarioLifecycle:
    raw = value.get("state")
    if raw in {"DORMANT", "WATCHING", "ACTIVE", "IN_PROGRESS", "COMPLETED"}:
        return cast(ScenarioLifecycle, raw)
    return "DORMANT"


def _inside_entry(template: ScenarioTemplate, current_price: float) -> bool:
    return template.entry_zone_low <= current_price <= template.entry_zone_high


def _outside_entry_by(template: ScenarioTemplate, current_price: float, points: float) -> bool:
    return (
        current_price < template.entry_zone_low - points
        or current_price > template.entry_zone_high + points
    )


def _favorable_move(template: ScenarioTemplate, current_price: float, points: float) -> bool:
    entry = _entry_mid(template)
    if template.direction == "long":
        return current_price >= entry + points
    return current_price <= entry - points


def _hit_target(template: ScenarioTemplate, current_price: float) -> bool:
    if template.direction == "long":
        return current_price >= template.target_1
    return current_price <= template.target_1


def _hit_stop(template: ScenarioTemplate, current_price: float) -> bool:
    if template.direction == "long":
        return current_price <= template.stop
    return current_price >= template.stop


def _current_r(
    template: ScenarioTemplate,
    current_price: float,
    lifecycle: ScenarioLifecycle,
) -> float:
    if lifecycle not in {"ACTIVE", "IN_PROGRESS"}:
        return 0.0
    entry = _entry_mid(template)
    risk = _risk(template)
    if risk <= 0:
        return 0.0
    if template.direction == "long":
        return (current_price - entry) / risk
    return (entry - current_price) / risk


def _r_multiple(direction: ScenarioDirection, template: ScenarioTemplate, target: float) -> float:
    entry = _entry_mid(template)
    risk = _risk(template)
    if risk <= 0:
        return 0.0
    if direction == "long":
        return (target - entry) / risk
    return (entry - target) / risk


def _optional_r(
    direction: ScenarioDirection,
    template: ScenarioTemplate,
    target: float | None,
) -> float | None:
    if target is None:
        return None
    return _r_multiple(direction, template, target)


def _risk(template: ScenarioTemplate) -> float:
    entry = _entry_mid(template)
    return abs(entry - template.stop)


def _entry_mid(template: ScenarioTemplate) -> float:
    return (template.entry_zone_low + template.entry_zone_high) / 2.0


def _scenario_a_stop(envelope: dict[str, Any], entry_zone_low: float) -> float:
    support = _nearest_zone_support_below(envelope, entry_zone_low)
    if support is None:
        support = _nearest_reference_below(envelope, entry_zone_low)
    raw = support if support is not None else entry_zone_low - 5.0
    return min(entry_zone_low - 5.0, raw)


def _cap_stop(
    direction: ScenarioDirection,
    entry_zone_low: float,
    entry_zone_high: float,
    raw_stop: float,
    atr: float,
    max_risk_atr: float,
) -> float:
    entry = (entry_zone_low + entry_zone_high) / 2.0
    max_risk = max(1.0, atr * max_risk_atr)
    if direction == "long":
        return min(entry_zone_low - TICK_SIZE, max(raw_stop, entry - max_risk))
    return max(entry_zone_high + TICK_SIZE, min(raw_stop, entry + max_risk))


def _breakout_buffer(atr: float) -> float:
    """Require acceptance beyond the fade zone before showing breakout continuation."""

    if not math.isfinite(atr) or atr <= 0:
        return 8.0
    return max(5.0, min(15.0, 0.25 * atr))


def _nearest_zone_support_below(envelope: dict[str, Any], price: float) -> float | None:
    candidates: list[float] = []
    for zone in envelope.get("zones", []):
        if not isinstance(zone, dict):
            continue
        top = _number(zone.get("top"), math.nan)
        bot = _number(zone.get("bot"), math.nan)
        if math.isfinite(top) and math.isfinite(bot) and top < price:
            candidates.append(bot)
    return max(candidates) if candidates else None


def _nearest_reference_below(envelope: dict[str, Any], price: float) -> float | None:
    candidates = [
        value
        for value in _all_reference_prices(envelope)
        if value < price and not math.isclose(value, price)
    ]
    return max(candidates) if candidates else None


def _matches_drift(direction: ScenarioDirection, drift: int) -> bool:
    return (direction == "long" and drift >= 0) or (direction == "short" and drift <= 0)


def _session_drift(envelope: dict[str, Any], current_price: float) -> int:
    vwap = _line(envelope, "vwap_", default=_number(envelope.get("vpoc"), current_price))
    if abs(current_price - vwap) < 1.0:
        return 0
    return 1 if current_price > vwap else -1


def _tooltip(template: ScenarioTemplate, factors: tuple[AdjustmentFactor, ...]) -> str:
    raw_factor = uncapped_factor(factors)
    clipped_factor = max(MIN_FACTOR, min(MAX_FACTOR, raw_factor))
    parts = [
        f"Prior {template.prior_prob_low:.0%}-{template.prior_prob_high:.0%}",
        *[
            (
                f"{f.name} x{f.multiplier:.2f}: {f.reason}"
                + (f" ({f.trigger})" if f.trigger else "")
            )
            for f in factors
        ],
        (
            f"Unclipped factor x{raw_factor:.2f} clipped to x{clipped_factor:.2f}"
            if not math.isclose(raw_factor, clipped_factor)
            else f"Total factor x{clipped_factor:.2f}"
        ),
        "Heuristic only; not empirically calibrated.",
    ]
    return " | ".join(parts)


def _persisted_factors(value: dict[str, Any]) -> tuple[AdjustmentFactor, ...]:
    raw = value.get("applied_multipliers")
    if not isinstance(raw, list):
        return ()
    factors: list[AdjustmentFactor] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            factors.append(
                AdjustmentFactor(
                    name=str(item["name"]),
                    multiplier=float(item["multiplier"]),
                    reason=str(item["reason"]),
                    trigger=str(item["trigger"]) if item.get("trigger") is not None else None,
                    is_structural=bool(item.get("is_structural", False)),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return tuple(factors)


def _optional_number(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _entry_confluence_method_count(
    envelope: dict[str, Any],
    template: ScenarioTemplate,
) -> int:
    low = template.entry_zone_low
    high = template.entry_zone_high
    methods: set[str] = set()
    for line in envelope.get("reference_lines", []):
        if not isinstance(line, dict):
            continue
        price = _number(line.get("price"), math.nan)
        if not math.isfinite(price) or not low - 5.0 <= price <= high + 5.0:
            continue
        methods.add(_method_name(str(line.get("source", ""))))
    for zone in envelope.get("zones", []):
        if not isinstance(zone, dict):
            continue
        top = _number(zone.get("top"), math.nan)
        bot = _number(zone.get("bot"), math.nan)
        if not math.isfinite(top) or not math.isfinite(bot):
            continue
        mid = (top + bot) / 2.0
        if low - 5.0 <= mid <= high + 5.0:
            sources = zone.get("sources")
            source = (
                sources[0]
                if isinstance(sources, list) and sources
                else zone.get("type", "zone")
            )
            methods.add(_method_name(str(source)))
    return len(methods)


def _method_name(source: str) -> str:
    if "vwap" in source and "band" in source:
        return "sigma"
    if "vwap" in source:
        return "vwap"
    if "hvn" in source:
        return "hvn"
    if "lvn" in source:
        return "lvn"
    return source or "zone"


def _scenario_sort_key(scenario: ScenarioState) -> tuple[int, str]:
    order = {"ACTIVE": 0, "IN_PROGRESS": 1, "WATCHING": 2, "DORMANT": 3, "COMPLETED": 4}
    return order[scenario.state], scenario.scenario_id


def _line(envelope: dict[str, Any], source_fragment: str, *, default: float) -> float:
    for line in envelope.get("reference_lines", []):
        if not isinstance(line, dict):
            continue
        source = str(line.get("source", ""))
        if source_fragment in source:
            return _number(line.get("price"), default)
    return default


def _all_prices(envelope: dict[str, Any]) -> list[float]:
    prices = _all_reference_prices(envelope)
    for zone in envelope.get("zones", []):
        if not isinstance(zone, dict):
            continue
        top = _number(zone.get("top"), math.nan)
        bot = _number(zone.get("bot"), math.nan)
        if math.isfinite(top) and math.isfinite(bot):
            prices.extend([top, bot])
    return prices


def _all_reference_prices(envelope: dict[str, Any]) -> list[float]:
    prices: list[float] = []
    for line in envelope.get("reference_lines", []):
        if isinstance(line, dict) and line.get("price") is not None:
            prices.append(_number(line.get("price"), 0.0))
    return prices


def _upper_confluence(envelope: dict[str, Any], vwap: float, *, fallback: float) -> float:
    upper = [price for price in _all_prices(envelope) if price > vwap]
    if not upper:
        return fallback
    return max(upper)


def _next_round_number(price: float) -> float:
    return math.ceil(price / 50.0) * 50.0


def _number(value: Any, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if math.isfinite(parsed) else default
