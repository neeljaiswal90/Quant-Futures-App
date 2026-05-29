"""Pure tier-gating decision for alert dispatch (RA-063).

:func:`should_fire` answers, for one candidate alert: *should this fire, and
through which channels?* It is a pure function of the current
:class:`AlertConfig`, the tier, the price distance, and the current PT
wall-clock — no I/O, no globals, no clock reads (``now_pt`` is injected so the
truth table is deterministic). The caller (RA-060's dispatch path) reads the
store's cached config and passes it in on every event, which is what makes a
PUT take effect on the next event with no restart.

Decision pipeline (short-circuits in this order):

1. **tier-enabled** — the tier's :class:`TierAlertConfig.enabled` is the master
   switch. Off -> nothing fires.
2. **proximity-armed** — price must be within the tier's configured
   proximity (``proximity.<tier>_pt``). Farther than that -> nothing fires.
3. **quiet-hours** — if enabled and ``now_pt`` falls inside the (possibly
   midnight-wrapping) window:
   - ``audio_only=True``  -> suppress audio, keep visual channels;
   - ``audio_only=False`` -> suppress the whole tier (nothing fires).

Channels mirror the contract's :class:`TierAlertConfig`: ``audio`` is gated by
the presence of an ``audio_file``; ``browser_notif`` and ``windows_toast`` are
the visual channels. A channel only ever fires if it is enabled in config *and*
not suppressed by the pipeline above.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time

from contracts.realtime.config import AlertConfig
from contracts.realtime.events import PT

# Suppression reasons (stable strings — handy for logs/telemetry, not a wire
# contract).
REASON_FIRE = "fire"
REASON_TIER_DISABLED = "tier_disabled"
REASON_OUT_OF_RANGE = "out_of_range"
REASON_QUIET_HOURS_FULL = "quiet_hours_suppressed"
REASON_QUIET_HOURS_AUDIO = "quiet_hours_audio_suppressed"


@dataclass(frozen=True)
class AlertDisposition:
    """The decision for one candidate alert.

    ``fire`` is the overall verdict (any channel will dispatch). The per-channel
    booleans are the *effective* channels after gating — each is already
    ANDed with the tier's config and the suppression rules, so a caller can
    dispatch a channel iff its flag is True without re-checking config.
    """

    fire: bool
    audio: bool
    browser_notif: bool
    windows_toast: bool
    reason: str

    @classmethod
    def suppressed(cls, reason: str) -> AlertDisposition:
        """A no-op disposition (no channels) with the given reason."""
        return cls(
            fire=False,
            audio=False,
            browser_notif=False,
            windows_toast=False,
            reason=reason,
        )


def _proximity_pt(config: AlertConfig, tier: str) -> float:
    """The proximity threshold (points) for ``tier``."""
    return float(getattr(config.proximity, f"{tier}_pt"))


def _parse_hhmm(value: str) -> time:
    """Parse a ``"HH:MM"`` string into a naive :class:`datetime.time`."""
    hours, _, minutes = value.partition(":")
    return time(hour=int(hours), minute=int(minutes))


def _within_quiet_hours(now_pt: datetime, start_pt: str, end_pt: str) -> bool:
    """Is ``now_pt`` inside the [start, end) PT window (wrap-around aware)?

    ``now_pt`` is normalized to the trader timezone before comparison so a
    caller may pass any tz-aware instant. The window is half-open: the start
    minute is inside, the end minute is outside. ``start == end`` is treated as
    an empty window (never quiet), matching the half-open convention.
    """
    local = now_pt.astimezone(PT) if now_pt.tzinfo is not None else now_pt.replace(tzinfo=PT)
    current = local.timetz().replace(tzinfo=None)
    start = _parse_hhmm(start_pt)
    end = _parse_hhmm(end_pt)
    if start == end:
        return False
    if start < end:
        # Same-day window, e.g. 09:00 -> 17:00.
        return start <= current < end
    # Wrap-around window spanning midnight, e.g. 22:00 -> 06:00.
    return current >= start or current < end


def should_fire(
    config: AlertConfig,
    tier: str,
    distance_pt: float,
    now_pt: datetime,
) -> AlertDisposition:
    """Decide whether (and how) an alert for ``tier`` should fire.

    Args:
        config: current alert preferences (the store's cached object).
        tier: one of ``"critical"`` / ``"high"`` / ``"medium"``.
        distance_pt: price distance from the level, in points (absolute; a
            negative value is treated by magnitude).
        now_pt: current wall-clock; normalized to America/Los_Angeles for the
            quiet-hours check. Injected for deterministic gating.

    Returns:
        An :class:`AlertDisposition` whose per-channel flags are already
        gated — dispatch a channel iff its flag is True.
    """
    tier_cfg = getattr(config, tier)

    # 1) Master tier switch.
    if not tier_cfg.enabled:
        return AlertDisposition.suppressed(REASON_TIER_DISABLED)

    # 2) Proximity arming. Compare by magnitude so callers may pass signed
    #    distances. ``<=`` so a level exactly at the threshold still arms.
    if abs(distance_pt) > _proximity_pt(config, tier):
        return AlertDisposition.suppressed(REASON_OUT_OF_RANGE)

    # Channels as configured for this tier (pre-suppression).
    audio = tier_cfg.audio_file is not None
    browser_notif = tier_cfg.browser_notif
    windows_toast = tier_cfg.windows_toast

    # 3) Quiet hours.
    quiet = config.quiet_hours
    if quiet.enabled and _within_quiet_hours(now_pt, quiet.start_pt, quiet.end_pt):
        if quiet.audio_only:
            # Silence audio, keep visual banners.
            return AlertDisposition(
                fire=browser_notif or windows_toast,
                audio=False,
                browser_notif=browser_notif,
                windows_toast=windows_toast,
                reason=REASON_QUIET_HOURS_AUDIO,
            )
        # Whole tier suppressed.
        return AlertDisposition.suppressed(REASON_QUIET_HOURS_FULL)

    return AlertDisposition(
        fire=audio or browser_notif or windows_toast,
        audio=audio,
        browser_notif=browser_notif,
        windows_toast=windows_toast,
        reason=REASON_FIRE,
    )


__all__ = [
    "AlertDisposition",
    "should_fire",
    "REASON_FIRE",
    "REASON_TIER_DISABLED",
    "REASON_OUT_OF_RANGE",
    "REASON_QUIET_HOURS_FULL",
    "REASON_QUIET_HOURS_AUDIO",
]
