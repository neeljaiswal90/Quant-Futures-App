"""Jinja-backed HTML renderer for the static dashboard."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from jinja2 import Environment, PackageLoader, select_autoescape

from rithmic_dashboard.features.multi_signal_stack_alert import build_multi_signal_stack_alerts
from rithmic_dashboard.features.recent_signals_panel import build_recent_signals
from rithmic_dashboard.features.zone_signal_badges import build_zone_signal_badges
from rithmic_dashboard.models import (
    ActivePosture,
    AuditEntry,
    ConfluenceGroup,
    DashboardSession,
    DataWarning,
    DayTypeClassification,
    LevelDistance,
    LiveSignals,
    OrderflowPulse,
    PriceSnapshot,
    ScenarioState,
    SessionSignals,
    VolatilityRegime,
)


def render_dashboard(
    *,
    envelope: dict[str, Any] | None,
    current_price: float | None,
    price_snapshot: PriceSnapshot,
    distances: list[LevelDistance],
    scenarios: list[ScenarioState],
    confluence: list[ConfluenceGroup],
    signals: SessionSignals | None,
    audit: list[AuditEntry],
    orderflow_pulse: OrderflowPulse | None,
    active_posture: ActivePosture | None,
    session_state: DashboardSession,
    warnings: list[DataWarning],
    zones_path: Path | None,
    output_path: Path,
    live_signals: LiveSignals | None = None,
    day_type: DayTypeClassification | None = None,
    paused: bool = False,
) -> str:
    """Render the full self-contained dashboard HTML."""

    env = _environment()
    template = env.get_template("dashboard.html.j2")
    selected_distances = _select_distance_rows(distances)
    recent_signals = build_recent_signals(
        live_dir=output_path.parent.parent / "live_analysis",
        session=session_state,
        audit=audit,
        scenarios=scenarios,
        levels=distances,
        now_pt=session_state.now_pt,
    )
    stack_alerts = build_multi_signal_stack_alerts(
        recent_signals=recent_signals,
        current_price=current_price,
    )
    zone_signal_badges = build_zone_signal_badges(
        distances=selected_distances,
        recent_signals=recent_signals,
        stack_alerts=stack_alerts,
    )
    return template.render(
        envelope=envelope,
        current_price=current_price,
        price_snapshot=price_snapshot,
        distances=selected_distances,
        scenarios=scenarios,
        top_scenarios=_top_scenarios(scenarios, current_price),
        confluence=confluence,
        confluence_cards=_confluence_cards(confluence, current_price),
        signals=signals,
        audit=list(reversed(audit[-20:])),
        orderflow_pulse=orderflow_pulse,
        live_signals=live_signals,
        day_type=day_type,
        volatility_regime=_volatility_regime(live_signals),
        recent_signals=recent_signals,
        stack_alerts=stack_alerts,
        zone_signal_badges=zone_signal_badges,
        active_posture=active_posture,
        market_summary=_market_summary(envelope, current_price, orderflow_pulse, live_signals),
        session_state=session_state,
        warnings=warnings,
        blocking_warnings=_warning_chips(
            [warning for warning in warnings if warning.severity == "fail"]
        ),
        data_caveats=_warning_chips(
            [warning for warning in warnings if warning.severity != "fail"]
        ),
        zones_path=zones_path,
        output_path=output_path,
        paused=paused,
        generated_at=session_state.now_pt,
    )


def render_error_page(
    *,
    title: str,
    message: str,
    output_path: Path,
    now_pt: datetime,
    last_good: str | None = None,
) -> str:
    """Render a minimal fail-open page when the normal template fails."""

    env = _environment()
    template = env.get_template("dashboard.html.j2")
    warning = DataWarning("fail", message)
    return template.render(
        envelope=None,
        current_price=None,
        price_snapshot=None,
        distances=[],
        scenarios=[],
        top_scenarios=[],
        confluence=[],
        confluence_cards=[],
        signals=None,
        audit=[],
        orderflow_pulse=None,
        live_signals=None,
        day_type=None,
        volatility_regime=None,
        recent_signals=[],
        stack_alerts=[],
        zone_signal_badges={},
        active_posture=None,
        market_summary={"label": "Unavailable", "tone": "neutral", "detail": "Missing data."},
        session_state=None,
        warnings=[warning],
        blocking_warnings=_warning_chips([warning]),
        data_caveats=[],
        zones_path=None,
        output_path=output_path,
        paused=False,
        generated_at=now_pt,
        error_title=title,
        error_message=message,
        last_good=last_good,
    )


def _volatility_regime(live_signals: LiveSignals | None) -> VolatilityRegime | None:
    if live_signals is None:
        return None
    return live_signals.volatility_regime


def _environment() -> Environment:
    env = Environment(
        loader=PackageLoader("rithmic_dashboard", "templates"),
        autoescape=select_autoescape(["html", "j2"]),
    )
    env.filters["price"] = _fmt_price
    env.filters["pct"] = _fmt_pct
    env.filters["signed"] = _fmt_signed
    env.filters["r"] = _fmt_r
    env.filters["age"] = _fmt_age
    return env


def _select_distance_rows(distances: list[LevelDistance]) -> list[LevelDistance]:
    required_sources = {
        "vwap_rth",
        "vwap_rth_band_p1sd",
        "vwap_rth_band_m1sd",
        "vwap_rth_band_p2sd",
        "vwap_rth_band_m2sd",
    }
    selected: dict[str, LevelDistance] = {row.level_id: row for row in distances[:15]}
    for row in distances:
        if row.source in required_sources:
            selected[row.level_id] = row
    return sorted(selected.values(), key=lambda row: abs(row.distance_pts))


def _warning_chips(warnings: list[DataWarning]) -> list[dict[str, str]]:
    seen: set[str] = set()
    chips: list[dict[str, str]] = []
    for warning in warnings:
        if warning.message in seen:
            continue
        seen.add(warning.message)
        label, detail = _warning_copy(warning.message)
        chips.append(
            {
                "severity": warning.severity,
                "label": label,
                "detail": detail,
                "message": warning.message,
            }
        )
    return chips


def _warning_copy(message: str) -> tuple[str, str]:
    if message.startswith("ATR missing"):
        return (
            "ATR fallback",
            "Partial-session zones do not have enough bars for ATR yet; using the 5pt fallback.",
        )
    if message.startswith("Dislocation threshold missing"):
        return (
            "Dislocation fallback",
            "Delta-dislocation calibration is not written yet; "
            "using the default 500 CVD threshold.",
        )
    if message.startswith("Live signals unavailable"):
        return ("Live signal gap", message)
    if message.startswith("CVD unavailable"):
        return ("CVD artifact missing", message)
    if message.startswith("Spread unavailable"):
        return ("Spread artifact missing", message)
    if message.startswith("Absorption unavailable"):
        return ("Absorption artifact missing", message)
    if message.startswith("Capture file missing"):
        return ("Capture missing", message)
    if message.startswith("No trade print found"):
        return ("Stale live price", message)
    if message.startswith("Using VPOC"):
        return ("Price fallback", message)
    if message.startswith("Zones JSON is"):
        return ("Stale zones", message)
    return ("Data caveat", message)


def _top_scenarios(
    scenarios: list[ScenarioState],
    current_price: float | None,
) -> list[dict[str, Any]]:
    if current_price is None:
        return []
    state_rank = {"ACTIVE": 0, "IN_PROGRESS": 0, "WATCHING": 1, "DORMANT": 2, "COMPLETED": 4}
    ranked = sorted(
        scenarios,
        key=lambda scenario: (
            state_rank.get(scenario.state, 3),
            abs(current_price - _entry_mid(scenario)),
            scenario.scenario_id,
        ),
    )
    cards: list[dict[str, Any]] = []
    for scenario in ranked[:2]:
        entry_mid = _entry_mid(scenario)
        signed_distance = entry_mid - current_price
        if abs(signed_distance) < 0.25:
            distance_text = "at entry"
        elif signed_distance > 0:
            distance_text = f"{signed_distance:.1f} pts above"
        else:
            distance_text = f"{abs(signed_distance):.1f} pts below"
        cards.append(
            {
                "scenario": scenario,
                "distance_text": distance_text,
                "entry_mid": entry_mid,
                "probability": (
                    f"{scenario.adjusted_prob_low:.0%}-{scenario.adjusted_prob_high:.0%}"
                ),
            }
        )
    return cards


def _market_summary(
    envelope: dict[str, Any] | None,
    current_price: float | None,
    pulse: OrderflowPulse | None,
    live_signals: LiveSignals | None,
) -> dict[str, str]:
    if envelope is None or current_price is None:
        return {
            "label": "Regime unavailable",
            "tone": "neutral",
            "detail": "Need current price and zone envelope.",
        }
    vpoc = _number(envelope.get("vpoc"), current_price)
    vwap = _line_price(envelope, "vwap_", vpoc)
    plus1 = _line_price(envelope, "_band_p1sd", vwap)
    minus1 = _line_price(envelope, "_band_m1sd", vwap)
    plus2 = _line_price(envelope, "_band_p2sd", vwap + 2.0 * abs(plus1 - vwap))
    minus2 = _line_price(envelope, "_band_m2sd", vwap - 2.0 * abs(vwap - minus1))

    if current_price >= plus2:
        regime = "Above Value Extension"
        regime_detail = "Price is stretched above the upper value band."
    elif current_price >= plus1:
        regime = "Upper Value Test"
        regime_detail = "Price is probing the upper edge of accepted value."
    elif current_price <= minus2:
        regime = "Below Value Extension"
        regime_detail = "Price is stretched below the lower value band."
    elif current_price <= minus1:
        regime = "Lower Value Test"
        regime_detail = "Price is probing the lower edge of accepted value."
    else:
        regime = "Fair Value Auction"
        regime_detail = "Price is inside the main accepted value band."

    cvd = (
        live_signals.cvd.last_15m_cvd
        if live_signals is not None and live_signals.cvd.last_15m_cvd is not None
        else pulse.last_60m_cvd
        if pulse is not None
        else None
    )
    if current_price > vwap and (cvd is None or cvd >= -250):
        trend = "Bullish/Mixed"
        tone = "bull"
    elif current_price < vwap and (cvd is None or cvd <= 250):
        trend = "Bearish/Mixed"
        tone = "bear"
    else:
        trend = "Mixed"
        tone = "neutral"
    cvd_label = "last-15m CVD" if live_signals is not None else "last-60m CVD"
    cvd_text = "CVD unavailable" if cvd is None else f"{cvd_label} {cvd:+,}"
    return {
        "label": f"{regime} / {trend}",
        "tone": tone,
        "detail": f"{regime_detail} VWAP {vwap:,.2f}; {cvd_text}.",
    }


def _confluence_cards(
    groups: list[ConfluenceGroup],
    current_price: float | None,
) -> list[dict[str, Any]]:
    cards: list[dict[str, Any]] = []
    for group in groups:
        methods = sorted({_method_label(level.source) for level in group.levels})
        if current_price is None:
            relation = "price unavailable"
            read = "Use after live price is available."
            distance = None
        else:
            distance = group.center_price - current_price
            if abs(distance) < 2.0:
                relation = "at current price"
                read = "Decision area: price is trading inside this cluster."
            elif distance > 0:
                relation = f"{distance:.1f} pts overhead"
                read = "Potential resistance or target if price rallies into it."
            else:
                relation = f"{abs(distance):.1f} pts below"
                read = "Potential support or target if price sells into it."
        level_text = " + ".join(methods)
        cards.append(
            {
                "group": group,
                "methods": methods,
                "level_text": level_text,
                "relation": relation,
                "read": read,
                "distance": distance,
            }
        )
    return sorted(
        cards,
        key=lambda card: (
            0 if card["distance"] is not None else 1,
            abs(float(card["distance"] or 0.0)),
        ),
    )


def _entry_mid(scenario: ScenarioState) -> float:
    return (scenario.entry_zone_low + scenario.entry_zone_high) / 2.0


def _line_price(envelope: dict[str, Any], source_fragment: str, default: float) -> float:
    for line in envelope.get("reference_lines", []):
        if isinstance(line, dict) and source_fragment in str(line.get("source", "")):
            return _number(line.get("price"), default)
    return default


def _method_label(source: str) -> str:
    if "vwap" in source and "band" in source:
        if "p2sd" in source:
            return "+2sd band"
        if "p1sd" in source:
            return "+1sd band"
        if "m2sd" in source:
            return "-2sd band"
        if "m1sd" in source:
            return "-1sd band"
        return "VWAP band"
    if "vwap" in source:
        return "VWAP"
    if source == "vpoc":
        return "VPOC"
    if source == "vah":
        return "VAH"
    if source == "val":
        return "VAL"
    if "hvn" in source:
        return "HVN"
    if "lvn" in source:
        return "LVN"
    return source.replace("_", " ").upper()


def _number(value: Any, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed


def _fmt_price(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:,.2f}".rstrip("0").rstrip(".")


def _fmt_pct(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:.0%}"


def _fmt_signed(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:+,.2f}".rstrip("0").rstrip(".")


def _fmt_r(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:.2f}R"


def _fmt_age(value: datetime | None) -> str:
    if value is None:
        return "unknown"
    return value.strftime("%Y-%m-%d %H:%M:%S PT")
