"""Institutional trade concentration and block-flow detection."""

from __future__ import annotations

import json
import math
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from rithmic_dashboard.features.trade_size_classifier import (
    TradeSizeClass,
    TradeSizeThresholds,
    classify_trade_size,
)
from rithmic_dashboard.models import InstitutionalFlowEvent, InstitutionalFlowSummary, TradeTick
from rithmic_dashboard.session_state import PT

CONCENTRATION_WINDOW_MINUTES = 15
CONCENTRATION_RELEVANCE_MINUTES = 60
BLOCK_RELEVANCE_MINUTES = 30
MIN_CONCENTRATION_TRADES = 3
MIN_CONCENTRATION_ABS_DELTA = 100
MIN_HIGH_CONFIDENCE_TAIL_MINUTES = 60.0
LEVEL_PROXIMITY_PTS = 5.0


@dataclass(frozen=True)
class InstitutionalFlowResult:
    """Detected institutional events plus compact summary stats."""

    events: tuple[InstitutionalFlowEvent, ...]
    summary: InstitutionalFlowSummary


@dataclass(frozen=True)
class _QualifiedTrade:
    tick: TradeTick
    level_id: str
    level_text: str
    level_price: float
    size_class: TradeSizeClass

    @property
    def side(self) -> Literal["buy", "sell"]:
        return "sell" if self.tick.aggressor_side == "sell" else "buy"

    @property
    def signed_qty(self) -> int:
        return self.tick.quantity if self.side == "buy" else -self.tick.quantity


def compute_institutional_flow(
    ticks: list[TradeTick],
    levels: list[dict[str, Any]],
    *,
    thresholds: TradeSizeThresholds,
    tail_span_minutes: float,
    proximity_pts: float = LEVEL_PROXIMITY_PTS,
) -> InstitutionalFlowResult:
    """Detect institutional concentrations and blocks near structural levels."""

    qualified = _qualified_trades(
        ticks,
        levels,
        thresholds=thresholds,
        proximity_pts=proximity_pts,
    )
    confidence: Literal["high", "low_tail_span"] = (
        "high" if tail_span_minutes >= MIN_HIGH_CONFIDENCE_TAIL_MINUTES else "low_tail_span"
    )
    events: list[InstitutionalFlowEvent] = []
    events.extend(
        _block_events(
            qualified,
            thresholds=thresholds,
            confidence=confidence,
            tail_span_minutes=tail_span_minutes,
        )
    )
    events.extend(
        _concentration_events(
            qualified,
            confidence=confidence,
            tail_span_minutes=tail_span_minutes,
        )
    )
    events.sort(key=lambda event: event.timestamp_ns or 0, reverse=True)
    summary = summarize_institutional_flow(
        tuple(events),
        qualified=qualified,
        relevance_minutes=CONCENTRATION_RELEVANCE_MINUTES,
    )
    return InstitutionalFlowResult(events=tuple(events), summary=summary)


def append_new_institutional_flow_events(
    path: Path,
    events: tuple[InstitutionalFlowEvent, ...] | list[InstitutionalFlowEvent],
) -> list[InstitutionalFlowEvent]:
    """Append unseen institutional-flow events to canonical live-analysis JSONL."""

    if not events:
        return []
    seen = _existing_keys(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    appended: list[InstitutionalFlowEvent] = []
    with path.open("a", encoding="utf-8") as f:
        for event in events:
            key = event_key(event)
            if key in seen:
                continue
            f.write(json.dumps(_event_row(event), sort_keys=True) + "\n")
            seen.add(key)
            appended.append(event)
    return appended


def load_institutional_flow_events(path: Path) -> list[InstitutionalFlowEvent]:
    """Load canonical institutional-flow JSONL rows."""

    if not path.exists():
        return []
    events: list[InstitutionalFlowEvent] = []
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict):
            continue
        event = _event_from_row(data)
        if event is not None:
            events.append(event)
    return events


