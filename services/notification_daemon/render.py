"""Pure toast rendering + the in-memory zone-price map.

A CRITICAL signal (family ``"signal"``) carries no numeric price — only a
``level_id`` such as ``"vpoc"``. To put a real price in the toast we keep a
small ``{zone_id: price}`` map fed from snapshot + zone-update frames and
look the level up at render time.

Everything here is pure and synchronous so it is trivially unit-testable.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from contracts.realtime.events import RealtimeMessage, SignalPayload, ZoneState

# Toast bodies are short by platform convention; keep the posture line tidy.
_MAX_POSTURE_LEN = 120


class ZonePriceMap:
    """In-memory ``{zone_id: price}`` (plus ``{zone_id: label}``) tracker.

    Populated from :class:`SnapshotPayload.zones` and
    :class:`ZoneUpdatePayload.zones`. Updates are upserts — a later
    zone-update for an existing id overwrites the earlier price (the level
    moved); ids not present in an update are left untouched (incremental).
    """

    def __init__(self) -> None:
        self._prices: dict[str, float] = {}
        self._labels: dict[str, str] = {}

    def update(self, zones: Iterable[ZoneState]) -> None:
        """Upsert every zone in ``zones`` into the map."""
        for z in zones:
            self._prices[z.id] = z.price
            if z.label:
                self._labels[z.id] = z.label

    def price_for(self, zone_id: str | None) -> float | None:
        """Mapped price for ``zone_id``, or ``None`` if unknown/missing."""
        if zone_id is None:
            return None
        return self._prices.get(zone_id)

    def label_for(self, zone_id: str | None) -> str | None:
        """Mapped human label for ``zone_id``, or ``None``."""
        if zone_id is None:
            return None
        return self._labels.get(zone_id)

    def __len__(self) -> int:
        return len(self._prices)


def _families(payload: SignalPayload) -> list[str]:
    """Confluence families from signal metadata, defensively coerced."""
    raw: Any = payload.metadata.get("families")
    if isinstance(raw, (list, tuple)):
        return [str(f) for f in raw]
    return []


def _level_display(payload: SignalPayload, zone_prices: ZonePriceMap) -> str:
    """Human-facing level descriptor: label/level_id + mapped price.

    Falls back gracefully: mapped price → ``"VPOC @ 30075.00"``; no price but
    a known label → ``"VPOC"``; nothing mapped → the raw ``level_id``; no
    level at all → ``"level"``.
    """
    level_id = payload.level_id
    label = zone_prices.label_for(level_id) or level_id
    price = zone_prices.price_for(level_id)
    if label is None:
        # No level_id on the signal at all.
        return "level"
    if price is not None:
        return f"{label} @ {price:.2f}"
    return label


def render_toast(
    msg: RealtimeMessage,
    zone_prices: ZonePriceMap,
) -> tuple[str, str]:
    """Render a (title, body) pair for a CRITICAL message.

    Body = zone price + signal families + a 1-line posture (the signal's
    own description). Works for any payload but is tuned for the ``signal``
    family; non-signal payloads degrade to the envelope description if any.
    """
    payload = msg.payload

    if isinstance(payload, SignalPayload):
        level = _level_display(payload, zone_prices)
        families = _families(payload)
        # ASCII separators only: toast renders Unicode fine, but the same
        # strings are logged and a cp1252 console mangles em-dash/ellipsis.
        title = f"CRITICAL - {level}"
        parts: list[str] = []
        if families:
            parts.append(" + ".join(families))
        posture = (payload.description or "").strip()
        if posture:
            if len(posture) > _MAX_POSTURE_LEN:
                posture = posture[: _MAX_POSTURE_LEN - 3].rstrip() + "..."
            parts.append(posture)
        body = "\n".join(parts) if parts else level
        return title, body

    # Non-signal CRITICAL (defensive — backend classifies signals today).
    description = str(getattr(payload, "description", "") or "").strip()
    title = f"CRITICAL - {payload.family}"
    body = description or payload.family
    return title, body


__all__ = ["ZonePriceMap", "render_toast"]
