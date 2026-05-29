"""Auction-market-theory day-type classification and IB event persistence."""

from __future__ import annotations

import json
import math
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any, Literal

from rithmic_dashboard.models import (
    DashboardSession,
    DayTypeClassification,
    DayTypeConfidence,
    DayTypeEvent,
    DayTypeName,
    TradeTick,
)
from rithmic_dashboard.session_state import PT

IB_MINUTES = 60
CLASSIFICATION_MINUTES = 90
RECLASSIFICATION_MINUTES = 15
OPEN_EXTREME_THRESHOLD_PTS = 10.0
TREND_EXTENSION_X_IB = 1.5
MIN_IB_BREAK_BUFFER_PTS = 5.0
DOUBLE_DISTRIBUTION_MIN_MODE_GAP_PTS = 30.0
DOUBLE_DISTRIBUTION_MIN_MODE_VOLUME_PCT = 0.20
DOUBLE_DISTRIBUTION_HIGH_CONFIDENCE_GAP_X_IB = 2.0
PRICE_BIN_SIZE = 5.0


def compute_day_type_classification(
    *,
    session: DashboardSession,
    live_dir: Path,
    current_price: float | None,
) -> DayTypeClassification:
    """Compute and persist the current day-type read for an RTH session."""

    live_dir.mkdir(parents=True, exist_ok=True)
    state_path = live_dir / f"{session.key}_day_type.json"
    event_path = live_dir / f"{session.key}_day_type.jsonl"
    prior_state = _read_json(state_path)

    classification = _classify(session=session, live_dir=live_dir, current_price=current_price)
    new_events = _new_events(classification, prior_state, event_path)
    classification = _replace_events(classification, tuple(new_events))
    _write_json_atomic(state_path, _classification_row(classification, include_events=False))
    _append_jsonl(event_path, [_event_row(event) for event in new_events])
    return classification


def classify_ticks(
    *,
    ticks: list[TradeTick],
    session: DashboardSession,
    current_price: float | None = None,
    partial_session: bool = False,
    source_path: Path | None = None,
) -> DayTypeClassification:
    """Test-friendly pure classifier over already-loaded RTH trade ticks."""

    return _classify_from_ticks(
        ticks=ticks,
        session=session,
        current_price=current_price,
        partial_session=partial_session,
        source_path=source_path,
    )


def load_day_type(path: Path) -> DayTypeClassification | None:
    """Load the persisted current day-type state."""

    row = _read_json(path)
    if not row:
        return None
    return _classification_from_row(row)


def append_day_type_outcome(
    path: Path,
    *,
    session: DashboardSession,
    day_type: DayTypeClassification | None,
    scenarios: list[Any],
) -> None:
    """Append the session-level day-type outcome row after RTH has closed."""

    if day_type is None or session.session != "rth" or session.session_end_pt is None:
        return
    if session.now_pt < session.session_end_pt:
        return
    row = {
        "record_type": "day_type_outcome",
        "trading_date": session.trading_date,
        "session": session.session,
        "recorded_at_pt": session.now_pt.isoformat(),
        "day_type": day_type.day_type,
        "status": day_type.status,
        "confidence": day_type.confidence,
        "ib_high": day_type.ib_high,
        "ib_low": day_type.ib_low,
        "ib_range": day_type.ib_range,
        "session_high": day_type.session_high,
        "session_low": day_type.session_low,
        "current_price": day_type.current_price,
        "scenario_outcomes": [
            {
                "scenario_id": scenario.scenario_id,
                "state": scenario.state,
                "outcome": "target_or_stop_resolved" if scenario.state == "COMPLETED" else None,
                "day_type_multipliers": [
                    asdict(factor)
                    for factor in scenario.adjustment_factors
                    if factor.name.startswith("day_type_")
                ],
            }
            for scenario in scenarios
        ],
    }
    key = _outcome_key(row)
    if key in _seen_outcome_keys(path):
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, sort_keys=True) + "\n")


