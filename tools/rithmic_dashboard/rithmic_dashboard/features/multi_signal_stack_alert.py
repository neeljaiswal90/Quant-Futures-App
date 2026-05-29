"""Sticky same-zone multi-signal alert builder."""

from __future__ import annotations

from dataclasses import dataclass

from rithmic_dashboard.features.recent_signals_panel import RecentSignal


@dataclass(frozen=True)
class MultiSignalStackAlert:
    """Same-zone cluster of distinct signal families within the live window."""

    zone_key: str
    zone_text: str
    zone_price: float
    families: tuple[str, ...]
    signal_count: int
    latest_timestamp_pt: str
    distance_pts: float
    description: str
    tooltip: str


def build_multi_signal_stack_alerts(
    *,
    recent_signals: list[RecentSignal],
    current_price: float | None,
    max_price_distance: float = 30.0,
) -> list[MultiSignalStackAlert]:
    """Find same-zone clusters with at least two distinct signal families."""

    if current_price is None:
        return []
    grouped: dict[str, list[RecentSignal]] = {}
    for signal in recent_signals:
        if signal.zone_price is None:
            continue
        grouped.setdefault(signal.zone_key, []).append(signal)

    alerts: list[MultiSignalStackAlert] = []
    for zone_key, signals in grouped.items():
        families = _ordered_families({signal.family for signal in signals})
        if len(families) < 2:
            continue
        latest = max(signals, key=lambda signal: signal.sort_ts)
        zone_price = latest.zone_price
        if zone_price is None:
            continue
        distance_pts = zone_price - current_price
        if abs(distance_pts) > max_price_distance:
            continue
        family_text = " + ".join(_family_label(family) for family in families)
        alerts.append(
            MultiSignalStackAlert(
                zone_key=zone_key,
                zone_text=latest.zone_text,
                zone_price=zone_price,
                families=families,
                signal_count=len(signals),
                latest_timestamp_pt=latest.timestamp_pt,
                distance_pts=distance_pts,
                description=(
                    f"{family_text} stack at {latest.zone_text} "
                    f"({zone_price:,.2f}), {abs(distance_pts):.1f} pts from price"
                ),
                tooltip=" / ".join(signal.description for signal in signals[:5]),
            )
        )
    return sorted(alerts, key=lambda alert: abs(alert.distance_pts))


def _family_label(family: str) -> str:
    return {
        "sweep": "sweep",
        "absorption": "absorption",
        "dislocation": "dislocation",
        "institutional_flow": "institutional flow",
        "aggressor_flow": "aggressor flow",
        "day_type": "day type",
        "vol_regime": "vol regime",
    }.get(family, "signal")


def _ordered_families(families: set[str]) -> tuple[str, ...]:
    rank = {
        "sweep": 0,
        "absorption": 1,
        "dislocation": 2,
        "institutional_flow": 3,
        "aggressor_flow": 4,
        "day_type": 5,
        "vol_regime": 6,
        "generic": 7,
    }
    return tuple(sorted(families, key=lambda family: (rank.get(family, 9), family)))
