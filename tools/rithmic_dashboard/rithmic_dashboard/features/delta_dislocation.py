"""Delta-dislocation detection from bounded live trade tails."""

from __future__ import annotations

import json
import math
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, cast

from rithmic_dashboard.models import DeltaDislocationEvent, LiveVwap, TradeTick
from rithmic_dashboard.session_state import PT

TICK_SIZE = 0.25
WINDOW_MINUTES = 60
MIN_HIGH_CONFIDENCE_TAIL_MINUTES = 55.0
DEFAULT_PROXIMITY_PTS = 14.0
STRONG_THRESHOLD_MULTIPLE = 2.5


def detect_delta_dislocations(
    ticks: list[TradeTick],
    levels: list[dict[str, Any]],
    *,
    threshold: float,
    live_vwap: LiveVwap | None = None,
    atr: float | None = None,
    min_tail_minutes: float = MIN_HIGH_CONFIDENCE_TAIL_MINUTES,
) -> list[DeltaDislocationEvent]:
    """Detect candle/CVD dislocations near the closest structural level."""

    ordered = sorted([tick for tick in ticks if tick.timestamp_ns is not None], key=_tick_ts)
    if len(ordered) < 2 or threshold <= 0:
        return []
    latest = ordered[-1]
    latest_ts = _tick_ts(latest)
    window_start = latest_ts - int(timedelta(minutes=WINDOW_MINUTES).total_seconds() * 1e9)
    window_ticks = [tick for tick in ordered if _tick_ts(tick) >= window_start]
    if len(window_ticks) < 2:
        return []

    proximity_limit = _proximity_limit(live_vwap=live_vwap, atr=atr)
    level = _nearest_level(latest.price, levels, proximity_limit)
    if level is None:
        return []

    candle_direction = _candle_direction(window_ticks)
    hourly_cvd = sum(_signed_qty(tick) for tick in window_ticks)
    side: Literal["long", "short"] | None = None
    if candle_direction == "down" and hourly_cvd >= threshold:
        side = "long"
    elif candle_direction == "up" and hourly_cvd <= -threshold:
        side = "short"
    if side is None:
        return []

    level_price = float(level["price"])
    first_ts = _tick_ts(ordered[0])
    tail_span_minutes = max(0.0, (latest_ts - first_ts) / 60_000_000_000)
    confidence: Literal["high", "low_tail_span"] = (
        "high" if tail_span_minutes >= min_tail_minutes else "low_tail_span"
    )
    return [
        DeltaDislocationEvent(
            timestamp_pt=_fmt_ts(latest_ts),
            timestamp_ns=latest_ts,
            side=side,
            level_id=str(level.get("level_id", level.get("id", f"level-{level_price:.2f}"))),
            level_text=str(level.get("text", f"Level {level_price:.2f}")),
            level_price=level_price,
            candle_direction=candle_direction,
            hourly_cvd=int(hourly_cvd),
            threshold_used=float(threshold),
            proximity_pts=abs(latest.price - level_price),
            confidence=confidence,
            rolling_window_start_ts=window_start,
            tail_span_minutes=tail_span_minutes,
            is_strong=abs(hourly_cvd) >= threshold * STRONG_THRESHOLD_MULTIPLE,
        )
    ]


def dislocation_levels(
    envelope: dict[str, Any],
    *,
    live_vwap: LiveVwap | None = None,
) -> list[dict[str, Any]]:
    """Return structural levels eligible for delta-dislocation proximity."""

    levels: list[dict[str, Any]] = []
    for line in envelope.get("reference_lines", []):
        if not isinstance(line, dict):
            continue
        price = _float(line.get("price"))
        if price is None:
            continue
        source = str(line.get("source", "reference"))
        levels.append(
            {
                "level_id": f"ref-{source}-{price:.2f}",
                "text": str(line.get("text", source)),
                "source": source,
                "price": price,
                "priority": _source_priority(source),
            }
        )

    if live_vwap is not None and live_vwap.vwap is not None:
        _append_live_vwap_levels(levels, live_vwap)

    for zone in envelope.get("zones", []):
        if not isinstance(zone, dict):
            continue
        top = _float(zone.get("top"))
        bot = _float(zone.get("bot"))
        if top is None or bot is None:
            continue
        price = (top + bot) / 2.0
        conviction = str(zone.get("conviction", "LOW"))
        levels.append(
            {
                "level_id": str(zone.get("id", f"zone-{price:.2f}")),
                "text": str(zone.get("text", f"{conviction} zone")),
                "source": "zone",
                "price": price,
                "priority": 1 if conviction in {"HIGH", "SUPER"} else 5,
            }
        )
    return _dedupe_levels(levels)


