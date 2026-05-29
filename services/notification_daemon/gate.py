"""Pure notification gate: decide whether a message fires a toast.

The decision is total and side-effect-free so it is exhaustively
unit-testable. A toast fires iff **all** of:

1. ``msg.tier`` is one of the configured tiers (CRITICAL/HIGH/MEDIUM);
2. that tier's :class:`TierAlertConfig` is ``enabled``;
3. that tier's ``windows_toast`` flag is set (CRITICAL true by default;
   HIGH/MEDIUM false by default but a user may opt in);
4. we are **not** inside the quiet-hours window.

Quiet-hours interpretation (RA-069 — reconciled with the backend gating
contract): the contract's :class:`QuietHoursConfig.audio_only` means
"silence *audio* during the window, keep visual channels." A Windows toast is
a visual channel, so under ``audio_only=True`` the toast still fires; only a
**full** quiet window (``audio_only=False``) suppresses it. This matches
``realtime_backend.config.gating.should_fire`` exactly, so the single shared
:class:`AlertConfig` can no longer yield contradictory toast behavior across
consumers. A user who wants total night silence sets ``audio_only=False``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, time
from typing import Any

from contracts.realtime.config import AlertConfig, TierAlertConfig
from contracts.realtime.events import RealtimeMessage, Tier

# Maps the wire tier (UPPER) to the config attribute (lower).
_TIER_ATTR: dict[Tier, str] = {
    "CRITICAL": "critical",
    "HIGH": "high",
    "MEDIUM": "medium",
}

COOLDOWN_SECONDS = 5 * 60


@dataclass
class NotificationGateState:
    """Small in-memory cooldown cache shared by the daemon process."""

    last_fired_by_key: dict[str, float] = field(default_factory=dict)


def _tier_config(config: AlertConfig, tier: Tier) -> TierAlertConfig:
    return getattr(config, _TIER_ATTR[tier])  # type: ignore[no-any-return]


def _parse_hhmm(value: str) -> time:
    """Parse an ``"HH:MM"`` string into a :class:`datetime.time`.

    Raises ``ValueError`` on malformed input (caller treats a bad window as
    "no quiet hours" — see :func:`in_quiet_hours`).
    """
    hh_str, mm_str = value.split(":", 1)
    return time(hour=int(hh_str), minute=int(mm_str))


def in_quiet_hours(config: AlertConfig, now_pt: datetime) -> bool:
    """Is ``now_pt`` inside the configured quiet-hours window?

    ``now_pt`` is wall-clock in the trader's timezone (America/Los_Angeles).
    Handles the midnight wrap-around: a window ``22:00 → 06:00`` (start >
    end) spans midnight, so "inside" means ``now >= start`` *or* ``now <
    end``. A non-wrapping window (start <= end) means ``start <= now < end``.
    A malformed time string disables the window (fail-open: still notify).
    """
    qh = config.quiet_hours
    if not qh.enabled:
        return False
    try:
        start = _parse_hhmm(qh.start_pt)
        end = _parse_hhmm(qh.end_pt)
    except (ValueError, TypeError):
        return False
    now = now_pt.time()
    if start == end:
        # Degenerate: zero-width window silences nothing.
        return False
    if start < end:
        return start <= now < end
    # Wrap-around window (e.g. 22:00 -> 06:00).
    return now >= start or now < end


def should_notify(
    msg: RealtimeMessage,
    config: AlertConfig,
    now_pt: datetime,
    *,
    current_price: float | None = None,
    state: NotificationGateState | None = None,
) -> bool:
    """Return ``True`` iff ``msg`` should produce a Windows toast right now."""
    tier = msg.tier
    if tier not in _TIER_ATTR:
        return False
    tier_cfg = _tier_config(config, tier)
    if not (tier_cfg.enabled and tier_cfg.windows_toast):
        return False
    if in_quiet_hours(config, now_pt) and not config.quiet_hours.audio_only:
        # RA-069: audio_only=True means silence audio but keep visual toasts;
        # audio_only=False is a full quiet window and suppresses toasts too.
        return False
    if not _within_proximity(msg, config, current_price):
        return False
    if state is not None:
        key = _alert_key(msg)
        now_ts = now_pt.timestamp()
        last = state.last_fired_by_key.get(key)
        if last is not None and now_ts - last < COOLDOWN_SECONDS:
            return False
        state.last_fired_by_key[key] = now_ts
    return True


def _within_proximity(
    msg: RealtimeMessage,
    config: AlertConfig,
    current_price: float | None,
) -> bool:
    if current_price is None or msg.tier is None:
        return True
    price = _event_price(msg)
    if price is None:
        return True
    threshold = {
        "CRITICAL": config.proximity.critical_pt,
        "HIGH": config.proximity.high_pt,
        "MEDIUM": config.proximity.medium_pt,
    }[msg.tier]
    return abs(price - current_price) <= threshold


def _event_price(msg: RealtimeMessage) -> float | None:
    payload: Any = msg.payload
    price = getattr(payload, "price", None)
    if isinstance(price, (int, float)):
        return float(price)
    metadata = getattr(payload, "metadata", None)
    if isinstance(metadata, dict):
        for key in ("level_price", "price", "zone_price"):
            value = metadata.get(key)
            if isinstance(value, (int, float)):
                return float(value)
            if isinstance(value, str):
                try:
                    return float(value)
                except ValueError:
                    pass
    return None


def _alert_key(msg: RealtimeMessage) -> str:
    payload: Any = msg.payload
    price = _event_price(msg)
    level = getattr(payload, "level_id", None)
    side = getattr(payload, "side", None) or getattr(payload, "direction", None)
    if side is None and isinstance(getattr(payload, "metadata", None), dict):
        side = payload.metadata.get("side") or payload.metadata.get("direction")
    price_bucket = "session" if price is None else round(price / 0.25) * 0.25
    return "|".join(
        str(part)
        for part in (
            getattr(payload, "family", "unknown"),
            level or price_bucket,
            side or "",
            msg.tier or "",
        )
    )


__all__ = ["NotificationGateState", "should_notify", "in_quiet_hours"]
