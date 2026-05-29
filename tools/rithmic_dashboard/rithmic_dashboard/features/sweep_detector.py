"""Bounded-tail structural sweep detection."""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from rithmic_dashboard.models import SweepEvent, TradeTick
from rithmic_dashboard.session_state import PT

TICK_SIZE = 0.25
DEFAULT_MIN_TICKS = 3
DEFAULT_WINDOW_SECONDS = 60
DEFAULT_RECOVERY_SECONDS = 300


def detect_sweeps(
    ticks: list[TradeTick],
    levels: list[dict[str, Any]],
    *,
    min_ticks: int = DEFAULT_MIN_TICKS,
    window_seconds: int = DEFAULT_WINDOW_SECONDS,
    recovery_seconds: int = DEFAULT_RECOVERY_SECONDS,
) -> list[SweepEvent]:
    """Detect fast moves through structural levels.

    A sweep is a move from one side of a level through at least ``min_ticks``
    beyond that level inside ``window_seconds``.
    """

    ordered = sorted([tick for tick in ticks if tick.timestamp_ns is not None], key=_tick_ts)
    if not ordered:
        return []
    threshold = min_ticks * TICK_SIZE
    events: list[SweepEvent] = []
    latest_ts = _tick_ts(ordered[-1])
    for level in levels:
        price = _float(level.get("price"))
        if price is None:
            continue
        event = _detect_level_sweep(
            ordered,
            level=level,
            level_price=price,
            threshold=threshold,
            window_ns=window_seconds * 1_000_000_000,
            recovery_ns=recovery_seconds * 1_000_000_000,
            latest_ts=latest_ts,
        )
        if event is not None:
            events.append(event)
    return sorted(events, key=lambda event: event.timestamp_ns or 0, reverse=True)


def append_new_sweeps(path: Path, events: list[SweepEvent]) -> None:
    """Append sweep events, deduped by timestamp/level/direction."""

    if not events:
        return
    seen = _existing_keys(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for event in events:
            key = _event_key(event)
            if key in seen:
                continue
            f.write(_json_line(asdict(event)))
            seen.add(key)


def load_sweeps(path: Path) -> list[SweepEvent]:
    """Load persisted sweep events."""

    if not path.exists():
        return []
    events: list[SweepEvent] = []
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict):
            continue
        try:
            events.append(
                SweepEvent(
                    timestamp_pt=str(data["timestamp_pt"]),
                    timestamp_ns=_int(data.get("timestamp_ns")),
                    level_id=str(data["level_id"]),
                    level_text=str(data["level_text"]),
                    level_price=float(data["level_price"]),
                    direction=data.get("direction", "up"),
                    intensity_score=float(data["intensity_score"]),
                    recovered_within_5min=data.get("recovered_within_5min"),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return events


def _detect_level_sweep(
    ticks: list[TradeTick],
    *,
    level: dict[str, Any],
    level_price: float,
    threshold: float,
    window_ns: int,
    recovery_ns: int,
    latest_ts: int,
) -> SweepEvent | None:
    below: TradeTick | None = None
    above: TradeTick | None = None
    candidates: list[tuple[str, TradeTick, float]] = []
    for tick in ticks:
        ts = _tick_ts(tick)
        if below is not None and ts - _tick_ts(below) > window_ns:
            below = None
        if above is not None and ts - _tick_ts(above) > window_ns:
            above = None

        if tick.price <= level_price:
            below = tick
        if tick.price >= level_price:
            above = tick

        if below is not None and tick.price >= level_price + threshold:
            candidates.append(("up", tick, (tick.price - level_price) / TICK_SIZE))
        if above is not None and tick.price <= level_price - threshold:
            candidates.append(("down", tick, (level_price - tick.price) / TICK_SIZE))

    if not candidates:
        return None
    direction, end_tick, moved_ticks = max(candidates, key=lambda item: _tick_ts(item[1]))
    recovered = _recovered(
        ticks,
        level_price=level_price,
        direction=direction,
        event_ts=_tick_ts(end_tick),
        recovery_ns=recovery_ns,
        latest_ts=latest_ts,
    )
    return SweepEvent(
        timestamp_pt=_fmt_ts(_tick_ts(end_tick)),
        timestamp_ns=_tick_ts(end_tick),
        level_id=str(level.get("level_id", level.get("id", f"level-{level_price:.2f}"))),
        level_text=str(level.get("text", f"Level {level_price:.2f}")),
        level_price=level_price,
        direction="up" if direction == "up" else "down",
        intensity_score=round(max(1.0, min(5.0, moved_ticks / 3.0)), 2),
        recovered_within_5min=recovered,
    )


def _recovered(
    ticks: list[TradeTick],
    *,
    level_price: float,
    direction: str,
    event_ts: int,
    recovery_ns: int,
    latest_ts: int,
) -> bool | None:
    deadline = event_ts + recovery_ns
    for tick in ticks:
        ts = _tick_ts(tick)
        if ts <= event_ts or ts > deadline:
            continue
        if direction == "up" and tick.price <= level_price:
            return True
        if direction == "down" and tick.price >= level_price:
            return True
    if latest_ts < deadline:
        return None
    return False


def _existing_keys(path: Path) -> set[str]:
    if not path.exists():
        return set()
    keys: set[str] = set()
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            keys.add(
                "|".join(
                    [
                        str(data.get("timestamp_ns")),
                        str(data.get("level_id")),
                        str(data.get("direction")),
                    ]
                )
            )
    return keys


def _event_key(event: SweepEvent) -> str:
    return f"{event.timestamp_ns}|{event.level_id}|{event.direction}"


def _json_line(data: dict[str, Any]) -> str:
    return json.dumps(data, sort_keys=True) + "\n"


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _tick_ts(tick: TradeTick) -> int:
    return int(tick.timestamp_ns or 0)


def _fmt_ts(ts_ns: int) -> str:
    return datetime.fromtimestamp(ts_ns / 1_000_000_000, tz=UTC).astimezone(PT).strftime(
        "%Y-%m-%d %H:%M:%S PT"
    )


def _float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
