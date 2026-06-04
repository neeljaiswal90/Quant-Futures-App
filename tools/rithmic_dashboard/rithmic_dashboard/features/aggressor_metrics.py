"""Windowed aggressor flow and footprint metrics from normalized trades."""

from __future__ import annotations

import json
import math
from collections import defaultdict
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from rithmic_dashboard.models import (
    AggressorFlowEvent,
    AggressorWindowMetric,
    FootprintBar,
    FootprintLevel,
    TradeTick,
    VDelta,
)
from rithmic_dashboard.session_state import PT
from rithmic_dashboard.state_store import load_json_state, save_json_state

AGGRESSOR_WINDOWS_SECONDS = (60, 300, 900, 3600)
VDELTA_WINDOW_SECONDS = 30
VDELTA_HYSTERESIS_SECONDS = 10
VDELTA_ZSCORE_THRESHOLD = 1.5
VDELTA_STDDEV_WINDOW_SECONDS = 300
VDELTA_MIN_FLIP_COOLDOWN_SECONDS = 30
VDELTA_STDDEV_MIN_FLOOR = 5.0
VDELTA_MAX_SAMPLES = 60
FOOTPRINT_BAR_SECONDS = 300
IMBALANCE_THRESHOLD = 0.30
STACKED_LEVEL_COUNT = 3
EXTREME_RATIO_HIGH = 3.0
EXTREME_RATIO_LOW = 1.0 / EXTREME_RATIO_HIGH
TICK_SIZE = 0.25

Direction = Literal["bullish", "bearish", "neutral", "unknown"]


def compute_aggressor_metrics(ticks: list[TradeTick]) -> tuple[AggressorWindowMetric, ...]:
    """Compute Bookmap-style liftAsk/hitBid windows from recent trades."""

    return tuple(
        _window_metric(ticks, window_seconds=window_seconds)
        for window_seconds in AGGRESSOR_WINDOWS_SECONDS
    )


def compute_v_delta(
    ticks: list[TradeTick],
    *,
    state_path: Path | None = None,
    window_seconds: int = VDELTA_WINDOW_SECONDS,
    hysteresis_seconds: int = VDELTA_HYSTERESIS_SECONDS,
) -> tuple[VDelta, AggressorFlowEvent | None]:
    """Compute short-window signed flow and one-shot sign-flip events."""

    if not ticks:
        return VDelta(window_seconds, None, "unknown", False, None, None), None

    latest_ns = ticks[-1].timestamp_ns
    if latest_ns is None:
        return VDelta(window_seconds, None, "unknown", False, None, None), None

    state = load_json_state(state_path, {}) if state_path is not None else {}
    samples = _load_recent_vdelta_samples(state, latest_ns)
    stddev, mean = _vdelta_distribution(samples)
    current_value = _signed_sum_ending_at(ticks, latest_ns, window_seconds)
    current_zscore = _zscore(current_value, mean=mean, stddev=stddev)
    current_direction = _direction_zscored(current_zscore)
    prior_value = _signed_sum_ending_at(
        ticks,
        latest_ns - hysteresis_seconds * 1_000_000_000,
        window_seconds,
    )
    confirmed_direction = _direction_zscored(_zscore(prior_value, mean=mean, stddev=stddev))

    previous_direction = _state_direction(state.get("last_direction"))
    previous_event_direction = _state_direction(state.get("last_event_direction"))
    sign_flip = (
        current_direction in {"bullish", "bearish"}
        and confirmed_direction == current_direction
        and previous_direction in {"bullish", "bearish"}
        and previous_direction != current_direction
        and previous_event_direction != current_direction
    )
    cooldown_suppressed_flip = False
    last_event_ts_ns = _optional_int(state.get("last_event_ts_ns")) or 0
    if (
        sign_flip
        and last_event_ts_ns > 0
        and latest_ns - last_event_ts_ns < VDELTA_MIN_FLIP_COOLDOWN_SECONDS * 1_000_000_000
    ):
        sign_flip = False
        cooldown_suppressed_flip = True

    event: AggressorFlowEvent | None = None
    if sign_flip:
        event = _v_delta_event(
            timestamp_ns=latest_ns,
            value=current_value,
            direction=current_direction,
            confirmed_seconds=hysteresis_seconds,
            stddev=stddev,
            zscore=current_zscore,
        )
        state["last_event_direction"] = current_direction
        state["last_event_ts_ns"] = latest_ns

    if (
        current_direction in {"bullish", "bearish"} and not cooldown_suppressed_flip
    ) or previous_direction is None:
        state["last_direction"] = current_direction
    state["last_value"] = current_value
    state["last_stddev"] = stddev
    state["last_zscore"] = current_zscore
    state["updated_ts_ns"] = latest_ns
    state["samples"] = _record_vdelta_sample(
        samples,
        latest_ns=latest_ns,
        value=current_value,
        window_seconds=window_seconds,
    )
    if state_path is not None:
        save_json_state(state_path, state)

    return (
        VDelta(
            window_seconds=window_seconds,
            value=current_value,
            direction=current_direction,
            sign_flip=sign_flip,
            prior_direction=previous_direction,
            confirmed_seconds=hysteresis_seconds if sign_flip else None,
            stddev=stddev,
            zscore=current_zscore,
        ),
        event,
    )