def _classify(
    *,
    session: DashboardSession,
    live_dir: Path,
    current_price: float | None,
) -> DayTypeClassification:
    partial_session, partial_reason = _partial_session_override(live_dir, session.key)
    if partial_session:
        return _pending(
            session,
            current_price=current_price,
            reason=partial_reason or "partial session override is set",
            skipped_reason="partial_session",
            partial_session=True,
            status="skipped",
        )
    if session.session != "rth" or session.session_start_pt is None:
        return _pending(
            session,
            current_price=current_price,
            reason="RTH initial balance is unavailable outside RTH",
        )
    classification_time = session.session_start_pt + timedelta(minutes=CLASSIFICATION_MINUTES)
    if session.now_pt < classification_time:
        return _pending(
            session,
            current_price=current_price,
            reason=f"classification waits until {classification_time.strftime('%H:%M PT')}",
        )
    capture_path = _preferred_capture_path(session.capture_path)
    if capture_path is None:
        return _pending(
            session,
            current_price=current_price,
            reason="RTH capture missing; day type cannot be classified",
            skipped_reason="no_capture_data",
            status="skipped",
        )
    ticks = load_rth_ticks(capture_path, session.session_start_pt, session.now_pt)
    return _classify_from_ticks(
        ticks=ticks,
        session=session,
        current_price=current_price,
        partial_session=False,
        source_path=capture_path,
    )


def _classify_from_ticks(
    *,
    ticks: list[TradeTick],
    session: DashboardSession,
    current_price: float | None,
    partial_session: bool,
    source_path: Path | None,
) -> DayTypeClassification:
    now_text = _fmt(session.now_pt)
    if partial_session:
        return _pending(
            session,
            current_price=current_price,
            reason="partial session override is set",
            skipped_reason="partial_session",
            partial_session=True,
            status="skipped",
            source_path=source_path,
        )
    if session.session_start_pt is None:
        return _pending(session, current_price=current_price, reason="session start unavailable")
    classification_time = session.session_start_pt + timedelta(minutes=CLASSIFICATION_MINUTES)
    if session.now_pt < classification_time:
        return _pending(
            session,
            current_price=current_price,
            reason=f"classification waits until {classification_time.strftime('%H:%M PT')}",
            source_path=source_path,
        )
    ib_end = session.session_start_pt + timedelta(minutes=IB_MINUTES)
    ib_ticks = [tick for tick in ticks if _within(tick, session.session_start_pt, ib_end)]
    if not ib_ticks:
        return _pending(
            session,
            current_price=current_price,
            reason="no RTH trades found in the IB window",
            skipped_reason="no_capture_data",
            status="skipped",
            source_path=source_path,
        )
    session_ticks = [
        tick for tick in ticks if _within(tick, session.session_start_pt, session.now_pt)
    ]
    if not session_ticks:
        session_ticks = ib_ticks

    ib_high = max(tick.price for tick in ib_ticks)
    ib_low = min(tick.price for tick in ib_ticks)
    ib_range = ib_high - ib_low
    if ib_range <= 0:
        return _pending(
            session,
            current_price=current_price,
            reason="IB range is zero; classification would be unstable",
            skipped_reason="no_capture_data",
            status="skipped",
            source_path=source_path,
        )
    rth_open = session_ticks[0].price
    session_high = max(tick.price for tick in session_ticks)
    session_low = min(tick.price for tick in session_ticks)
    current = current_price if current_price is not None else session_ticks[-1].price
    extension_above = max(0.0, session_high - ib_high)
    extension_below = max(0.0, ib_low - session_low)
    current_extension = _current_extension(current, ib_high, ib_low)
    current_extension_x = current_extension / ib_range if ib_range > 0 else 0.0
    day_type, confidence, reason = _classify_day_type(
        ticks=session_ticks,
        ib_high=ib_high,
        ib_low=ib_low,
        ib_range=ib_range,
        rth_open=rth_open,
        session_high=session_high,
        session_low=session_low,
        current=current,
        session_start=session.session_start_pt,
    )
    return DayTypeClassification(
        trading_date=session.trading_date,
        session=session.session,
        computed_at_pt=now_text,
        status="classified",
        day_type=day_type,
        confidence=confidence,
        reason=reason,
        classification_timestamp_pt=now_text,
        ib_high=ib_high,
        ib_low=ib_low,
        ib_range=ib_range,
        ib_midpoint=(ib_high + ib_low) / 2.0,
        rth_open=rth_open,
        session_high=session_high,
        session_low=session_low,
        current_price=current,
        extension_above_pts=extension_above,
        extension_below_pts=extension_below,
        current_extension_pts=current_extension,
        current_extension_x_ib=current_extension_x,
        partial_session=False,
        skipped_reason=None,
        source_path=source_path,
    )


