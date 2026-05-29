"""Distance-grid signal badges for recent live events."""

from __future__ import annotations

from dataclasses import dataclass

from rithmic_dashboard.features.multi_signal_stack_alert import MultiSignalStackAlert
from rithmic_dashboard.features.recent_signals_panel import RecentSignal, zone_key_for_level
from rithmic_dashboard.models import LevelDistance


@dataclass(frozen=True)
class ZoneSignalBadge:
    """Compact badge rendered in the Distance Grid signal column."""

    family: str
    icon: str
    label: str
    css_class: str
    tooltip: str


def build_zone_signal_badges(
    *,
    distances: list[LevelDistance],
    recent_signals: list[RecentSignal],
    stack_alerts: list[MultiSignalStackAlert],
) -> dict[str, tuple[ZoneSignalBadge, ...]]:
    """Return badges keyed by displayed distance level id."""

    signals_by_zone: dict[str, list[RecentSignal]] = {}
    for signal in recent_signals:
        signals_by_zone.setdefault(signal.zone_key, []).append(signal)

    stack_zones = {alert.zone_key for alert in stack_alerts}
    badges_by_level: dict[str, tuple[ZoneSignalBadge, ...]] = {}
    for level in distances:
        zone_key = zone_key_for_level(level)
        badges: list[ZoneSignalBadge] = []
        if zone_key in stack_zones:
            badges.append(
                ZoneSignalBadge(
                    family="stack",
                    icon="◆",
                    label="Stack",
                    css_class="zone-badge-stack",
                    tooltip=f"Multiple distinct signal types active near {level.text}",
                )
            )
        for family in (
            "sweep",
            "absorption",
            "dislocation",
            "institutional_flow",
            "iceberg",
            "aggressor_flow",
            "day_type",
            "vol_regime",
            "generic",
        ):
            family_signals = [
                signal for signal in signals_by_zone.get(zone_key, []) if signal.family == family
            ]
            if not family_signals:
                continue
            latest = family_signals[0]
            badges.append(
                ZoneSignalBadge(
                    family=family,
                    icon=latest.icon,
                    label=latest.label,
                    css_class=f"zone-badge-{family}",
                    tooltip=_tooltip(latest, len(family_signals)),
                )
            )
        if badges:
            badges_by_level[level.level_id] = tuple(badges)
    return badges_by_level


def _tooltip(signal: RecentSignal, count: int) -> str:
    repeated = f" ({count} recent)" if count > 1 else ""
    return f"{signal.label}{repeated}: {signal.description}"
