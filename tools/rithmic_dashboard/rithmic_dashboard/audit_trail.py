"""Rolling actionable dashboard audit trail."""

from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timedelta
from typing import Any, Literal

from rithmic_dashboard.models import (
    AuditEntry,
    ConfluenceGroup,
    DataWarning,
    DayTypeClassification,
    LevelDistance,
    LiveSignals,
)
from rithmic_dashboard.session_state import PT

_ACTIONABLE_CONVICTIONS = {"HIGH", "SUPER"}


def load_audit_entries(data: dict[str, Any]) -> list[AuditEntry]:
    """Parse persisted audit JSON into dataclasses."""

    raw_entries = data.get("entries", [])
    if not isinstance(raw_entries, list):
        return []
    entries: list[AuditEntry] = []
    for raw in raw_entries:
        if not isinstance(raw, dict):
            continue
        if raw.get("event_type") == "data_warning":
            continue
        try:
            entries.append(
                AuditEntry(
                    timestamp_pt=str(raw["timestamp_pt"]),
                    event_type=raw["event_type"],
                    description=str(raw["description"]),
                    related_level_id=raw.get("related_level_id"),
                )
            )
        except KeyError:
            continue
    return entries


def dump_audit_entries(entries: list[AuditEntry]) -> dict[str, Any]:
    """Serialize the rolling audit log."""

    return {"entries": [asdict(entry) for entry in entries[-50:]]}


def add_warning_events(
    entries: list[AuditEntry],
    warnings: list[DataWarning],
    *,
    now_pt: datetime,
) -> list[AuditEntry]:
    """Add fail-level data warnings once per generator invocation."""

    updated = list(entries)
    for warning in warnings:
        if warning.severity != "fail":
            continue
        updated.append(
            AuditEntry(
                timestamp_pt=_fmt(now_pt),
                event_type="data_warning",
                description=warning.message,
                related_level_id=None,
            )
        )
    return updated[-50:]


def dedupe_audit_entries(
    entries: list[AuditEntry],
    *,
    dedupe_window_minutes: int = 5,
) -> list[AuditEntry]:
    """Collapse identical actionable entries that repeat inside a short window."""

    deduped: list[AuditEntry] = []
    repeat_counts: dict[int, int] = {}
    window = timedelta(minutes=dedupe_window_minutes)
    for entry in entries:
        if not deduped:
            deduped.append(entry)
            continue
        previous = deduped[-1]
        if _same_action(previous, entry) and _within_window(previous, entry, window):
            idx = len(deduped) - 1
            repeat_counts[idx] = repeat_counts.get(idx, 1) + 1
            count = repeat_counts[idx]
            description = (
                f"{_strip_repeat_suffix(previous.description)} "
                f"(repeated {count} times)"
            )
            deduped[idx] = AuditEntry(
                timestamp_pt=previous.timestamp_pt,
                event_type=previous.event_type,
                description=description,
                related_level_id=previous.related_level_id,
            )
            continue
        deduped.append(entry)
    return deduped[-50:]


def add_level_touch_events(
    entries: list[AuditEntry],
    distances: list[LevelDistance],
    *,
    now_pt: datetime,
) -> list[AuditEntry]:
    """Track zone touches only for HIGH/SUPER levels to keep the trail quiet."""

    updated = list(entries)
    for distance in distances:
        if distance.conviction not in _ACTIONABLE_CONVICTIONS:
            continue
        if distance.direction != "at":
            continue
        updated.append(
            AuditEntry(
                timestamp_pt=_fmt(now_pt),
                event_type="level_crossed",
                description=f"Price touched {distance.text} at {distance.price:,.2f}",
                related_level_id=distance.level_id,
            )
        )
    return _dedupe_recent(updated)[-50:]


def add_confluence_break_events(
    entries: list[AuditEntry],
    groups: list[ConfluenceGroup],
    *,
    current_price: float,
    prior_state: dict[str, Any],
    now_pt: datetime,
) -> list[AuditEntry]:
    """Record HIGH/SUPER confluence center crossings."""

    updated = list(entries)
    for group in groups:
        if group.conviction_score not in _ACTIONABLE_CONVICTIONS:
            continue
        group_id = confluence_state_id(group)
        prior = prior_state.get(group_id)
        if not isinstance(prior, dict) or "last_distance_pts" not in prior:
            continue
        previous = _to_float(prior.get("last_distance_pts"))
        current = group.center_price - current_price
        if previous is None:
            continue
        if previous == 0 or current == 0 or (previous < 0 < current) or (
            previous > 0 > current
        ):
            updated.append(
                AuditEntry(
                    timestamp_pt=_fmt(now_pt),
                    event_type="confluence_break",
                    description=(
                        f"Price crossed {group.conviction_score} confluence "
                        f"near {group.center_price:,.2f}"
                    ),
                    related_level_id=group_id,
                )
            )
    return _dedupe_recent(updated)[-50:]