def load_rth_ticks(path: Path, start: datetime, end: datetime) -> list[TradeTick]:
    """Load RTH trades from normalized OBS or raw capture JSONL."""

    ticks: list[TradeTick] = []
    start_ns = int(start.astimezone(UTC).timestamp() * 1_000_000_000)
    end_ns = int(end.astimezone(UTC).timestamp() * 1_000_000_000)
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        for raw in f:
            if not raw.strip():
                continue
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                continue
            tick = _trade_tick(rec)
            if tick is None or tick.timestamp_ns is None:
                continue
            if tick.timestamp_ns < start_ns:
                continue
            if tick.timestamp_ns > end_ns:
                break
            ticks.append(tick)
    return ticks


def _classify_day_type(
    *,
    ticks: list[TradeTick],
    ib_high: float,
    ib_low: float,
    ib_range: float,
    rth_open: float,
    session_high: float,
    session_low: float,
    current: float,
    session_start: datetime,
) -> tuple[DayTypeName, DayTypeConfidence, str]:
    above_x = (current - ib_high) / ib_range
    below_x = (ib_low - current) / ib_range
    if (
        rth_open <= session_low + OPEN_EXTREME_THRESHOLD_PTS
        and above_x >= TREND_EXTENSION_X_IB
    ):
        return "trend_day_up", "high", "open near session low and price extended >=1.5x IB above"
    if (
        rth_open >= session_high - OPEN_EXTREME_THRESHOLD_PTS
        and below_x >= TREND_EXTENSION_X_IB
    ):
        return (
            "trend_day_down",
            "high",
            "open near session high and price extended >=1.5x IB below",
        )

    double_distribution = _double_distribution(
        ticks=ticks,
        ib_high=ib_high,
        ib_low=ib_low,
        ib_range=ib_range,
        current=current,
        post_ib_start=session_start + timedelta(minutes=IB_MINUTES),
    )
    if double_distribution is not None:
        return double_distribution

    extension_above = max(0.0, session_high - ib_high)
    extension_below = max(0.0, ib_low - session_low)
    both_sides = (
        extension_above >= MIN_IB_BREAK_BUFFER_PTS
        and extension_below >= MIN_IB_BREAK_BUFFER_PTS
    )
    if both_sides:
        ib_mid = (ib_high + ib_low) / 2.0
        total_range = max(1.0, session_high - session_low)
        near_high = session_high - current <= 0.2 * total_range
        near_low = current - session_low <= 0.2 * total_range
        near_mid = abs(current - ib_mid) <= 0.25 * ib_range
        if near_high or near_low:
            return (
                "neutral_day_extreme",
                "medium",
                "extended both sides of IB and trades near an extreme",
            )
        if near_mid:
            return (
                "neutral_day_center",
                "high",
                "extended both sides of IB and returned near IB midpoint",
            )
        return (
            "neutral_day_center",
            "medium",
            "extended both sides of IB without accepting an extreme",
        )

    above_range_x = extension_above / ib_range
    below_range_x = extension_below / ib_range
    if 0.5 <= above_range_x < 1.5 and extension_below < MIN_IB_BREAK_BUFFER_PTS:
        return "normal_variation_up", "high", "extended 0.5-1.5x IB above without lower IB break"
    if 0.5 <= below_range_x < 1.5 and extension_above < MIN_IB_BREAK_BUFFER_PTS:
        return "normal_variation_down", "high", "extended 0.5-1.5x IB below without upper IB break"
    if above_range_x < 0.5 and below_range_x < 0.5:
        return "normal_day", "high", "held inside IB or extended less than 0.5x IB"
    return "normal_day", "low", "fallback: no exclusive day-type rule dominated"