def recent_institutional_flow_events(
    events: list[InstitutionalFlowEvent],
    now_pt: datetime,
    *,
    minutes: int = CONCENTRATION_RELEVANCE_MINUTES,
) -> list[InstitutionalFlowEvent]:
    """Return newest institutional-flow events still relevant for display/EV."""

    cutoff = now_pt.astimezone(PT) - timedelta(minutes=minutes)
    filtered = [
        event
        for event in events
        if event.timestamp_ns is None or _event_time(event.timestamp_ns) >= cutoff
    ]
    return sorted(filtered, key=lambda event: event.timestamp_ns or 0, reverse=True)


def summarize_institutional_flow(
    events: tuple[InstitutionalFlowEvent, ...] | list[InstitutionalFlowEvent],
    *,
    qualified: list[_QualifiedTrade] | None = None,
    relevance_minutes: int = CONCENTRATION_RELEVANCE_MINUTES,
) -> InstitutionalFlowSummary:
    """Build the compact pulse summary from recent events or qualified trades."""

    rows = list(qualified or [])
    event_list = sorted(events, key=lambda event: event.timestamp_ns or 0, reverse=True)
    if rows:
        latest_ts = max(_tick_ts(row.tick) for row in rows)
        cutoff = latest_ts - int(timedelta(minutes=relevance_minutes).total_seconds() * 1e9)
        rows = [row for row in rows if _tick_ts(row.tick) >= cutoff]
        total_volume = sum(row.tick.quantity for row in rows)
        net_delta = sum(row.signed_qty for row in rows)
        block_count = sum(1 for row in rows if row.size_class == "block")
    else:
        total_volume = sum(event.institutional_volume for event in event_list)
        net_delta = sum(event.net_delta for event in event_list)
        block_count = sum(event.block_count for event in event_list)

    volume_by_zone: dict[tuple[str, str, float], int] = defaultdict(int)
    for row in rows:
        volume_by_zone[(row.level_id, row.level_text, row.level_price)] += row.tick.quantity
    top_zone_text: str | None = None
    top_zone_price: float | None = None
    top_zone_volume_pct: float | None = None
    if volume_by_zone and total_volume > 0:
        (_, top_zone_text, top_zone_price), top_volume = max(
            volume_by_zone.items(),
            key=lambda item: item[1],
        )
        top_zone_volume_pct = top_volume / total_volume

    if not volume_by_zone and total_volume > 0:
        for event in event_list:
            volume_by_zone[(event.level_id, event.level_text, event.level_price)] += (
                event.institutional_volume
            )
        if volume_by_zone:
            (_, top_zone_text, top_zone_price), top_volume = max(
                volume_by_zone.items(),
                key=lambda item: item[1],
            )
            top_zone_volume_pct = top_volume / total_volume
    latest_event = event_list[0].description if event_list else None
    return InstitutionalFlowSummary(
        total_institutional_volume=total_volume,
        net_institutional_delta=net_delta,
        block_trade_count=block_count,
        concentration_count=sum(
            1 for event in event_list if event.event_type == "institutional_concentration_detected"
        ),
        top_zone_text=top_zone_text,
        top_zone_price=top_zone_price,
        top_zone_volume_pct=top_zone_volume_pct,
        latest_event=latest_event,
    )


def event_key(event: InstitutionalFlowEvent) -> str:
    """Stable dedupe key for canonical institutional-flow events."""

    return (
        f"{event.event_type}|{event.level_id}|{event.side}|"
        f"{event.timestamp_ns}|{event.trade_count}|{event.net_delta}|{event.largest_trade}"
    )