def append_new_delta_dislocations(
    path: Path,
    events: list[DeltaDislocationEvent],
) -> list[DeltaDislocationEvent]:
    """Append new delta-dislocation events using the approved dedup hash."""

    if not events:
        return []
    seen = _existing_keys(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    appended: list[DeltaDislocationEvent] = []
    with path.open("a", encoding="utf-8") as f:
        for event in events:
            key = event_key(event)
            if key in seen:
                continue
            f.write(json.dumps(asdict(event), sort_keys=True) + "\n")
            seen.add(key)
            appended.append(event)
    return appended


def append_dislocation_alerts(path: Path, events: list[DeltaDislocationEvent]) -> None:
    """Persist local alert records for future Slack/email integration."""

    if not events:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for event in events:
            f.write(
                json.dumps(
                    {
                        "event_type": f"delta_dislocation_{event.side}",
                        "timestamp_pt": event.timestamp_pt,
                        "level_id": event.level_id,
                        "level_price": event.level_price,
                        "hourly_cvd": event.hourly_cvd,
                        "confidence": event.confidence,
                        "is_strong": event.is_strong,
                    },
                    sort_keys=True,
                )
                + "\n"
            )


def load_delta_dislocations(path: Path) -> list[DeltaDislocationEvent]:
    """Load persisted delta-dislocation events."""

    if not path.exists():
        return []
    events: list[DeltaDislocationEvent] = []
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict):
            continue
        try:
            events.append(
                DeltaDislocationEvent(
                    timestamp_pt=str(data["timestamp_pt"]),
                    timestamp_ns=_int(data.get("timestamp_ns")),
                    side=_side(data.get("side")),
                    level_id=str(data["level_id"]),
                    level_text=str(data["level_text"]),
                    level_price=float(data["level_price"]),
                    candle_direction=_candle_value(data.get("candle_direction")),
                    hourly_cvd=int(data["hourly_cvd"]),
                    threshold_used=float(data["threshold_used"]),
                    proximity_pts=float(data["proximity_pts"]),
                    confidence=_confidence(data.get("confidence")),
                    rolling_window_start_ts=_int(data.get("rolling_window_start_ts")),
                    tail_span_minutes=float(data["tail_span_minutes"]),
                    is_strong=bool(data["is_strong"]),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return events


def event_key(event: DeltaDislocationEvent) -> str:
    """Approved dedup key: (level_id, side, rolling_window_start_ts)."""

    return f"{event.level_id}|{event.side}|{event.rolling_window_start_ts}"


def _nearest_level(
    price: float,
    levels: list[dict[str, Any]],
    max_distance: float,
) -> dict[str, Any] | None:
    eligible = []
    for level in levels:
        level_price = _float(level.get("price"))
        if level_price is None:
            continue
        distance = abs(price - level_price)
        if distance <= max_distance:
            eligible.append((distance, int(level.get("priority", 9)), level_price, level))
    if not eligible:
        return None
    return sorted(eligible, key=lambda item: (item[0], item[1], item[2]))[0][3]


def _proximity_limit(*, live_vwap: LiveVwap | None, atr: float | None) -> float:
    if live_vwap is not None and live_vwap.sigma is not None and live_vwap.sigma > 0:
        return max(TICK_SIZE, 0.25 * live_vwap.sigma)
    if atr is not None and atr > 0:
        return max(TICK_SIZE, 0.5 * atr)
    return DEFAULT_PROXIMITY_PTS


def _candle_direction(ticks: list[TradeTick]) -> Literal["up", "down", "flat"]:
    delta = ticks[-1].price - ticks[0].price
    if delta >= TICK_SIZE:
        return "up"
    if delta <= -TICK_SIZE:
        return "down"
    return "flat"


def _signed_qty(tick: TradeTick) -> int:
    if tick.aggressor_side == "buy":
        return tick.quantity
    if tick.aggressor_side == "sell":
        return -tick.quantity
    return 0


def _append_live_vwap_levels(levels: list[dict[str, Any]], live_vwap: LiveVwap) -> None:
    values = [
        ("live_vwap", "Live VWAP", live_vwap.vwap),
        ("live_vwap_band_p1sd", "Live VWAP +1sd", live_vwap.plus_1sd),
        ("live_vwap_band_m1sd", "Live VWAP -1sd", live_vwap.minus_1sd),
    ]
    if live_vwap.vwap is not None and live_vwap.sigma is not None:
        values.extend(
            [
                ("live_vwap_band_p2sd", "Live VWAP +2sd", live_vwap.vwap + 2 * live_vwap.sigma),
                ("live_vwap_band_m2sd", "Live VWAP -2sd", live_vwap.vwap - 2 * live_vwap.sigma),
            ]
        )
    for source, text, price in values:
        if price is None:
            continue
        levels.append(
            {
                "level_id": f"ref-{source}-{price:.2f}",
                "text": text,
                "source": source,
                "price": price,
                "priority": 2,
            }
        )


def _source_priority(source: str) -> int:
    lower = source.lower()
    if "vwap" in lower:
        return 2
    if lower == "vpoc":
        return 3
    if lower in {"vah", "val"}:
        return 4
    if "hvn" in lower or "lvn" in lower:
        return 5
    return 6


def _dedupe_levels(levels: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: dict[int, dict[str, Any]] = {}
    for level in levels:
        price = _float(level.get("price"))
        if price is None:
            continue
        key = round(price / TICK_SIZE)
        prior = deduped.get(key)
        if prior is None or int(level.get("priority", 9)) < int(prior.get("priority", 9)):
            deduped[key] = level
    return sorted(deduped.values(), key=lambda item: (int(item.get("priority", 9)), item["price"]))


def _existing_keys(path: Path) -> set[str]:
    return {event_key(event) for event in load_delta_dislocations(path)}


def _fmt_ts(ts_ns: int) -> str:
    return datetime.fromtimestamp(ts_ns / 1_000_000_000, tz=UTC).astimezone(PT).strftime(
        "%Y-%m-%d %H:%M:%S PT"
    )


def _tick_ts(tick: TradeTick) -> int:
    return int(tick.timestamp_ns or 0)


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


def _side(value: Any) -> Literal["long", "short"]:
    return cast(Literal["long", "short"], "short" if value == "short" else "long")


def _candle_value(value: Any) -> Literal["up", "down", "flat"]:
    if value == "up":
        return "up"
    if value == "down":
        return "down"
    return "flat"


def _confidence(value: Any) -> Literal["high", "low_tail_span"]:
    return cast(
        Literal["high", "low_tail_span"],
        "low_tail_span" if value == "low_tail_span" else "high",
    )
