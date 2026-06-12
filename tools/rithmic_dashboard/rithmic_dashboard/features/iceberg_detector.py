"""Iceberg-like refill detector from MBO lifecycle plus OBS trade confirmation."""

from __future__ import annotations

import json
import math
import statistics
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from rithmic_dashboard.features.mbo_order_tracker import (
    _SOURCE_OBS,
    _SOURCE_OBS_PRIORITY,
    _SOURCE_PRIORITY,
    ConsumedOrder,
    MboOrderTracker,
    RollingConsumeState,
)
from rithmic_dashboard.models import IcebergEvent, IcebergSummary, MboOrderEvent, TradeTick
from rithmic_dashboard.session_state import PT

DEFAULT_REFILL_WINDOW_SECONDS = 30
DEFAULT_SIZE_CONSISTENCY_PCT = 0.40
DEFAULT_MIN_REFILLS = 3
DEFAULT_MIN_TOTAL_CONSUMED = 50
DEFAULT_RELEVANCE_MINUTES = 60
DEFAULT_STACK_WINDOW_MINUTES = 30
LEVEL_PROXIMITY_PTS = 5.0


@dataclass(frozen=True)
class IcebergDetectorConfig:
    """Tunable thresholds for inferred iceberg-like refill patterns."""

    min_refills: int = DEFAULT_MIN_REFILLS
    refill_window_seconds: int = DEFAULT_REFILL_WINDOW_SECONDS
    size_consistency_pct: float = DEFAULT_SIZE_CONSISTENCY_PCT
    aggressor_side_consistent: bool = True
    min_total_consumed: int = DEFAULT_MIN_TOTAL_CONSUMED
    stack_window_minutes: int = DEFAULT_STACK_WINDOW_MINUTES
    level_proximity_pts: float = LEVEL_PROXIMITY_PTS
    match_tolerance_ms: int = 50
    # RA-069: priority-queue-ONLY consumption confirmations (RA-065's channel,
    # confirmation_source="priority_queue") are an UNCALIBRATED signal until
    # RA-066 validates the FIFO sort direction. Default OFF: the detector admits
    # only OBS-confirmed consumptions, so production iceberg output is
    # byte-identical to the pre-RA-065 OBS-only detector even when priority data
    # is fully populated. RA-066 flips this True after walk-forward calibration.
    admit_priority_confirmation: bool = False


def detect_icebergs(
    *,
    mbo_events: tuple[MboOrderEvent, ...] | list[MboOrderEvent],
    trades: list[TradeTick],
    levels: list[dict[str, Any]],
    config: IcebergDetectorConfig | None = None,
    state: RollingConsumeState | None = None,
) -> tuple[IcebergEvent, ...]:
    """Detect repeated OBS-confirmed consumed-then-refilled MBO orders.

    ``state`` (Phase 4): when provided (replay), consumption is computed
    incrementally via a persistent order book + per-step re-match, byte-identical
    to the fresh per-window path. When None (production), a fresh tracker rebuilds
    the book from the whole window each call (unchanged behavior).
    """

    config = config or IcebergDetectorConfig()
    if state is None:
        consumed = MboOrderTracker(match_tolerance_ms=config.match_tolerance_ms).process(
            mbo_events,
            trades,
        )
    else:
        consumed = state.step(mbo_events, trades)
    if not config.admit_priority_confirmation:
        # RA-069 (blocker fix): drop priority-queue-ONLY confirmations — these are
        # consumptions RA-065 inferred purely from front-of-queue position when
        # OBS was silent, an uncalibrated signal until RA-066. obs+priority rows
        # are retained (OBS confirmed them), so the surviving set is byte-identical
        # to the pre-RA-065 OBS-only detector even with priority fully populated.
        consumed = tuple(
            order for order in consumed if order.confirmation_source != _SOURCE_PRIORITY
        )
    events = _events_from_consumed(consumed, levels, config=config)
    return tuple(sorted(events, key=lambda item: item.timestamp_ns or 0, reverse=True))