def _qualified_trades(
    ticks: list[TradeTick],
    levels: list[dict[str, Any]],
    *,
    thresholds: TradeSizeThresholds,
    proximity_pts: float,
) -> list[_QualifiedTrade]:
    qualified: list[_QualifiedTrade] = []
    ordered = sorted(
        [
            tick
            for tick in ticks
            if tick.timestamp_ns is not None and tick.aggressor_side in {"buy", "sell"}
        ],
        key=_tick_ts,
    )
    for tick in ordered:
        size_class = classify_trade_size(tick.quantity, thresholds)
        if size_class not in {"institutional", "block"}:
            continue
        level = _nearest_level(tick.price, levels, max_distance=proximity_pts)
        if level is None:
            continue
        level_price = _float(level.get("price"))
        if level_price is None:
            continue
        qualified.append(
            _QualifiedTrade(
                tick=tick,
                level_id=str(level.get("level_id", level.get("id", f"level-{level_price:.2f}"))),
                level_text=str(level.get("text", f"Level {level_price:.2f}")),
                level_price=level_price,
                size_class=size_class,
            )
        )
    return qualified


def _block_events(
    qualified: list[_QualifiedTrade],
    *,
    thresholds: TradeSizeThresholds,
    confidence: Literal["high", "low_tail_span"],
    tail_span_minutes: float,
) -> list[InstitutionalFlowEvent]:
    events: list[InstitutionalFlowEvent] = []
    for row in qualified:
        if row.size_class != "block":
            continue
        signed = row.signed_qty
        ts = _tick_ts(row.tick)
        events.append(
            InstitutionalFlowEvent(
                timestamp_pt=_fmt_ts(ts),
                timestamp_ns=ts,
                event_type="block_trade_at_zone",
                level_id=row.level_id,
                level_text=row.level_text,
                level_price=row.level_price,
                side=row.side,
                trade_count=1,
                institutional_volume=row.tick.quantity,
                net_delta=signed,
                block_count=1,
                largest_trade=row.tick.quantity,
                window_minutes=0,
                confidence=confidence,
                tail_span_minutes=tail_span_minutes,
                intensity=min(5.0, max(1.0, row.tick.quantity / thresholds.block_min)),
                description=(
                    f"{row.side} block {row.tick.quantity:,} at {row.level_text} "
                    f"({row.level_price:,.2f})"
                ),
            )
        )
    return events


def _concentration_events(
    qualified: list[_QualifiedTrade],
    *,
    confidence: Literal["high", "low_tail_span"],
    tail_span_minutes: float,
) -> list[InstitutionalFlowEvent]:
    if not qualified:
        return []
    latest_ts = max(_tick_ts(row.tick) for row in qualified)
    cutoff = latest_ts - int(timedelta(minutes=CONCENTRATION_WINDOW_MINUTES).total_seconds() * 1e9)
    recent = [row for row in qualified if _tick_ts(row.tick) >= cutoff]
    grouped: dict[str, list[_QualifiedTrade]] = defaultdict(list)
    for row in recent:
        grouped[row.level_id].append(row)

    events: list[InstitutionalFlowEvent] = []
    for rows in grouped.values():
        trade_count = len(rows)
        net_delta = sum(row.signed_qty for row in rows)
        if trade_count < MIN_CONCENTRATION_TRADES:
            continue
        if abs(net_delta) <= MIN_CONCENTRATION_ABS_DELTA:
            continue
        rows = sorted(rows, key=lambda row: _tick_ts(row.tick))
        latest = rows[-1]
        side: Literal["buy", "sell"] = "buy" if net_delta > 0 else "sell"
        volume = sum(row.tick.quantity for row in rows)
        block_count = sum(1 for row in rows if row.size_class == "block")
        largest_trade = max(row.tick.quantity for row in rows)
        ts = _tick_ts(latest.tick)
        events.append(
            InstitutionalFlowEvent(
                timestamp_pt=_fmt_ts(ts),
                timestamp_ns=ts,
                event_type="institutional_concentration_detected",
                level_id=latest.level_id,
                level_text=latest.level_text,
                level_price=latest.level_price,
                side=side,
                trade_count=trade_count,
                institutional_volume=volume,
                net_delta=net_delta,
                block_count=block_count,
                largest_trade=largest_trade,
                window_minutes=CONCENTRATION_WINDOW_MINUTES,
                confidence=confidence,
                tail_span_minutes=tail_span_minutes,
                intensity=min(5.0, max(1.0, abs(net_delta) / MIN_CONCENTRATION_ABS_DELTA)),
                description=(
                    f"{side} institutional concentration at {latest.level_text} "
                    f"({latest.level_price:,.2f}): {trade_count} trades, "
                    f"net delta {net_delta:+,}, vol {volume:,}"
                ),
            )
        )
    return events