def _double_distribution(
    *,
    ticks: list[TradeTick],
    ib_high: float,
    ib_low: float,
    ib_range: float,
    current: float,
    post_ib_start: datetime,
) -> tuple[DayTypeName, DayTypeConfidence, str] | None:
    post_ib = [tick for tick in ticks if _ts_datetime(tick) >= post_ib_start]
    total_volume = sum(tick.quantity for tick in post_ib)
    if total_volume <= 0:
        return None
    volume_by_bin: dict[float, int] = {}
    for tick in post_ib:
        bin_price = round(tick.price / PRICE_BIN_SIZE) * PRICE_BIN_SIZE
        volume_by_bin[bin_price] = volume_by_bin.get(bin_price, 0) + tick.quantity
    modes = [
        (price, volume)
        for price, volume in volume_by_bin.items()
        if volume / total_volume >= DOUBLE_DISTRIBUTION_MIN_MODE_VOLUME_PCT
    ]
    if len(modes) < 2:
        return None
    modes = sorted(modes, key=lambda item: item[0])
    best_pair: tuple[float, float] | None = None
    best_gap = 0.0
    for idx, left in enumerate(modes):
        for right in modes[idx + 1 :]:
            gap = right[0] - left[0]
            if gap >= DOUBLE_DISTRIBUTION_MIN_MODE_GAP_PTS and gap > best_gap:
                best_pair = (left[0], right[0])
                best_gap = gap
    if best_pair is None:
        return None
    low_mode, high_mode = best_pair
    confidence: DayTypeConfidence = (
        "high"
        if best_gap >= DOUBLE_DISTRIBUTION_HIGH_CONFIDENCE_GAP_X_IB * ib_range
        else "medium"
    )
    reason = (
        f"post-IB value-cluster separation {best_gap:.0f}pt "
        f"between modes {low_mode:,.0f}/{high_mode:,.0f}"
    )
    if current >= (ib_high + ib_low) / 2.0 and high_mode > ib_high:
        return "double_distribution_up", confidence, reason
    if current < (ib_high + ib_low) / 2.0 and low_mode < ib_low:
        return "double_distribution_down", confidence, reason
    return None


def _new_events(
    classification: DayTypeClassification,
    prior_state: dict[str, Any],
    event_path: Path,
) -> list[DayTypeEvent]:
    existing_keys = _existing_event_keys(event_path)
    events: list[DayTypeEvent] = []
    prior_status = str(prior_state.get("status") or "")
    prior_type = str(prior_state.get("day_type") or "")
    prior_skip = str(prior_state.get("skipped_reason") or "")
    if classification.status == "skipped":
        event_type: Literal[
            "day_type_skipped_partial_session",
            "day_type_skipped_no_capture_data",
        ] = (
            "day_type_skipped_partial_session"
            if classification.skipped_reason == "partial_session"
            else "day_type_skipped_no_capture_data"
        )
        if prior_status != "skipped" or prior_skip != classification.skipped_reason:
            events.append(_day_type_event(classification, event_type))
    elif classification.status == "classified":
        if prior_status != "classified" or prior_type in {"", "pending"}:
            events.append(_day_type_event(classification, "day_type_classified"))
        elif prior_type != classification.day_type:
            events.append(_day_type_event(classification, "day_type_revised"))
        events.extend(_ib_break_events(classification, existing_keys))
    return [
        event
        for event in events
        if _event_key(_event_row(event)) not in existing_keys
    ]


def _day_type_event(
    classification: DayTypeClassification,
    event_type: Literal[
        "day_type_classified",
        "day_type_revised",
        "day_type_skipped_partial_session",
        "day_type_skipped_no_capture_data",
    ],
) -> DayTypeEvent:
    return DayTypeEvent(
        timestamp_pt=classification.computed_at_pt,
        timestamp_ns=_ns_from_pt(classification.computed_at_pt),
        event_type=event_type,
        level_id=None,
        level_text=None,
        level_price=None,
        direction="neutral",
        description=_description(classification, event_type=event_type),
        intensity=3.0 if classification.status == "classified" else 2.0,
        confidence=classification.confidence,
        metadata=_metadata(classification),
    )


