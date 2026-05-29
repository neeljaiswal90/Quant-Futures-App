"""Distance-to-key-level computations."""

from __future__ import annotations

import math
import re
from typing import Any, cast

from rithmic_dashboard.models import Conviction, LevelDirection, LevelDistance, LevelMotion

_TICK_SIZE = 0.25
_SANITIZE_RE = re.compile(r"[^a-zA-Z0-9_.-]+")


def compute_level_distances(
    envelope: dict[str, Any],
    current_price: float,
    atr: float,
    prior_state: dict[str, Any] | None = None,
) -> list[LevelDistance]:
    """Compute signed distance from current price to reference lines and zones."""

    levels = _extract_levels(envelope)
    distances = [
        _distance_for_level(level, current_price=current_price, atr=atr, prior_state=prior_state)
        for level in levels
    ]
    return sorted(distances, key=lambda d: abs(d.distance_pts))


def _extract_levels(envelope: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for line in envelope.get("reference_lines", []):
        if not isinstance(line, dict) or "price" not in line:
            continue
        price = _to_float(line.get("price"))
        if price is None:
            continue
        source = str(line.get("source", "reference"))
        text = str(line.get("text", source))
        result.append(
            {
                "level_id": _level_id("ref", source, price),
                "price": price,
                "text": text,
                "source": source,
                "conviction": _reference_conviction(source),
            }
        )

    for zone in envelope.get("zones", []):
        if not isinstance(zone, dict):
            continue
        top = _to_float(zone.get("top"))
        bot = _to_float(zone.get("bot"))
        if top is None or bot is None:
            continue
        price = (top + bot) / 2.0
        source = _zone_source(zone)
        result.append(
            {
                "level_id": str(zone.get("id", _level_id("zone", source, price))),
                "price": price,
                "text": str(zone.get("text", source)),
                "source": source,
                "conviction": _clean_conviction(zone.get("conviction")),
            }
        )
    return result


def _distance_for_level(
    level: dict[str, Any],
    *,
    current_price: float,
    atr: float,
    prior_state: dict[str, Any] | None,
) -> LevelDistance:
    price = float(level["price"])
    distance_pts = price - current_price
    distance_atr = distance_pts / atr if atr > 0 and math.isfinite(atr) else 0.0
    direction = _direction(distance_pts)
    state = _motion_state(str(level["level_id"]), distance_pts, prior_state)
    return LevelDistance(
        level_id=str(level["level_id"]),
        price=price,
        text=str(level["text"]),
        source=str(level["source"]),
        conviction=level["conviction"],
        distance_pts=distance_pts,
        distance_atr=distance_atr,
        direction=direction,
        state=state,
    )


def _direction(distance_pts: float) -> LevelDirection:
    if abs(distance_pts) < _TICK_SIZE:
        return "at"
    return "above" if distance_pts > 0 else "below"


def _motion_state(
    level_id: str,
    distance_pts: float,
    prior_state: dict[str, Any] | None,
) -> LevelMotion:
    previous = None
    if prior_state is not None:
        raw = prior_state.get(level_id)
        if isinstance(raw, dict):
            previous = _to_float(raw.get("last_distance_pts"))
    if previous is None:
        return "crossing" if abs(distance_pts) < _TICK_SIZE else "approaching"
    if previous == 0 or distance_pts == 0 or (previous < 0 < distance_pts) or (
        previous > 0 > distance_pts
    ):
        return "crossing"
    return "approaching" if abs(distance_pts) < abs(previous) else "moved_away"


def _level_id(prefix: str, source: str, price: float) -> str:
    safe_source = _SANITIZE_RE.sub("-", source.lower()).strip("-")
    return f"{prefix}-{safe_source}-{price:.2f}"


def _zone_source(zone: dict[str, Any]) -> str:
    sources = zone.get("sources")
    if isinstance(sources, list) and sources:
        return str(sources[0])
    return str(zone.get("type", "zone"))


def _clean_conviction(value: Any) -> Conviction | None:
    parsed = str(value)
    if parsed in {"SUPER", "HIGH", "MED", "LOW"}:
        return cast(Conviction, parsed)
    return None


def _reference_conviction(source: str) -> Conviction | None:
    if source == "vpoc":
        return "HIGH"
    if source in {"vah", "val"} or "vwap" in source or "lvn" in source:
        return "MED"
    return None


def _to_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed):
        return None
    return parsed
