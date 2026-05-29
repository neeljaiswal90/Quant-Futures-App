"""Recent live signal aggregation for the dashboard prominence panel."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from rithmic_dashboard.features.absorption_proxy import load_absorption_proxy_events
from rithmic_dashboard.features.delta_dislocation import load_delta_dislocations
from rithmic_dashboard.features.sweep_detector import load_sweeps
from rithmic_dashboard.models import (
    AbsorptionProxyEvent,
    AuditEntry,
    DashboardSession,
    DeltaDislocationEvent,
    LevelDistance,
    ScenarioState,
    SweepEvent,
)
from rithmic_dashboard.session_state import PT

RECENT_SIGNAL_WINDOW_MINUTES = 30
SIGNAL_FRESH_MINUTES = 5
SIGNAL_NORMAL_MINUTES = 15
SIGNAL_LEVEL_PROXIMITY_PTS = 5.0

_KNOWN_SIGNAL_SUFFIXES = {
    "sweeps",
    "absorption_proxy",
    "delta_dislocations",
    "delta_dislocation_alerts",
    "cvd",
}

_PRICE_RE = re.compile(r"(?<!\d)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+)(?!\d)")
_DELTA_RE = re.compile(r"delta\s+([+-]?\d[\d,]*)", re.IGNORECASE)


@dataclass(frozen=True)
class RecentSignal:
    """Normalized signal row rendered by RA-050 UI elements."""

    timestamp_pt: str
    timestamp_ns: int | None
    event_type: str
    family: str
    icon: str
    label: str
    level_id: str | None
    level_text: str
    level_price: float | None
    price: float | None
    description: str
    direction: str
    urgency: str
    decay_class: str
    age_minutes: float | None
    scenario_refs: tuple[str, ...]
    zone_key: str
    zone_text: str
    zone_price: float | None
    tooltip: str

    @property
    def sort_ts(self) -> int:
        """Timestamp key for deterministic newest-first sorting."""

        if self.timestamp_ns is not None:
            return self.timestamp_ns
        parsed = _parse_pt_timestamp(self.timestamp_pt)
        if parsed is None:
            return 0
        return int(parsed.timestamp() * 1_000_000_000)


@dataclass(frozen=True)
class _SignalCandidate:
    timestamp_pt: str
    timestamp_ns: int | None
    event_type: str
    family: str
    icon: str
    label: str
    level_id: str | None
    level_text: str
    level_price: float | None
    price: float | None
    description: str
    direction: str
    intensity: float | None = None
    confidence: str | None = None


def build_recent_signals(
    *,
    live_dir: Path,
    session: DashboardSession,
    audit: list[AuditEntry],
    scenarios: list[ScenarioState],
    levels: list[LevelDistance],
    now_pt: datetime | None = None,
    window_minutes: int = RECENT_SIGNAL_WINDOW_MINUTES,
    limit: int | None = None,
) -> list[RecentSignal]:
    """Load canonical live-analysis signals and enrich them for rendering."""

    now = (now_pt or session.now_pt).astimezone(PT)
    prefix = session.key
    known_paths = {
        "sweep": live_dir / f"{prefix}_sweeps.jsonl",
        "absorption": live_dir / f"{prefix}_absorption_proxy.jsonl",
        "dislocation": live_dir / f"{prefix}_delta_dislocations.jsonl",
    }

    candidates: list[_SignalCandidate] = []
    candidates.extend(_sweep_candidates(known_paths["sweep"]))
    candidates.extend(_absorption_candidates(known_paths["absorption"]))
    candidates.extend(_dislocation_candidates(known_paths["dislocation"]))
    candidates.extend(_generic_candidates(live_dir, prefix))

    missing_families = {
        family for family, path in known_paths.items() if not path.exists()
    }
    if missing_families:
        candidates.extend(_audit_candidates(audit, missing_families))

    deduped = _dedupe_candidates(candidates)
    signals: list[RecentSignal] = []
    for candidate in deduped:
        signal = _enrich_candidate(
            candidate,
            scenarios=scenarios,
            levels=levels,
            now_pt=now,
            window_minutes=window_minutes,
        )
        if signal is not None:
            signals.append(signal)

    sorted_signals = sorted(signals, key=lambda signal: signal.sort_ts, reverse=True)
    if limit is not None:
        return sorted_signals[:limit]
    return sorted_signals


def zone_key_for_level(level: LevelDistance) -> str:
    """Return the stable zone key used by signals and badges."""

    return f"level:{level.level_id}"


def signal_price(signal: RecentSignal) -> float | None:
    """Best display price for a signal."""

    if signal.level_price is not None:
        return signal.level_price
    return signal.price


def _sweep_candidates(path: Path) -> list[_SignalCandidate]:
    return [_sweep_candidate(event) for event in load_sweeps(path)]


def _sweep_candidate(event: SweepEvent) -> _SignalCandidate:
    direction = "long" if event.direction == "up" else "short"
    return _SignalCandidate(
        timestamp_pt=event.timestamp_pt,
        timestamp_ns=event.timestamp_ns,
        event_type="sweep_detected",
        family="sweep",
        icon="●",
        label="Sweep",
        level_id=event.level_id,
        level_text=event.level_text,
        level_price=event.level_price,
        price=event.level_price,
        description=(
            f"Sweep {event.direction.upper()} at {event.level_text} "
            f"({event.level_price:,.2f}), intensity {event.intensity_score:.2f}"
        ),
        direction=direction,
        intensity=event.intensity_score,
        confidence="unrecovered" if event.recovered_within_5min is False else None,
    )


def _absorption_candidates(path: Path) -> list[_SignalCandidate]:
    return [_absorption_candidate(event) for event in load_absorption_proxy_events(path)]


def _absorption_candidate(event: AbsorptionProxyEvent) -> _SignalCandidate:
    direction = _absorption_direction(event.side_inferred)
    return _SignalCandidate(
        timestamp_pt=event.timestamp_pt,
        timestamp_ns=event.timestamp_ns,
        event_type="absorption_proxy",
        family="absorption",
        icon="●",
        label="Absorption",
        level_id=f"absorption-{event.price:.2f}",
        level_text=f"Absorption {event.price:,.2f}",
        level_price=event.price,
        price=event.price,
        description=(
            f"{event.side_inferred.replace('_', ' ')} at {event.price:,.2f}: "
            f"vol {event.volume:,}, delta {event.net_delta:+,}, confidence {event.confidence}"
        ),
        direction=direction,
        intensity=None,
        confidence=event.confidence,
    )


def _dislocation_candidates(path: Path) -> list[_SignalCandidate]:
    return [_dislocation_candidate(event) for event in load_delta_dislocations(path)]


def _dislocation_candidate(event: DeltaDislocationEvent) -> _SignalCandidate:
    return _SignalCandidate(
        timestamp_pt=event.timestamp_pt,
        timestamp_ns=event.timestamp_ns,
        event_type=f"delta_dislocation_{event.side}_detected",
        family="dislocation",
        icon="◆",
        label="Dislocation",
        level_id=event.level_id,
        level_text=event.level_text,
        level_price=event.level_price,
        price=event.level_price,
        description=(
            f"Delta dislocation {event.side} at {event.level_text} "
            f"({event.level_price:,.2f}): candle {event.candle_direction}, "
            f"CVD {event.hourly_cvd:+,}, confidence {event.confidence}"
        ),
        direction=event.side,
        intensity=abs(float(event.hourly_cvd)),
        confidence=event.confidence,
    )


def _generic_candidates(live_dir: Path, prefix: str) -> list[_SignalCandidate]:
    if not live_dir.exists():
        return []
    candidates: list[_SignalCandidate] = []
    for path in sorted(live_dir.glob(f"{prefix}_*.jsonl")):
        suffix = path.name.removeprefix(f"{prefix}_").removesuffix(".jsonl")
        if suffix in _KNOWN_SIGNAL_SUFFIXES:
            continue
        candidates.extend(_generic_file_candidates(path, suffix))
    return candidates


def _generic_file_candidates(path: Path, suffix: str) -> list[_SignalCandidate]:
    candidates: list[_SignalCandidate] = []
    for row in _read_jsonl(path):
        event_type = str(row.get("event_type") or row.get("type") or suffix)
        timestamp_pt = _string_or_empty(row.get("timestamp_pt") or row.get("time_pt"))
        timestamp_ns = _int(row.get("timestamp_ns"))
        if not timestamp_pt and timestamp_ns is None:
            continue
        family = _family_from_event_type(event_type)
        price = _first_float(row, ("level_price", "price", "entry_price"))
        level_id = _optional_str(row.get("level_id"))
        level_text = _optional_str(row.get("level_text")) or event_type.replace("_", " ").title()
        description = _optional_str(row.get("description")) or _generic_description(
            event_type,
            level_text,
            price,
        )
        candidates.append(
            _SignalCandidate(
                timestamp_pt=timestamp_pt or _fmt_ns(timestamp_ns),
                timestamp_ns=timestamp_ns,
                event_type=event_type,
                family=family,
                icon=_icon_for_family(family),
                label=_label_for_family(family),
                level_id=level_id,
                level_text=level_text,
                level_price=price if level_id is not None else None,
                price=price,
                description=description,
                direction=_normalize_direction(row.get("direction") or row.get("side")),
                intensity=_first_float(row, ("intensity", "intensity_score", "score")),
                confidence=_optional_str(row.get("confidence")),
            )
        )
    return candidates


def _audit_candidates(
    audit: list[AuditEntry],
    missing_families: set[str],
) -> list[_SignalCandidate]:
    candidates: list[_SignalCandidate] = []
    for entry in audit:
        if entry.event_type == "sweep_detected" and "sweep" in missing_families:
            candidates.append(_audit_sweep_candidate(entry))
        elif entry.event_type == "absorption_proxy" and "absorption" in missing_families:
            candidates.append(_audit_absorption_candidate(entry))
        elif (
            entry.event_type
            in {"delta_dislocation_long_detected", "delta_dislocation_short_detected"}
            and "dislocation" in missing_families
        ):
            candidates.append(_audit_dislocation_candidate(entry))
    return candidates


def _audit_sweep_candidate(entry: AuditEntry) -> _SignalCandidate:
    price = _extract_price(entry.description)
    direction = "short" if "down" in entry.description.lower() else "long"
    return _SignalCandidate(
        timestamp_pt=entry.timestamp_pt,
        timestamp_ns=None,
        event_type="sweep_detected",
        family="sweep",
        icon="●",
        label="Sweep",
        level_id=entry.related_level_id,
        level_text=entry.related_level_id or "Audit sweep",
        level_price=price,
        price=price,
        description=entry.description,
        direction=direction,
    )


def _audit_absorption_candidate(entry: AuditEntry) -> _SignalCandidate:
    price = _price_from_related_level(entry.related_level_id) or _extract_price(entry.description)
    delta = _extract_delta(entry.description)
    direction = "neutral"
    if delta is not None:
        direction = "long" if delta > 0 else "short" if delta < 0 else "neutral"
    return _SignalCandidate(
        timestamp_pt=entry.timestamp_pt,
        timestamp_ns=None,
        event_type="absorption_proxy",
        family="absorption",
        icon="●",
        label="Absorption",
        level_id=entry.related_level_id,
        level_text=f"Absorption {price:,.2f}" if price is not None else "Audit absorption",
        level_price=price,
        price=price,
        description=entry.description,
        direction=direction,
    )


def _audit_dislocation_candidate(entry: AuditEntry) -> _SignalCandidate:
    price = _extract_price(entry.description)
    direction = "short" if entry.event_type == "delta_dislocation_short_detected" else "long"
    return _SignalCandidate(
        timestamp_pt=entry.timestamp_pt,
        timestamp_ns=None,
        event_type=entry.event_type,
        family="dislocation",
        icon="◆",
        label="Dislocation",
        level_id=entry.related_level_id,
        level_text=entry.related_level_id or "Audit dislocation",
        level_price=price,
        price=price,
        description=entry.description,
        direction=direction,
    )


def _enrich_candidate(
    candidate: _SignalCandidate,
    *,
    scenarios: list[ScenarioState],
    levels: list[LevelDistance],
    now_pt: datetime,
    window_minutes: int,
) -> RecentSignal | None:
    event_time = _candidate_time(candidate)
    age_minutes: float | None = None
    if event_time is not None:
        age_minutes = max(0.0, (now_pt - event_time).total_seconds() / 60.0)
        if age_minutes > window_minutes:
            return None
    else:
        return None
    zone_key, zone_text, zone_price = _resolve_zone(candidate, levels)
    scenario_refs = _scenario_refs(candidate, scenarios)
    urgency = _urgency(candidate)
    tooltip_parts = [
        candidate.description,
        f"Age {age_minutes:.1f} min",
        f"Bias {candidate.direction}",
    ]
    if scenario_refs:
        tooltip_parts.append(f"Affects {', '.join(scenario_refs)}")
    return RecentSignal(
        timestamp_pt=candidate.timestamp_pt,
        timestamp_ns=candidate.timestamp_ns,
        event_type=candidate.event_type,
        family=candidate.family,
        icon=candidate.icon,
        label=candidate.label,
        level_id=candidate.level_id,
        level_text=candidate.level_text,
        level_price=candidate.level_price,
        price=candidate.price,
        description=candidate.description,
        direction=candidate.direction,
        urgency=urgency,
        decay_class=_decay_class(age_minutes),
        age_minutes=age_minutes,
        scenario_refs=scenario_refs,
        zone_key=zone_key,
        zone_text=zone_text,
        zone_price=zone_price,
        tooltip=" / ".join(tooltip_parts),
    )


def _resolve_zone(
    candidate: _SignalCandidate,
    levels: list[LevelDistance],
) -> tuple[str, str, float | None]:
    by_id = {level.level_id: level for level in levels}
    if candidate.level_id is not None and candidate.level_id in by_id:
        level = by_id[candidate.level_id]
        return zone_key_for_level(level), level.text, level.price

    price = candidate.level_price if candidate.level_price is not None else candidate.price
    if price is not None:
        nearest = _nearest_level(price, levels)
        if nearest is not None:
            return zone_key_for_level(nearest), nearest.text, nearest.price
        rounded = round(price / 5.0) * 5.0
        return f"price:{rounded:.2f}", f"{rounded:,.2f} area", rounded

    if candidate.level_id is not None:
        return f"event:{candidate.level_id}", candidate.level_text, candidate.level_price
    return f"event:{candidate.event_type}", candidate.label, candidate.price


def _nearest_level(price: float, levels: list[LevelDistance]) -> LevelDistance | None:
    if not levels:
        return None
    eligible = [
        (abs(level.price - price), level)
        for level in levels
        if abs(level.price - price) <= SIGNAL_LEVEL_PROXIMITY_PTS
    ]
    if not eligible:
        return None
    return sorted(eligible, key=lambda item: (item[0], item[1].price))[0][1]


def _scenario_refs(
    candidate: _SignalCandidate,
    scenarios: list[ScenarioState],
) -> tuple[str, ...]:
    price = candidate.level_price if candidate.level_price is not None else candidate.price
    if price is None:
        return ()
    refs: list[str] = []
    for scenario in scenarios:
        low = min(scenario.entry_zone_low, scenario.entry_zone_high)
        high = max(scenario.entry_zone_low, scenario.entry_zone_high)
        direction_matches = candidate.direction in {"neutral", "unknown", scenario.direction}
        if low <= price <= high and direction_matches:
            refs.append(scenario.scenario_id)
    return tuple(refs[:4])


def _dedupe_candidates(candidates: list[_SignalCandidate]) -> list[_SignalCandidate]:
    seen: set[tuple[str, str, str, str]] = set()
    deduped: list[_SignalCandidate] = []
    for candidate in candidates:
        price = candidate.level_price if candidate.level_price is not None else candidate.price
        key = (
            candidate.event_type,
            str(candidate.timestamp_ns or candidate.timestamp_pt),
            candidate.level_id or "",
            f"{price:.2f}" if price is not None else "",
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(candidate)
    return deduped


def _urgency(candidate: _SignalCandidate) -> str:
    if candidate.family == "dislocation":
        return "high"
    if candidate.family == "sweep":
        score = candidate.intensity or 0.0
        if score >= 4.5:
            return "high"
        if score >= 3.0:
            return "medium"
        return "low"
    if candidate.family == "absorption":
        return "medium" if candidate.confidence == "high" else "low"
    if candidate.confidence == "high" or (candidate.intensity or 0.0) >= 4.5:
        return "medium"
    return "low"


def _decay_class(age_minutes: float) -> str:
    if age_minutes < SIGNAL_FRESH_MINUTES:
        return "signal-age-fresh"
    if age_minutes < SIGNAL_NORMAL_MINUTES:
        return "signal-age-normal"
    return "signal-age-faded"


def _candidate_time(candidate: _SignalCandidate) -> datetime | None:
    if candidate.timestamp_ns is not None:
        return datetime.fromtimestamp(candidate.timestamp_ns / 1_000_000_000, tz=UTC).astimezone(
            PT
        )
    return _parse_pt_timestamp(candidate.timestamp_pt)


def _parse_pt_timestamp(value: str) -> datetime | None:
    try:
        return datetime.strptime(value, "%Y-%m-%d %H:%M:%S PT").replace(tzinfo=PT)
    except ValueError:
        return None


def _fmt_ns(value: int | None) -> str:
    if value is None:
        return ""
    return datetime.fromtimestamp(value / 1_000_000_000, tz=UTC).astimezone(PT).strftime(
        "%Y-%m-%d %H:%M:%S PT"
    )


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            rows.append(data)
    return rows


def _family_from_event_type(event_type: str) -> str:
    lower = event_type.lower()
    if "sweep" in lower:
        return "sweep"
    if "absorption" in lower:
        return "absorption"
    if "dislocation" in lower:
        return "dislocation"
    if "institution" in lower or "block" in lower:
        return "institutional_flow"
    if "aggressor" in lower or "v_delta" in lower or "footprint" in lower:
        return "aggressor_flow"
    if "day_type" in lower or "initial_balance" in lower or lower.startswith("ib_"):
        return "day_type"
    if "vol_regime" in lower or "volatility" in lower:
        return "vol_regime"
    return "generic"


def _icon_for_family(family: str) -> str:
    return {
        "sweep": "●",
        "absorption": "●",
        "dislocation": "◆",
        "institutional_flow": "■",
        "aggressor_flow": "≈",
        "day_type": "📊",
        "vol_regime": "▲",
    }.get(family, "◇")


def _label_for_family(family: str) -> str:
    return {
        "sweep": "Sweep",
        "absorption": "Absorption",
        "dislocation": "Dislocation",
        "institutional_flow": "Institutional",
        "aggressor_flow": "Aggressor",
        "day_type": "Day type",
        "vol_regime": "Vol regime",
    }.get(family, "Signal")


def _generic_description(event_type: str, level_text: str, price: float | None) -> str:
    price_text = f" near {price:,.2f}" if price is not None else ""
    return f"{event_type.replace('_', ' ').title()} at {level_text}{price_text}"


def _normalize_direction(value: Any) -> str:
    lower = str(value or "").lower()
    if lower in {"long", "bull", "bullish", "buy", "up"}:
        return "long"
    if lower in {"short", "bear", "bearish", "sell", "down"}:
        return "short"
    return "neutral" if lower in {"neutral", "balanced", ""} else "unknown"


def _absorption_direction(side_inferred: str) -> str:
    if side_inferred == "sell_absorbed":
        return "long"
    if side_inferred == "buy_absorbed":
        return "short"
    return "neutral"


def _first_float(row: dict[str, Any], keys: tuple[str, ...]) -> float | None:
    for key in keys:
        parsed = _float(row.get(key))
        if parsed is not None:
            return parsed
    return None


def _float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def _string_or_empty(value: Any) -> str:
    return "" if value is None else str(value)


def _extract_price(value: str) -> float | None:
    match = _PRICE_RE.search(value)
    if match is None:
        return None
    return _float(match.group(1).replace(",", ""))


def _price_from_related_level(value: str | None) -> float | None:
    if not value:
        return None
    if value.startswith("absorption-"):
        return _float(value.removeprefix("absorption-"))
    return _extract_price(value)


def _extract_delta(value: str) -> int | None:
    match = _DELTA_RE.search(value)
    if match is None:
        return None
    return _int(match.group(1).replace(",", ""))
