"""Live absorption proxy from bounded-tail trade clusters."""

from __future__ import annotations

import json
import statistics
from collections import Counter, defaultdict
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, cast

from rithmic_dashboard.models import AbsorptionProxyEvent, TradeTick
from rithmic_dashboard.session_state import PT

TICK_SIZE = 0.25
DEFAULT_WINDOW_SECONDS = 60
DEFAULT_VOLUME_MULTIPLE = 3.0
DEFAULT_DELTA_FRACTION = 0.30
DEFAULT_MIN_VOLUME = 100


def detect_absorption_proxies(
    ticks: list[TradeTick],
    *,
    window_seconds: int = DEFAULT_WINDOW_SECONDS,
    volume_multiple: float = DEFAULT_VOLUME_MULTIPLE,
    delta_fraction: float = DEFAULT_DELTA_FRACTION,
    min_volume: int = DEFAULT_MIN_VOLUME,
    prior_events: list[AbsorptionProxyEvent] | None = None,
) -> list[AbsorptionProxyEvent]:
    """Detect heavy-volume, balanced-delta fixed-price clusters."""

    ordered = [tick for tick in sorted(ticks, key=_tick_ts) if tick.timestamp_ns is not None]
    if not ordered:
        return []
    buckets: dict[tuple[int, float], dict[str, int]] = defaultdict(
        lambda: {"volume": 0, "delta": 0}
    )
    for tick in ordered:
        ts = _tick_ts(tick)
        window = ts // (window_seconds * 1_000_000_000)
        price = round(tick.price / TICK_SIZE) * TICK_SIZE
        signed = tick.quantity if tick.aggressor_side == "buy" else -tick.quantity
        if tick.aggressor_side == "unknown":
            signed = 0
        bucket = buckets[(window, price)]
        bucket["volume"] += max(0, tick.quantity)
        bucket["delta"] += signed

    volumes = [bucket["volume"] for bucket in buckets.values() if bucket["volume"] > 0]
    if not volumes:
        return []
    median = statistics.median(volumes)
    threshold = max(float(min_volume), median * volume_multiple)
    prior_counts = Counter(
        round(event.price / TICK_SIZE) * TICK_SIZE for event in prior_events or []
    )
    events: list[AbsorptionProxyEvent] = []
    for (window, price), bucket in buckets.items():
        volume = bucket["volume"]
        net_delta = bucket["delta"]
        if volume < threshold:
            continue
        if abs(net_delta) > delta_fraction * volume:
            continue
        confidence: Literal["high", "low"] = (
            "high" if prior_counts[price] + 1 >= 4 else "low"
        )
        ts_ns = (window + 1) * window_seconds * 1_000_000_000
        events.append(
            AbsorptionProxyEvent(
                timestamp_pt=_fmt_ts(ts_ns),
                timestamp_ns=ts_ns,
                price=price,
                volume=volume,
                net_delta=net_delta,
                side_inferred=_side(net_delta),
                confidence=confidence,
            )
        )
    return sorted(events, key=lambda event: event.timestamp_ns or 0, reverse=True)


def load_absorption_proxy_events(path: Path) -> list[AbsorptionProxyEvent]:
    """Load previously persisted absorption proxy events."""

    if not path.exists():
        return []
    events: list[AbsorptionProxyEvent] = []
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict):
            continue
        try:
            events.append(
                AbsorptionProxyEvent(
                    timestamp_pt=str(data["timestamp_pt"]),
                    timestamp_ns=_int(data.get("timestamp_ns")),
                    price=float(data["price"]),
                    volume=int(data["volume"]),
                    net_delta=int(data["net_delta"]),
                    side_inferred=str(data["side_inferred"]),
                    confidence=_confidence(data.get("confidence")),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return events


def append_new_absorption_proxies(path: Path, events: list[AbsorptionProxyEvent]) -> None:
    """Append proxy events, deduped by timestamp and price."""

    if not events:
        return
    seen = {
        f"{event.timestamp_ns}|{event.price:.2f}"
        for event in load_absorption_proxy_events(path)
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for event in events:
            key = f"{event.timestamp_ns}|{event.price:.2f}"
            if key in seen:
                continue
            f.write(json.dumps(asdict(event), sort_keys=True) + "\n")
            seen.add(key)


def _side(net_delta: int) -> str:
    if net_delta > 0:
        return "sell_absorbed"
    if net_delta < 0:
        return "buy_absorbed"
    return "balanced"


def _confidence(value: Any) -> Literal["high", "low"]:
    return cast(Literal["high", "low"], "high" if value == "high" else "low")


def _tick_ts(tick: TradeTick) -> int:
    return int(tick.timestamp_ns or 0)


def _fmt_ts(ts_ns: int) -> str:
    return datetime.fromtimestamp(ts_ns / 1_000_000_000, tz=UTC).astimezone(PT).strftime(
        "%Y-%m-%d %H:%M:%S PT"
    )


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