def _ib_break_events(
    classification: DayTypeClassification,
    existing_keys: set[str],
) -> list[DayTypeEvent]:
    if (
        classification.ib_high is None
        or classification.ib_low is None
        or classification.ib_range is None
        or classification.session_high is None
        or classification.session_low is None
    ):
        return []
    events: list[DayTypeEvent] = []
    if classification.session_high >= classification.ib_high + MIN_IB_BREAK_BUFFER_PTS:
        events.append(
            _ib_event(
                classification,
                event_type="ib_high_break",
                level_id="ib_high",
                level_text="IB high",
                level_price=classification.ib_high,
                direction="long",
                description=(
                    f"Price broke IB high {classification.ib_high:,.2f} "
                    f"by {classification.session_high - classification.ib_high:.1f}pt"
                ),
                threshold="break",
            )
        )
    if classification.session_low <= classification.ib_low - MIN_IB_BREAK_BUFFER_PTS:
        events.append(
            _ib_event(
                classification,
                event_type="ib_low_break",
                level_id="ib_low",
                level_text="IB low",
                level_price=classification.ib_low,
                direction="short",
                description=(
                    f"Price broke IB low {classification.ib_low:,.2f} "
                    f"by {classification.ib_low - classification.session_low:.1f}pt"
                ),
                threshold="break",
            )
        )
    extension_checks: tuple[tuple[Literal["long", "short"], float], ...] = (
        ("long", classification.session_high - classification.ib_high),
        ("short", classification.ib_low - classification.session_low),
    )
    for direction, reached in extension_checks:
        for multiple in (0.5, 1.0, 1.5):
            if reached < multiple * classification.ib_range:
                continue
            level = (
                classification.ib_high + multiple * classification.ib_range
                if direction == "long"
                else classification.ib_low - multiple * classification.ib_range
            )
            level_id = f"ib_{direction}_extension_{multiple:g}x"
            row_key = f"ib_extension_reached|{level_id}|{multiple:g}x"
            if row_key in existing_keys:
                continue
            events.append(
                _ib_event(
                    classification,
                    event_type="ib_extension_reached",
                    level_id=level_id,
                    level_text=f"IB {direction} {multiple:g}x extension",
                    level_price=level,
                    direction=direction,
                    description=(
                        f"Price reached {multiple:g}x IB {direction} extension "
                        f"near {level:,.2f}"
                    ),
                    threshold=f"{multiple:g}x",
                )
            )
    return events


def _ib_event(
    classification: DayTypeClassification,
    *,
    event_type: Literal["ib_high_break", "ib_low_break", "ib_extension_reached"],
    level_id: str,
    level_text: str,
    level_price: float,
    direction: Literal["long", "short"],
    description: str,
    threshold: str,
) -> DayTypeEvent:
    metadata = _metadata(classification)
    metadata["threshold"] = threshold
    return DayTypeEvent(
        timestamp_pt=classification.computed_at_pt,
        timestamp_ns=_ns_from_pt(classification.computed_at_pt),
        event_type=event_type,
        level_id=level_id,
        level_text=level_text,
        level_price=level_price,
        direction=direction,
        description=description,
        intensity=4.0 if event_type != "ib_extension_reached" else 3.5,
        confidence=classification.confidence,
        metadata=metadata,
    )


def _description(
    classification: DayTypeClassification,
    *,
    event_type: str,
) -> str:
    if classification.status != "classified":
        return f"{event_type.replace('_', ' ').title()}: {classification.reason}"
    label = classification.day_type.replace("_", " ").upper()
    ib = (
        f"IB {classification.ib_low:,.2f}-{classification.ib_high:,.2f}"
        if classification.ib_low is not None and classification.ib_high is not None
        else "IB n/a"
    )
    ext = (
        f", extension {classification.current_extension_pts:+.1f}pt "
        f"({classification.current_extension_x_ib:+.2f}x IB)"
        if classification.current_extension_pts is not None
        and classification.current_extension_x_ib is not None
        else ""
    )
    return f"{label}: {ib}{ext}, confidence {classification.confidence}; {classification.reason}"