def append_new_iceberg_events(path: Path, events: tuple[IcebergEvent, ...]) -> list[IcebergEvent]:
    """Append unseen iceberg events to canonical live-analysis JSONL."""

    if not events:
        return []
    seen = _existing_keys(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    appended: list[IcebergEvent] = []
    with path.open("a", encoding="utf-8") as f:
        for event in events:
            key = event_key(event)
            if key in seen:
                continue
            f.write(json.dumps(_event_row(event), sort_keys=True) + "\n")
            seen.add(key)
            appended.append(event)
    return appended


def load_iceberg_events(path: Path) -> list[IcebergEvent]:
    """Load canonical iceberg JSONL events."""

    if not path.exists():
        return []
    events: list[IcebergEvent] = []
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        try:
            row = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            event = _event_from_row(row)
            if event is not None:
                events.append(event)
    return events


def recent_iceberg_events(
    events: list[IcebergEvent],
    now_pt: datetime,
    *,
    minutes: int = DEFAULT_RELEVANCE_MINUTES,
) -> list[IcebergEvent]:
    """Return newest iceberg events still relevant for display/EV."""

    cutoff = now_pt.astimezone(PT) - timedelta(minutes=minutes)
    filtered = [
        event
        for event in events
        if event.timestamp_ns is None or _event_time(event.timestamp_ns) >= cutoff
    ]
    return sorted(filtered, key=lambda event: event.timestamp_ns or 0, reverse=True)


def summarize_icebergs(events: tuple[IcebergEvent, ...] | list[IcebergEvent]) -> IcebergSummary:
    """Build compact dashboard pulse summary."""

    event_list = list(events)
    if not event_list:
        return IcebergSummary(0, None, None, None, 0, None)
    latest = sorted(event_list, key=lambda event: event.timestamp_ns or 0, reverse=True)[0]
    long_consumed = sum(event.total_consumed for event in event_list if event.direction == "long")
    short_consumed = sum(event.total_consumed for event in event_list if event.direction == "short")
    dominant: Literal["long", "short", "neutral"] = "neutral"
    if long_consumed > short_consumed:
        dominant = "long"
    elif short_consumed > long_consumed:
        dominant = "short"
    return IcebergSummary(
        active_count=len(event_list),
        latest_event=latest.description,
        top_level_text=latest.level_text,
        top_level_price=latest.level_price,
        total_consumed=sum(event.total_consumed for event in event_list),
        dominant_direction=dominant,
    )


def load_iceberg_thresholds(path: Path) -> IcebergDetectorConfig:
    """Load calibrated iceberg thresholds, falling back to approved defaults."""

    if not path.exists():
        return IcebergDetectorConfig()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return IcebergDetectorConfig()
    if not isinstance(data, dict):
        return IcebergDetectorConfig()
    raw_thresholds = data.get("thresholds", data)
    if not isinstance(raw_thresholds, dict):
        return IcebergDetectorConfig()
    default = IcebergDetectorConfig()
    return IcebergDetectorConfig(
        min_refills=max(1, _int(raw_thresholds.get("min_refills")) or default.min_refills),
        refill_window_seconds=max(
            1,
            _int(raw_thresholds.get("refill_window_seconds"))
            or default.refill_window_seconds,
        ),
        size_consistency_pct=max(
            0.0,
            _float(raw_thresholds.get("size_consistency_pct"))
            or default.size_consistency_pct,
        ),
        aggressor_side_consistent=_bool(
            raw_thresholds.get("aggressor_side_consistent"),
            default=default.aggressor_side_consistent,
        ),
        min_total_consumed=max(
            1,
            _int(raw_thresholds.get("min_total_consumed")) or default.min_total_consumed,
        ),
        stack_window_minutes=max(
            1,
            _int(raw_thresholds.get("stack_window_minutes")) or default.stack_window_minutes,
        ),
        level_proximity_pts=max(
            0.0,
            _float(raw_thresholds.get("level_proximity_pts")) or default.level_proximity_pts,
        ),
        match_tolerance_ms=max(
            1,
            _int(raw_thresholds.get("match_tolerance_ms")) or default.match_tolerance_ms,
        ),
        admit_priority_confirmation=_bool(
            raw_thresholds.get("admit_priority_confirmation"),
            default=default.admit_priority_confirmation,
        ),
    )


def event_key(event: IcebergEvent) -> str:
    return (
        f"{event.event_type}|{event.level_id}|{event.side}|{event.timestamp_ns}|"
        f"{event.refill_count}|{event.total_consumed}"
    )


def _events_from_consumed(
    consumed: tuple[ConsumedOrder, ...],
    levels: list[dict[str, Any]],
    *,
    config: IcebergDetectorConfig,
) -> list[IcebergEvent]:
    groups: dict[tuple[str, int], list[ConsumedOrder]] = {}
    for item in consumed:
        groups.setdefault((item.side, round(item.price / 0.25)), []).append(item)

    events: list[IcebergEvent] = []
    for rows in groups.values():
        rows = sorted(rows, key=lambda item: item.add_ts_ns)
        for run in _runs(rows, config=config):
            event = _event_from_run(run, levels, config=config)
            if event is not None:
                events.append(event)
    return events


def _runs(rows: list[ConsumedOrder], *, config: IcebergDetectorConfig) -> list[list[ConsumedOrder]]:
    if not rows:
        return []
    completed: list[list[ConsumedOrder]] = []
    current: list[ConsumedOrder] = [rows[0]]
    max_gap_ns = config.refill_window_seconds * 1_000_000_000
    for row in rows[1:]:
        previous = current[-1]
        same_side = row.side == previous.side
        refill_gap_ok = row.add_ts_ns - previous.consume_ts_ns <= max_gap_ns
        aggressor_ok = (
            row.aggressor_side == previous.aggressor_side
            or not config.aggressor_side_consistent
        )
        if same_side and refill_gap_ok and aggressor_ok:
            current.append(row)
        else:
            completed.append(current)
            current = [row]
    completed.append(current)
    return completed


def _event_from_run(
    run: list[ConsumedOrder],
    levels: list[dict[str, Any]],
    *,
    config: IcebergDetectorConfig,
) -> IcebergEvent | None:
    if len(run) < config.min_refills:
        return None
    sizes = [max(1, item.visible_size) for item in run]
    median_size = statistics.median(sizes)
    if median_size <= 0:
        return None
    max_deviation = max(abs(size - median_size) / median_size for size in sizes)
    if max_deviation > config.size_consistency_pct:
        return None
    total_consumed = sum(max(0, item.consumed_qty) for item in run)
    if total_consumed < config.min_total_consumed:
        return None
    first = run[0]
    latest = run[-1]
    side: Literal["bid", "ask"] = "bid" if first.side == "B" else "ask"
    direction: Literal["long", "short"] = "long" if side == "bid" else "short"
    level_id, level_text, level_price = _resolve_level(
        first.price,
        levels,
        side=side,
        proximity_pts=config.level_proximity_pts,
    )
    confidence = _confidence(run, total_consumed, config=config)
    intensity = max(
        len(run) / max(config.min_refills, 1),
        total_consumed / max(config.min_total_consumed, 1),
    )
    side_text = "bid-side" if side == "bid" else "ask-side"
    confirmation_source, confirmation_text = _run_confirmation(run)
    description = (
        f"Iceberg-like {side_text} refill at {level_text}: {len(run)} refills, "
        f"{total_consumed:,} consumed via {confirmation_text}"
    )
    return IcebergEvent(
        timestamp_pt=_fmt_ns(latest.consume_ts_ns),
        timestamp_ns=latest.consume_ts_ns,
        event_type="iceberg_detected",
        level_id=level_id,
        level_text=level_text,
        level_price=level_price,
        side=side,
        direction=direction,
        refill_count=len(run),
        total_consumed=total_consumed,
        median_refill_size=float(median_size),
        window_seconds=config.refill_window_seconds,
        confidence=confidence,
        intensity=float(intensity),
        description=description,
        metadata={
            "price": first.price,
            "side": side,
            "mbo_side": first.side,
            "refill_count": len(run),
            "total_consumed": total_consumed,
            "median_refill_size": float(median_size),
            "window_seconds": config.refill_window_seconds,
            "size_consistency_pct": config.size_consistency_pct,
            "aggressor_side": first.aggressor_side,
            "confirmation_source": confirmation_source,
            "match_tolerance_ms": config.match_tolerance_ms,
        },
    )


def _run_confirmation(run: list[ConsumedOrder]) -> tuple[str, str]:
    """Derive an iceberg run's consumption provenance as (metadata_tag, human_text).

    Byte-exact with the pre-RA-065 OBS-only detector whenever no priority-ONLY
    confirmations are present — which is always true on the default gated-off path,
    since ``detect_icebergs`` filters ``confirmation_source == "priority_queue"``
    out unless ``config.admit_priority_confirmation``. Returns
    ``("obs_trade_tail", "OBS confirmation")`` there, including for retained
    ``obs+priority`` rows (OBS still confirmed those). When RA-066 admits the
    priority channel, the tag reflects whether OBS also contributed.

    NOTE: downstream narrative (probability_adjuster, posture_synthesis) still
    hard-codes "OBS confirmation" — accurate while ``admit_priority_confirmation``
    is False (the shipped default). RA-066 must update those when it flips it on.
    """
    sources = {row.confirmation_source for row in run}
    if _SOURCE_PRIORITY not in sources:
        return _SOURCE_OBS, "OBS confirmation"
    if sources & {_SOURCE_OBS, _SOURCE_OBS_PRIORITY}:
        return _SOURCE_OBS_PRIORITY, "OBS+priority confirmation"
    return _SOURCE_PRIORITY, "priority-queue confirmation"


def _confidence(
    run: list[ConsumedOrder],
    total_consumed: int,
    *,
    config: IcebergDetectorConfig,
) -> Literal["high", "medium", "low"]:
    if (
        len(run) >= math.ceil(config.min_refills * 1.5)
        and total_consumed >= math.ceil(config.min_total_consumed * 1.5)
    ):
        return "high"
    return "medium"


def _resolve_level(
    price: float,
    levels: list[dict[str, Any]],
    *,
    side: Literal["bid", "ask"],
    proximity_pts: float,
) -> tuple[str, str, float]:
    eligible: list[tuple[float, float, dict[str, Any]]] = []
    for level in levels:
        level_price = _float(level.get("price"))
        if level_price is None:
            continue
        distance = abs(price - level_price)
        if distance <= proximity_pts:
            eligible.append((distance, level_price, level))
    if eligible:
        _, level_price, level = sorted(eligible, key=lambda item: (item[0], item[1]))[0]
        level_id = str(level.get("level_id", level.get("id", f"iceberg-{level_price:.2f}")))
        level_text = str(level.get("text", f"Level {level_price:,.2f}"))
        return level_id, level_text, level_price
    level_id = f"iceberg-{side}-{price:.2f}"
    return level_id, f"Iceberg {side} {price:,.2f}", price


def _event_row(event: IcebergEvent) -> dict[str, Any]:
    row = asdict(event)
    row["family"] = "iceberg"
    row["price"] = event.level_price
    return row


def _event_from_row(row: dict[str, Any]) -> IcebergEvent | None:
    try:
        side = _side(row.get("side"))
        direction = _direction(row.get("direction"))
        return IcebergEvent(
            timestamp_pt=str(row["timestamp_pt"]),
            timestamp_ns=_int(row.get("timestamp_ns")),
            event_type=_event_type(row.get("event_type")),
            level_id=str(row["level_id"]),
            level_text=str(row["level_text"]),
            level_price=float(row["level_price"]),
            side=side,
            direction=direction,
            refill_count=int(row["refill_count"]),
            total_consumed=int(row["total_consumed"]),
            median_refill_size=float(row["median_refill_size"]),
            window_seconds=int(row["window_seconds"]),
            confidence=_event_confidence(row.get("confidence")),
            intensity=float(row["intensity"]),
            description=str(row["description"]),
            metadata=_metadata(row.get("metadata")),
        )
    except (KeyError, TypeError, ValueError):
        return None


def _existing_keys(path: Path) -> set[str]:
    return {event_key(event) for event in load_iceberg_events(path)}


def _metadata(value: Any) -> dict[str, float | int | str | bool | None]:
    if not isinstance(value, dict):
        return {}
    clean: dict[str, float | int | str | bool | None] = {}
    for key, item in value.items():
        if isinstance(item, bool | int | float | str) or item is None:
            clean[str(key)] = item
    return clean


def _event_type(value: Any) -> Literal["iceberg_detected", "iceberg_high_intensity_stack_detected"]:
    if value == "iceberg_high_intensity_stack_detected":
        return "iceberg_high_intensity_stack_detected"
    return "iceberg_detected"


def _side(value: Any) -> Literal["bid", "ask"]:
    return "ask" if str(value).lower() == "ask" else "bid"


def _direction(value: Any) -> Literal["long", "short"]:
    return "short" if str(value).lower() in {"short", "sell", "ask"} else "long"


def _event_confidence(value: Any) -> Literal["high", "medium", "low"]:
    raw = str(value or "").lower()
    if raw == "high":
        return "high"
    if raw == "low":
        return "low"
    return "medium"


def _event_time(ts_ns: int) -> datetime:
    return datetime.fromtimestamp(ts_ns / 1_000_000_000, tz=UTC).astimezone(PT)


def _fmt_ns(value: int) -> str:
    return _event_time(value).strftime("%Y-%m-%d %H:%M:%S PT")


def _float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _bool(value: Any, *, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    raw = str(value or "").strip().lower()
    if raw in {"1", "true", "yes", "y"}:
        return True
    if raw in {"0", "false", "no", "n"}:
        return False
    return default


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