def _event_row(event: InstitutionalFlowEvent) -> dict[str, Any]:
    row = asdict(event)
    row["family"] = "institutional_flow"
    row["direction"] = "long" if event.side == "buy" else "short"
    row["price"] = event.level_price
    row["metadata"] = {
        "trade_count": event.trade_count,
        "institutional_volume": event.institutional_volume,
        "net_delta": event.net_delta,
        "block_count": event.block_count,
        "largest_trade": event.largest_trade,
        "window_minutes": event.window_minutes,
        "tail_span_minutes": event.tail_span_minutes,
    }
    return row


def _event_from_row(data: dict[str, Any]) -> InstitutionalFlowEvent | None:
    try:
        event_type = _event_type(data.get("event_type"))
        side = _side(data.get("side"))
        return InstitutionalFlowEvent(
            timestamp_pt=str(data["timestamp_pt"]),
            timestamp_ns=_int(data.get("timestamp_ns")),
            event_type=event_type,
            level_id=str(data["level_id"]),
            level_text=str(data["level_text"]),
            level_price=float(data["level_price"]),
            side=side,
            trade_count=int(data["trade_count"]),
            institutional_volume=int(data["institutional_volume"]),
            net_delta=int(data["net_delta"]),
            block_count=int(data["block_count"]),
            largest_trade=int(data["largest_trade"]),
            window_minutes=int(data["window_minutes"]),
            confidence=_confidence(data.get("confidence")),
            tail_span_minutes=float(data["tail_span_minutes"]),
            intensity=float(data["intensity"]),
            description=str(data["description"]),
        )
    except (KeyError, TypeError, ValueError):
        return None


def _existing_keys(path: Path) -> set[str]:
    return {event_key(event) for event in load_institutional_flow_events(path)}


def _nearest_level(
    price: float,
    levels: list[dict[str, Any]],
    *,
    max_distance: float,
) -> dict[str, Any] | None:
    eligible: list[tuple[float, float, dict[str, Any]]] = []
    for level in levels:
        level_price = _float(level.get("price"))
        if level_price is None:
            continue
        distance = abs(price - level_price)
        if distance <= max_distance:
            eligible.append((distance, level_price, level))
    if not eligible:
        return None
    return sorted(eligible, key=lambda item: (item[0], item[1]))[0][2]


def _tick_ts(tick: TradeTick) -> int:
    return int(tick.timestamp_ns or 0)


def _event_time(ts_ns: int) -> datetime:
    return datetime.fromtimestamp(ts_ns / 1_000_000_000, tz=UTC).astimezone(PT)


def _fmt_ts(ts_ns: int) -> str:
    return _event_time(ts_ns).strftime("%Y-%m-%d %H:%M:%S PT")


def _event_type(
    value: Any,
) -> Literal["institutional_concentration_detected", "block_trade_at_zone"]:
    if value == "block_trade_at_zone":
        return "block_trade_at_zone"
    return "institutional_concentration_detected"


def _side(value: Any) -> Literal["buy", "sell"]:
    return "sell" if value == "sell" else "buy"


def _confidence(value: Any) -> Literal["high", "low_tail_span"]:
    return "low_tail_span" if value == "low_tail_span" else "high"


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