def add_live_signal_events(
    entries: list[AuditEntry],
    signals: LiveSignals | None,
    *,
    now_pt: datetime,
) -> list[AuditEntry]:
    """Record actionable live signal events without repeating noise."""

    if signals is None:
        return entries
    updated = list(entries)
    for sweep in signals.sweeps[:6]:
        updated.append(
            AuditEntry(
                timestamp_pt=_fmt(now_pt),
                event_type="sweep_detected",
                description=(
                    f"Sweep detected at {sweep.level_text} "
                    f"({sweep.direction}, intensity {sweep.intensity_score:.2f})"
                ),
                related_level_id=sweep.level_id,
            )
        )
    for absorption in signals.absorption_proxies[:6]:
        updated.append(
            AuditEntry(
                timestamp_pt=_fmt(now_pt),
                event_type="absorption_proxy",
                description=(
                    f"Absorption proxy at {absorption.price:,.2f}: vol {absorption.volume}, "
                    f"delta {absorption.net_delta:+,}, confidence {absorption.confidence}"
                ),
                related_level_id=f"absorption-{absorption.price:.2f}",
            )
        )
    for dislocation in signals.delta_dislocations[:6]:
        event_type: Literal[
            "delta_dislocation_long_detected",
            "delta_dislocation_short_detected",
        ] = (
            "delta_dislocation_short_detected"
            if dislocation.side == "short"
            else "delta_dislocation_long_detected"
        )
        updated.append(
            AuditEntry(
                timestamp_pt=_fmt(now_pt),
                event_type=event_type,
                description=(
                    f"Delta dislocation {dislocation.side} at {dislocation.level_text} "
                    f"({dislocation.level_price:,.2f}): candle "
                    f"{dislocation.candle_direction}, CVD {dislocation.hourly_cvd:+,}, "
                    f"confidence {dislocation.confidence}"
                ),
                related_level_id=dislocation.level_id,
            )
        )
    for institutional in signals.institutional_flow_events[:6]:
        updated.append(
            AuditEntry(
                timestamp_pt=_fmt(now_pt),
                event_type=institutional.event_type,
                description=institutional.description,
                related_level_id=institutional.level_id,
            )
        )
    for iceberg in signals.iceberg_events[:6]:
        updated.append(
            AuditEntry(
                timestamp_pt=iceberg.timestamp_pt,
                event_type=iceberg.event_type,
                description=iceberg.description,
                related_level_id=iceberg.level_id,
            )
        )
    for aggressor in signals.aggressor_flow_events[:6]:
        updated.append(
            AuditEntry(
                timestamp_pt=aggressor.timestamp_pt,
                event_type=aggressor.event_type,
                description=aggressor.description,
                related_level_id=aggressor.level_id,
            )
        )
    if signals.volatility_regime is not None:
        for event in signals.volatility_regime.events:
            updated.append(
                AuditEntry(
                    timestamp_pt=event.timestamp_pt,
                    event_type=event.event_type,
                    description=event.description,
                    related_level_id=event.level_id,
                )
            )
    if signals.cvd.momentum_flip:
        updated.append(
            AuditEntry(
                timestamp_pt=_fmt(now_pt),
                event_type="cvd_momentum_flip",
                description=(
                    "CVD momentum flip: "
                    f"session {signals.cvd.session_direction}, "
                    f"last-15m {signals.cvd.last_15m_direction}"
                ),
                related_level_id="live-cvd",
            )
        )
    return dedupe_audit_entries(updated)[-50:]


def add_day_type_events(
    entries: list[AuditEntry],
    day_type: DayTypeClassification | None,
) -> list[AuditEntry]:
    """Record newly emitted day-type/IB events in the rolling audit trail."""

    if day_type is None or not day_type.events:
        return entries
    updated = list(entries)
    for event in day_type.events:
        updated.append(
            AuditEntry(
                timestamp_pt=event.timestamp_pt,
                event_type=event.event_type,
                description=event.description,
                related_level_id=event.level_id,
            )
        )
    return dedupe_audit_entries(updated)[-50:]


def confluence_state_id(group: ConfluenceGroup) -> str:
    return f"confluence-{group.center_price:.2f}-{group.span_pts:.2f}"


def _fmt(ts: datetime) -> str:
    return ts.astimezone(PT).strftime("%Y-%m-%d %H:%M:%S PT")


def _dedupe_recent(entries: list[AuditEntry]) -> list[AuditEntry]:
    deduped: list[AuditEntry] = []
    seen: set[tuple[str, str, str | None]] = set()
    for entry in entries:
        key = (entry.timestamp_pt, entry.description, entry.related_level_id)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(entry)
    return deduped


def _same_action(left: AuditEntry, right: AuditEntry) -> bool:
    return (
        left.event_type == right.event_type
        and _strip_repeat_suffix(left.description) == _strip_repeat_suffix(right.description)
        and left.related_level_id == right.related_level_id
    )


def _within_window(left: AuditEntry, right: AuditEntry, window: timedelta) -> bool:
    left_ts = _parse_ts(left.timestamp_pt)
    right_ts = _parse_ts(right.timestamp_pt)
    if left_ts is None or right_ts is None:
        return False
    return abs(right_ts - left_ts) <= window


def _strip_repeat_suffix(value: str) -> str:
    marker = " (repeated "
    if marker not in value:
        return value
    return value.split(marker, 1)[0]


def _parse_ts(value: str) -> datetime | None:
    try:
        return datetime.strptime(value, "%Y-%m-%d %H:%M:%S PT").replace(tzinfo=PT)
    except ValueError:
        return None


def _to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