def build_footprint_bar(
    ticks: list[TradeTick],
    *,
    bar_seconds: int = FOOTPRINT_BAR_SECONDS,
    tick_size: float = TICK_SIZE,
) -> FootprintBar | None:
    """Build the most recent completed 5-minute per-price footprint bar."""

    if not ticks:
        return None
    latest_ns = ticks[-1].timestamp_ns
    if latest_ns is None:
        return None
    bar_ns = bar_seconds * 1_000_000_000
    end_ns = (latest_ns // bar_ns) * bar_ns
    start_ns = end_ns - bar_ns
    bar_ticks = [
        tick
        for tick in ticks
        if tick.timestamp_ns is not None and start_ns <= tick.timestamp_ns < end_ns
    ]
    if not bar_ticks:
        end_ns = latest_ns
        start_ns = max(0, latest_ns - bar_ns)
        bar_ticks = [
            tick
            for tick in ticks
            if tick.timestamp_ns is not None and start_ns <= tick.timestamp_ns <= end_ns
        ]
    if not bar_ticks:
        return None

    buckets: dict[int, dict[str, int]] = defaultdict(lambda: {"bid": 0, "ask": 0})
    for tick in bar_ticks:
        bucket = round(tick.price / tick_size)
        if tick.aggressor_side == "buy":
            buckets[bucket]["ask"] += tick.quantity
        elif tick.aggressor_side == "sell":
            buckets[bucket]["bid"] += tick.quantity

    levels: list[FootprintLevel] = []
    for bucket, values in sorted(buckets.items(), reverse=True):
        bid_volume = values["bid"]
        ask_volume = values["ask"]
        total = bid_volume + ask_volume
        if total <= 0:
            continue
        levels.append(
            FootprintLevel(
                price=bucket * tick_size,
                bid_volume=bid_volume,
                ask_volume=ask_volume,
                total_volume=total,
                imbalance=(ask_volume - bid_volume) / total,
            )
        )
    if not levels:
        return None

    side, count, low_price, high_price = _stacked_imbalance(levels, tick_size=tick_size)
    return FootprintBar(
        bar_start_pt=_fmt_ns(start_ns),
        bar_end_pt=_fmt_ns(end_ns),
        bar_start_ns=start_ns,
        bar_end_ns=end_ns,
        levels=tuple(levels),
        stacked_side=side,
        stacked_count=count,
        stacked_low_price=low_price,
        stacked_high_price=high_price,
    )


def build_aggressor_events(
    *,
    windows: tuple[AggressorWindowMetric, ...],
    footprint_bar: FootprintBar | None,
    v_delta_event: AggressorFlowEvent | None,
    timestamp_ns: int | None,
) -> tuple[AggressorFlowEvent, ...]:
    """Return canonical aggressor-flow events for the current dashboard tick."""

    events: list[AggressorFlowEvent] = []
    if v_delta_event is not None:
        events.append(v_delta_event)
    extreme = _extreme_window_event(windows, timestamp_ns=timestamp_ns)
    if extreme is not None:
        events.append(extreme)
    footprint_event = _footprint_event(footprint_bar)
    if footprint_event is not None:
        events.append(footprint_event)
    return tuple(events)


def append_new_aggressor_flow_events(path: Path, events: tuple[AggressorFlowEvent, ...]) -> None:
    """Append canonical aggressor-flow events, deduping by type/time/level."""

    if not events:
        return
    existing = _existing_event_keys(path)
    rows: list[str] = []
    for event in events:
        key = _event_key(event)
        if key in existing:
            continue
        existing.add(key)
        rows.append(json.dumps(asdict(event), sort_keys=True))
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for row in rows:
            f.write(row + "\n")


def append_footprint_bar(path: Path, bar: FootprintBar | None) -> None:
    """Persist a footprint bar once per bar start/end."""

    if bar is None:
        return
    existing = _existing_bar_keys(path)
    key = (bar.bar_start_ns, bar.bar_end_ns)
    if key in existing:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(asdict(bar), sort_keys=True) + "\n")