def _metadata(classification: DayTypeClassification) -> dict[str, float | str | bool | None]:
    return {
        "day_type": classification.day_type,
        "status": classification.status,
        "ib_high": classification.ib_high,
        "ib_low": classification.ib_low,
        "ib_range": classification.ib_range,
        "ib_midpoint": classification.ib_midpoint,
        "extension_pts": classification.current_extension_pts,
        "extension_x_ib": classification.current_extension_x_ib,
        "partial_session": classification.partial_session,
        "skipped_reason": classification.skipped_reason,
    }


def _preferred_capture_path(capture_path: Path) -> Path | None:
    obs_path = capture_path.with_name(f"{capture_path.name.removesuffix('.jsonl')}.obs01.jsonl")
    if obs_path.exists() and obs_path.stat().st_size > 0:
        return obs_path
    if capture_path.exists() and capture_path.stat().st_size > 0:
        return capture_path
    return None


def _partial_session_override(live_dir: Path, session_key: str) -> tuple[bool, str | None]:
    path = live_dir / "session_overrides.json"
    data = _read_json(path)
    raw = data.get(session_key)
    if not isinstance(raw, dict):
        return False, None
    return bool(raw.get("partial_session")), str(raw.get("reason") or "partial session")


def _pending(
    session: DashboardSession,
    *,
    current_price: float | None,
    reason: str,
    skipped_reason: str | None = None,
    partial_session: bool = False,
    status: Literal["pending", "skipped"] = "pending",
    source_path: Path | None = None,
) -> DayTypeClassification:
    return DayTypeClassification(
        trading_date=session.trading_date,
        session=session.session,
        computed_at_pt=_fmt(session.now_pt),
        status=status,
        day_type="pending",
        confidence="low",
        reason=reason,
        current_price=current_price,
        partial_session=partial_session,
        skipped_reason=skipped_reason,
        source_path=source_path,
    )


def _replace_events(
    classification: DayTypeClassification,
    events: tuple[DayTypeEvent, ...],
) -> DayTypeClassification:
    return DayTypeClassification(
        **{
            **_classification_row(classification, include_events=False),
            "source_path": classification.source_path,
            "events": events,
        }
    )


def _classification_row(
    classification: DayTypeClassification,
    *,
    include_events: bool,
) -> dict[str, Any]:
    row = asdict(classification)
    row["source_path"] = str(classification.source_path) if classification.source_path else None
    if not include_events:
        row.pop("events", None)
    return row


def _classification_from_row(row: dict[str, Any]) -> DayTypeClassification | None:
    try:
        source = row.get("source_path")
        return DayTypeClassification(
            trading_date=str(row["trading_date"]),
            session=str(row["session"]),
            computed_at_pt=str(row["computed_at_pt"]),
            status=row["status"],
            day_type=row["day_type"],
            confidence=row["confidence"],
            reason=str(row["reason"]),
            classification_timestamp_pt=_optional_str(row.get("classification_timestamp_pt")),
            ib_high=_float(row.get("ib_high")),
            ib_low=_float(row.get("ib_low")),
            ib_range=_float(row.get("ib_range")),
            ib_midpoint=_float(row.get("ib_midpoint")),
            rth_open=_float(row.get("rth_open")),
            session_high=_float(row.get("session_high")),
            session_low=_float(row.get("session_low")),
            current_price=_float(row.get("current_price")),
            extension_above_pts=_float(row.get("extension_above_pts")),
            extension_below_pts=_float(row.get("extension_below_pts")),
            current_extension_pts=_float(row.get("current_extension_pts")),
            current_extension_x_ib=_float(row.get("current_extension_x_ib")),
            partial_session=bool(row.get("partial_session", False)),
            skipped_reason=_optional_str(row.get("skipped_reason")),
            source_path=Path(source) if source else None,
        )
    except (KeyError, TypeError, ValueError):
        return None


