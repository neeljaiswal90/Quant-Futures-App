"""Pure notification gate: decide whether a message fires a toast.

The decision is total and side-effect-free so it is exhaustively
unit-testable. A toast fires iff **all** of:

1. ``msg.tier`` is one of the configured tiers (CRITICAL/HIGH/MEDIUM);
2. that tier's :class:`TierAlertConfig` is ``enabled``;
3. that tier's ``windows_toast`` flag is set (CRITICAL true by default;
   HIGH/MEDIUM false by default but a user may opt in);
4. we are **not** inside the quiet-hours window.

Quiet-hours interpretation (documented deviation point): the real-time
contract's :class:`QuietHoursConfig` is ``audio_only`` — it is meant to
silence *audio* while keeping visual banners. This daemon has **no audio
channel**; its only output is a visual toast. Treating ``audio_only`` as
"suppress audio, keep visual" would make quiet-hours a no-op here, which
defeats the user's intent ("be quiet at night"). So when quiet-hours is
enabled we **fully suppress the toast** during the window, regardless of
``audio_only``. This is the daemon's single, deliberate reading of the
shared contract; surfaced in the ship report.
"""

from __future__ import annotations

from datetime import datetime, time

from contracts.realtime.config import AlertConfig, TierAlertConfig
from contracts.realtime.events import RealtimeMessage, Tier

# Maps the wire tier (UPPER) to the config attribute (lower).
_TIER_ATTR: dict[Tier, str] = {
    "CRITICAL": "critical",
    "HIGH": "high",
    "MEDIUM": "medium",
}


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


def should_notify(msg: RealtimeMessage, config: AlertConfig, now_pt: datetime) -> bool:
    """Return ``True`` iff ``msg`` should produce a Windows toast right now."""
    tier = msg.tier
    if tier not in _TIER_ATTR:
        return False
    tier_cfg = _tier_config(config, tier)
    if not (tier_cfg.enabled and tier_cfg.windows_toast):
        return False
    return not in_quiet_hours(config, now_pt)


__all__ = ["should_notify", "in_quiet_hours"]