def load_aggressor_flow_events(path: Path) -> list[AggressorFlowEvent]:
    """Load canonical aggressor-flow events from JSONL."""

    events: list[AggressorFlowEvent] = []
    if not path.exists():
        return events
    for row in _read_jsonl(path):
        try:
            events.append(
                AggressorFlowEvent(
                    timestamp_pt=str(row["timestamp_pt"]),
                    timestamp_ns=_optional_int(row.get("timestamp_ns")),
                    event_type=_event_type(row.get("event_type")),
                    level_id=_optional_str(row.get("level_id")),
                    level_text=_optional_str(row.get("level_text")),
                    level_price=_optional_float(row.get("level_price")),
                    direction=_event_direction(row.get("direction")),
                    description=str(row["description"]),
                    intensity=float(row.get("intensity", 0.0)),
                    confidence=_confidence(row.get("confidence")),
                    metadata=_metadata(row.get("metadata")),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return events


def recent_aggressor_flow_events(
    events: list[AggressorFlowEvent],
    now: datetime,
    *,
    minutes: int,
) -> list[AggressorFlowEvent]:
    """Filter events to the recent live window."""

    cutoff = now.astimezone(PT) - timedelta(minutes=minutes)
    filtered = [
        event
        for event in events
        if event.timestamp_ns is None or _event_time(event.timestamp_ns) >= cutoff
    ]
    return filtered[-12:]


def _window_metric(ticks: list[TradeTick], *, window_seconds: int) -> AggressorWindowMetric:
    label = _window_label(window_seconds)
    recent = _ticks_within_seconds(ticks, seconds=window_seconds)
    lift_ask = sum(tick.quantity for tick in recent if tick.aggressor_side == "buy")
    hit_bid = sum(tick.quantity for tick in recent if tick.aggressor_side == "sell")
    total = lift_ask + hit_bid
    ratio = lift_ask / max(hit_bid, 1) if total > 0 else None
    net = lift_ask - hit_bid
    return AggressorWindowMetric(
        window_seconds=window_seconds,
        label=label,
        lift_ask=lift_ask,
        hit_bid=hit_bid,
        net=net,
        ratio=ratio,
        total_volume=total,
        direction=_direction(net) if total > 0 else "unknown",
    )


def _ticks_within_seconds(ticks: list[TradeTick], *, seconds: int) -> list[TradeTick]:
    if not ticks:
        return []
    latest = ticks[-1].timestamp_ns
    if latest is None:
        return []
    cutoff = latest - seconds * 1_000_000_000
    return [tick for tick in ticks if tick.timestamp_ns is not None and tick.timestamp_ns >= cutoff]


def _signed_sum_ending_at(ticks: list[TradeTick], end_ns: int, window_seconds: int) -> int:
    cutoff = end_ns - window_seconds * 1_000_000_000
    return sum(
        _signed_qty(tick)
        for tick in ticks
        if tick.timestamp_ns is not None and cutoff <= tick.timestamp_ns <= end_ns
    )


def _signed_qty(tick: TradeTick) -> int:
    if tick.aggressor_side == "buy":
        return tick.quantity
    if tick.aggressor_side == "sell":
        return -tick.quantity
    return 0


def _load_recent_vdelta_samples(state: dict[str, Any], latest_ns: int) -> list[dict[str, int]]:
    raw_samples = state.get("samples")
    if not isinstance(raw_samples, list):
        return []
    cutoff_ns = latest_ns - VDELTA_STDDEV_WINDOW_SECONDS * 1_000_000_000
    samples: list[dict[str, int]] = []
    for row in raw_samples:
        if not isinstance(row, dict):
            continue
        ts_ns = _optional_int(row.get("ts_ns"))
        value = _optional_int(row.get("value"))
        if ts_ns is None or value is None:
            continue
        if cutoff_ns <= ts_ns <= latest_ns:
            samples.append({"ts_ns": ts_ns, "value": value})
    samples.sort(key=lambda item: item["ts_ns"])
    return samples[-VDELTA_MAX_SAMPLES:]


def _record_vdelta_sample(
    samples: list[dict[str, int]],
    *,
    latest_ns: int,
    value: int,
    window_seconds: int,
) -> list[dict[str, int]]:
    sample_interval_ns = max(1, int(window_seconds * 1_000_000_000 / 4))
    if samples and latest_ns - samples[-1]["ts_ns"] < sample_interval_ns:
        return samples
    return [*samples, {"ts_ns": latest_ns, "value": value}][-VDELTA_MAX_SAMPLES:]


def _vdelta_distribution(samples: list[dict[str, int]]) -> tuple[float, float]:
    if len(samples) < 8:
        return VDELTA_STDDEV_MIN_FLOOR, 0.0
    values = [sample["value"] for sample in samples]
    mean = sum(values) / len(values)
    variance = sum((value - mean) ** 2 for value in values) / len(values)
    return max(math.sqrt(variance), VDELTA_STDDEV_MIN_FLOOR), mean


def _zscore(value: int, *, mean: float, stddev: float) -> float:
    return (value - mean) / max(stddev, VDELTA_STDDEV_MIN_FLOOR)


def _stacked_imbalance(
    levels: list[FootprintLevel],
    *,
    tick_size: float,
) -> tuple[Literal["buy", "sell", "none"], int, float | None, float | None]:
    ascending = sorted(levels, key=lambda level: level.price)
    best_side: Literal["buy", "sell", "none"] = "none"
    best_run: list[FootprintLevel] = []
    current_side: Literal["buy", "sell", "none"] = "none"
    current_run: list[FootprintLevel] = []
    previous_price: float | None = None
    for level in ascending:
        side: Literal["buy", "sell", "none"] = (
            "buy"
            if level.imbalance > IMBALANCE_THRESHOLD
            else "sell"
            if level.imbalance < -IMBALANCE_THRESHOLD
            else "none"
        )
        adjacent = (
            previous_price is not None and abs(level.price - previous_price - tick_size) < 1e-9
        )
        if side != "none" and side == current_side and adjacent:
            current_run.append(level)
        elif side != "none":
            current_side = side
            current_run = [level]
        else:
            current_side = "none"
            current_run = []
        if len(current_run) > len(best_run):
            best_side = current_side
            best_run = list(current_run)
        previous_price = level.price
    if len(best_run) < STACKED_LEVEL_COUNT:
        return "none", 0, None, None
    return best_side, len(best_run), best_run[0].price, best_run[-1].price


def _extreme_window_event(
    windows: tuple[AggressorWindowMetric, ...],
    *,
    timestamp_ns: int | None,
) -> AggressorFlowEvent | None:
    eligible = [
        window
        for window in windows
        if window.total_volume > 0
        and window.ratio is not None
        and (window.ratio >= EXTREME_RATIO_HIGH or window.ratio <= EXTREME_RATIO_LOW)
    ]
    if not eligible or timestamp_ns is None:
        return None
    window = max(
        eligible,
        key=lambda item: max(item.ratio or 0.0, 1.0 / max(item.ratio or 1.0, 0.000001)),
    )
    assert window.ratio is not None
    bullish = window.ratio >= EXTREME_RATIO_HIGH
    intensity = window.ratio if bullish else 1.0 / max(window.ratio, 0.000001)
    direction: Literal["long", "short"] = "long" if bullish else "short"
    side_text = "bullish" if bullish else "bearish"
    description = (
        f"Aggressor flow strongly {side_text} over {window.label}: "
        f"liftAsk {window.lift_ask:,} vs hitBid {window.hit_bid:,} "
        f"(net {window.net:+,}, ratio {window.ratio:.2f}x)"
    )
    return AggressorFlowEvent(
        timestamp_pt=_fmt_ns(timestamp_ns),
        timestamp_ns=timestamp_ns,
        event_type="aggressor_imbalance_extreme",
        level_id=None,
        level_text=None,
        level_price=None,
        direction=direction,
        description=description,
        intensity=float(intensity),
        confidence="high" if window.total_volume >= 100 else "medium",
        metadata={
            "window_seconds": window.window_seconds,
            "lift_ask": window.lift_ask,
            "hit_bid": window.hit_bid,
            "net": window.net,
            "ratio": window.ratio,
            "total_volume": window.total_volume,
        },
    )


def _footprint_event(bar: FootprintBar | None) -> AggressorFlowEvent | None:
    if bar is None or bar.stacked_side == "none":
        return None
    assert bar.stacked_low_price is not None
    assert bar.stacked_high_price is not None
    low = min(bar.stacked_low_price, bar.stacked_high_price)
    high = max(bar.stacked_low_price, bar.stacked_high_price)
    midpoint = (low + high) / 2.0
    direction: Literal["long", "short"] = "long" if bar.stacked_side == "buy" else "short"
    side_text = "buy" if bar.stacked_side == "buy" else "sell"
    return AggressorFlowEvent(
        timestamp_pt=bar.bar_end_pt,
        timestamp_ns=bar.bar_end_ns,
        event_type="stacked_footprint_imbalance",
        level_id=f"footprint-{bar.stacked_side}-{midpoint:.2f}",
        level_text=f"Footprint {side_text} stack {low:,.2f}-{high:,.2f}",
        level_price=midpoint,
        direction=direction,
        description=(
            f"Stacked footprint {side_text} imbalance across {bar.stacked_count} prices "
            f"from {low:,.2f} to {high:,.2f}"
        ),
        intensity=float(bar.stacked_count),
        confidence="high" if bar.stacked_count >= 4 else "medium",
        metadata={
            "bar_start_pt": bar.bar_start_pt,
            "bar_end_pt": bar.bar_end_pt,
            "stacked_side": bar.stacked_side,
            "stacked_count": bar.stacked_count,
            "low_price": low,
            "high_price": high,
        },
    )


def _v_delta_event(
    *,
    timestamp_ns: int,
    value: int,
    direction: Direction,
    confirmed_seconds: int,
    stddev: float,
    zscore: float,
) -> AggressorFlowEvent:
    long_short: Literal["long", "short"] = "long" if direction == "bullish" else "short"
    label = "bullish" if direction == "bullish" else "bearish"
    return AggressorFlowEvent(
        timestamp_pt=_fmt_ns(timestamp_ns),
        timestamp_ns=timestamp_ns,
        event_type="v_delta_sign_flip",
        level_id=None,
        level_text=None,
        level_price=None,
        direction=long_short,
        description=(
            f"vDelta flipped {label}: 30s delta {value:+,} "
            f"after {confirmed_seconds}s confirmation"
        ),
        intensity=float(abs(value)),
        confidence="medium",
        metadata={
            "v_delta": value,
            "window_seconds": VDELTA_WINDOW_SECONDS,
            "confirmed_seconds": confirmed_seconds,
            "stddev": stddev,
            "zscore": zscore,
            "zscore_threshold": VDELTA_ZSCORE_THRESHOLD,
        },
    )


def _existing_event_keys(path: Path) -> set[tuple[str, str, str]]:
    keys: set[tuple[str, str, str]] = set()
    if not path.exists():
        return keys
    for row in _read_jsonl(path):
        keys.add(
            (
                str(row.get("event_type")),
                str(row.get("timestamp_ns") or row.get("timestamp_pt")),
                str(row.get("level_id") or ""),
            )
        )
    return keys


def _event_key(event: AggressorFlowEvent) -> tuple[str, str, str]:
    return (
        event.event_type,
        str(event.timestamp_ns or event.timestamp_pt),
        event.level_id or "",
    )


def _existing_bar_keys(path: Path) -> set[tuple[int, int]]:
    keys: set[tuple[int, int]] = set()
    if not path.exists():
        return keys
    for row in _read_jsonl(path):
        start = _optional_int(row.get("bar_start_ns"))
        end = _optional_int(row.get("bar_end_ns"))
        if start is not None and end is not None:
            keys.add((start, end))
    return keys


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.exists():
        return rows
    with path.open("r", encoding="utf-8") as f:
        for raw in f:
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                rows.append(parsed)
    return rows


def _metadata(value: Any) -> dict[str, float | int | str | bool | None]:
    if not isinstance(value, dict):
        return {}
    clean: dict[str, float | int | str | bool | None] = {}
    for key, item in value.items():
        if isinstance(item, bool | int | float | str) or item is None:
            clean[str(key)] = item
    return clean


def _event_type(value: Any) -> Literal[
    "aggressor_imbalance_extreme",
    "stacked_footprint_imbalance",
    "v_delta_sign_flip",
]:
    raw = str(value)
    if raw == "stacked_footprint_imbalance":
        return "stacked_footprint_imbalance"
    if raw == "v_delta_sign_flip":
        return "v_delta_sign_flip"
    return "aggressor_imbalance_extreme"


def _event_direction(value: Any) -> Literal["long", "short", "neutral"]:
    raw = str(value or "").lower()
    if raw in {"long", "buy", "bullish"}:
        return "long"
    if raw in {"short", "sell", "bearish"}:
        return "short"
    return "neutral"


def _confidence(value: Any) -> Literal["high", "medium", "low"]:
    raw = str(value or "").lower()
    if raw == "high":
        return "high"
    if raw == "low":
        return "low"
    return "medium"


def _state_direction(value: Any) -> Direction | None:
    raw = str(value or "").lower()
    if raw in {"bullish", "bearish", "neutral", "unknown"}:
        return raw  # type: ignore[return-value]
    return None


def _direction(value: int) -> Direction:
    if value > 0:
        return "bullish"
    if value < 0:
        return "bearish"
    return "neutral"


def _direction_zscored(zscore: float) -> Direction:
    if zscore > VDELTA_ZSCORE_THRESHOLD:
        return "bullish"
    if zscore < -VDELTA_ZSCORE_THRESHOLD:
        return "bearish"
    return "neutral"


def _window_label(window_seconds: int) -> str:
    if window_seconds < 60:
        return f"{window_seconds}s"
    if window_seconds % 3600 == 0:
        return f"{window_seconds // 3600}h"
    return f"{window_seconds // 60}m"


def _event_time(ts_ns: int) -> datetime:
    return datetime.fromtimestamp(ts_ns / 1_000_000_000, tz=UTC).astimezone(PT)


def _fmt_ns(value: int) -> str:
    return _event_time(value).strftime("%Y-%m-%d %H:%M:%S PT")


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    parsed = str(value)
    return parsed if parsed else None


def _optional_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _optional_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