def _event_row(event: DayTypeEvent) -> dict[str, Any]:
    row = asdict(event)
    row["family"] = "day_type"
    return row


def _append_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, sort_keys=True) + "\n")


def _existing_event_keys(path: Path) -> set[str]:
    return {_event_key(row) for row in _read_jsonl(path)}


def _event_key(row: dict[str, Any]) -> str:
    metadata = row.get("metadata")
    threshold = ""
    day_type = ""
    if isinstance(metadata, dict):
        threshold = str(metadata.get("threshold") or "")
        day_type = str(metadata.get("day_type") or "")
    return "|".join(
        [
            str(row.get("event_type")),
            str(row.get("level_id") or ""),
            threshold,
            day_type,
        ]
    )


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        try:
            row = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _write_json_atomic(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=path.parent) as tmp:
        json.dump(row, tmp, indent=2, sort_keys=True)
        tmp.write("\n")
        tmp_path = Path(tmp.name)
    tmp_path.replace(path)


def _outcome_key(row: dict[str, Any]) -> str:
    return "|".join(
        [str(row.get("trading_date")), str(row.get("session")), str(row.get("day_type"))]
    )


def _seen_outcome_keys(path: Path) -> set[str]:
    if not path.exists():
        return set()
    keys: set[str] = set()
    for row in _read_jsonl(path):
        keys.add(_outcome_key(row))
    return keys


def _within(tick: TradeTick, start: datetime, end: datetime) -> bool:
    if tick.timestamp_ns is None:
        return False
    ts = _ts_datetime(tick)
    return start <= ts <= end


def _ts_datetime(tick: TradeTick) -> datetime:
    return datetime.fromtimestamp((tick.timestamp_ns or 0) / 1_000_000_000, tz=UTC).astimezone(PT)


def _trade_tick(rec: dict[str, Any]) -> TradeTick | None:
    raw_payload = rec.get("payload")
    payload: dict[str, Any] = raw_payload if isinstance(raw_payload, dict) else {}
    stream = rec.get("stream")
    event_type = rec.get("type")
    if stream not in {"LAST_TRADE", "TRADE"} and event_type != "TRADE" and "price" not in rec:
        return None
    price = _float(rec.get("price", payload.get("price")))
    quantity = _int(
        rec.get(
            "size",
            rec.get("quantity", rec.get("qty", payload.get("quantity", payload.get("size")))),
        )
    )
    ts = _int(
        rec.get("exchange_event_ts_ns")
        or rec.get("ts_event_ns")
        or rec.get("ts_ns")
        or rec.get("sidecar_recv_ts_ns")
        or payload.get("exchange_event_ts_ns")
    )
    if price is None or quantity is None or quantity <= 0 or ts is None:
        return None
    return TradeTick(
        timestamp_ns=ts,
        price=price,
        quantity=quantity,
        aggressor_side=_aggressor(
            rec.get("aggressor", rec.get("aggressor_side", payload.get("aggressor_side")))
        ),
    )


def _current_extension(current: float, ib_high: float, ib_low: float) -> float:
    if current > ib_high:
        return current - ib_high
    if current < ib_low:
        return current - ib_low
    return 0.0


def _fmt(value: datetime) -> str:
    return value.astimezone(PT).strftime("%Y-%m-%d %H:%M:%S PT")


def _ns_from_pt(value: str) -> int | None:
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d %H:%M:%S PT").replace(tzinfo=PT)
    except ValueError:
        return None
    return int(parsed.astimezone(UTC).timestamp() * 1_000_000_000)


def _aggressor(value: Any) -> Literal["buy", "sell", "unknown"]:
    raw = str(value or "").lower()
    if raw in {"b", "buy", "bid", "buyer", "aggressor_buy"}:
        return "buy"
    if raw in {"s", "sell", "ask", "seller", "aggressor_sell"}:
        return "sell"
    return "unknown"


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
