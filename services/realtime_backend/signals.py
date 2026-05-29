"""LiveSignals → contract-payload translation, diffing, and tier policy.

This module is the detection/transport boundary. It owns three concerns, all
pure (no I/O, no sockets, no detectors) so they unit-test trivially:

1. **Diffing** — :func:`diff_signals` compares two successive
   :class:`~rithmic_dashboard.models.LiveSignals` snapshots and returns only
   the *newly appeared* domain events. We diff rather than trust deltas
   because ``compute_live_signals`` is disk-stateful (append-then-reload) and
   re-emits its full recent window every call.

2. **Mapping** — :func:`events_to_payloads` turns those new events into frozen
   :mod:`contracts.realtime` payloads (sweep → SweepPayload, etc.). The
   ``UNKNOWN`` volatility regime is dropped, not widened into the contract.

3. **Tiering** — :func:`classify_payloads` applies the GREEN-LIT tier policy,
   reusing the RA-050 ``build_recent_signals`` + ``build_multi_signal_stack_alerts``
   layer to find same-zone confluence stacks.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from contracts.realtime.events import (
    AbsorptionPayload,
    IcebergPayload,
    RealtimePayload,
    Regime,
    SignalPayload,
    SnapshotPayload,
    SweepPayload,
    Tier,
    VolRegimePayload,
    ZoneState,
)
from rithmic_dashboard.features.multi_signal_stack_alert import (
    build_multi_signal_stack_alerts,
)
from rithmic_dashboard.features.recent_signals_panel import RecentSignal
from rithmic_dashboard.models import (
    AbsorptionProxyEvent,
    AggressorFlowEvent,
    DeltaDislocationEvent,
    IcebergEvent,
    LiveSignals,
    SweepEvent,
)

# Sweep intensity at or above this single-handedly earns HIGH (GREEN-LIT).
HIGH_SWEEP_INTENSITY = 4.5

# Families that map onto the SignalPayload "signal" family (used for stack
# proximity grouping in the RA-050 layer).
_VOL_UNKNOWN = "UNKNOWN"


@dataclass(frozen=True)
class MappedEvent:
    """A new domain event paired with its contract payload + provenance.

    ``family`` is the RA-050 family string ("sweep", "absorption", ...),
    ``zone_price`` the price used for confluence proximity, ``intensity`` the
    numeric urgency, and ``high_urgency`` flags a single-event HIGH trigger
    (delta dislocation, or sweep intensity >= 4.5).
    """

    payload: RealtimePayload
    message_type: str  # "event" | "regime"
    family: str
    zone_price: float | None
    intensity: float
    high_urgency: bool


# --------------------------------------------------------------------------
# Diffing — newly appeared events between two LiveSignals snapshots
# --------------------------------------------------------------------------


def _sweep_key(e: SweepEvent) -> tuple[Any, ...]:
    return ("sweep", e.timestamp_ns, e.level_id, round(e.level_price, 2), e.direction)


def _absorption_key(e: AbsorptionProxyEvent) -> tuple[Any, ...]:
    return ("absorption", e.timestamp_ns, round(e.price, 2), e.side_inferred, e.net_delta)


def _dislocation_key(e: DeltaDislocationEvent) -> tuple[Any, ...]:
    return ("dislocation", e.timestamp_ns, e.level_id, e.side, e.hourly_cvd)


def _iceberg_key(e: IcebergEvent) -> tuple[Any, ...]:
    return ("iceberg", e.timestamp_ns, e.level_id, e.side, e.refill_count)


def _aggressor_key(e: AggressorFlowEvent) -> tuple[Any, ...]:
    return ("aggressor", e.timestamp_ns, e.event_type, e.level_id, round(e.intensity, 3))


@dataclass(frozen=True)
class SignalDiff:
    """New domain events that appeared in ``current`` but not in ``previous``."""

    sweeps: tuple[SweepEvent, ...]
    absorption: tuple[AbsorptionProxyEvent, ...]
    dislocations: tuple[DeltaDislocationEvent, ...]
    icebergs: tuple[IcebergEvent, ...]
    aggressor: tuple[AggressorFlowEvent, ...]
    regime_changed: bool

    def is_empty(self) -> bool:
        return not (
            self.sweeps
            or self.absorption
            or self.dislocations
            or self.icebergs
            or self.aggressor
            or self.regime_changed
        )


def diff_signals(previous: LiveSignals | None, current: LiveSignals) -> SignalDiff:
    """Return events present in ``current`` that were absent from ``previous``.

    On the first call (``previous is None``) every event in ``current`` is
    treated as new — this seeds the feed after the snapshot is sent.
    """

    if previous is None:
        prev_sweep: set[tuple[Any, ...]] = set()
        prev_absorption: set[tuple[Any, ...]] = set()
        prev_disloc: set[tuple[Any, ...]] = set()
        prev_iceberg: set[tuple[Any, ...]] = set()
        prev_aggressor: set[tuple[Any, ...]] = set()
        prev_regime: str | None = None
    else:
        prev_sweep = {_sweep_key(e) for e in previous.sweeps}
        prev_absorption = {_absorption_key(e) for e in previous.absorption_proxies}
        prev_disloc = {_dislocation_key(e) for e in previous.delta_dislocations}
        prev_iceberg = {_iceberg_key(e) for e in previous.iceberg_events}
        prev_aggressor = {_aggressor_key(e) for e in previous.aggressor_flow_events}
        prev_regime = _regime_name(previous)

    regime_now = _regime_name(current)
    regime_changed = (
        regime_now is not None
        and regime_now != _VOL_UNKNOWN
        and regime_now != prev_regime
    )

    return SignalDiff(
        sweeps=tuple(e for e in current.sweeps if _sweep_key(e) not in prev_sweep),
        absorption=tuple(
            e for e in current.absorption_proxies if _absorption_key(e) not in prev_absorption
        ),
        dislocations=tuple(
            e for e in current.delta_dislocations if _dislocation_key(e) not in prev_disloc
        ),
        icebergs=tuple(e for e in current.iceberg_events if _iceberg_key(e) not in prev_iceberg),
        aggressor=tuple(
            e for e in current.aggressor_flow_events if _aggressor_key(e) not in prev_aggressor
        ),
        regime_changed=regime_changed,
    )


def _regime_name(signals: LiveSignals) -> str | None:
    if signals.volatility_regime is None:
        return None
    return signals.volatility_regime.regime


# --------------------------------------------------------------------------
# Mapping — domain events -> contract payloads
# --------------------------------------------------------------------------


def _absorption_side(side_inferred: str) -> str:
    """Map RA-046 side_inferred to the contract bid/ask discriminator.

    ``buy_absorbed`` = aggressive buyers were absorbed by resting offers → the
    *ask* held, so ``side="ask"``. ``sell_absorbed`` → ``side="bid"``.
    """
    if side_inferred == "buy_absorbed":
        return "ask"
    if side_inferred == "sell_absorbed":
        return "bid"
    return "bid"


def _absorption_score(event: AbsorptionProxyEvent) -> float:
    """Synthesize a 0..1 score from the proxy's confidence + volume.

    The RA-046 proxy carries ``confidence`` (high/low) and ``volume`` but no
    explicit score; the contract's AbsorptionPayload requires one. High
    confidence floors at 0.7; low at 0.4.
    """
    return 0.7 if event.confidence == "high" else 0.4


def _confidence(value: str | None) -> str:
    """Coerce an arbitrary confidence string to the contract enum."""
    if value in {"high", "medium", "low"}:
        return value
    if value == "low_tail_span":
        return "low"
    return "medium"


def _to_regime(name: str) -> Regime | None:
    """Contract regime is LOW/NORMAL/HIGH only; UNKNOWN → None (do not emit)."""
    if name in {"LOW", "NORMAL", "HIGH"}:
        return name  # type: ignore[return-value]
    return None


def map_sweep(event: SweepEvent) -> MappedEvent:
    payload = SweepPayload(
        price=event.level_price,
        direction=event.direction,
        ticks_cleared=int(round(event.intensity_score)),
        level_id=event.level_id,
        description=(
            f"Sweep {event.direction.upper()} at {event.level_text} "
            f"({event.level_price:,.2f}), intensity {event.intensity_score:.2f}"
        ),
    )
    return MappedEvent(
        payload=payload,
        message_type="event",
        family="sweep",
        zone_price=event.level_price,
        intensity=event.intensity_score,
        high_urgency=event.intensity_score >= HIGH_SWEEP_INTENSITY,
    )


def map_absorption(event: AbsorptionProxyEvent) -> MappedEvent:
    payload = AbsorptionPayload(
        price=event.price,
        side=_absorption_side(event.side_inferred),  # type: ignore[arg-type]
        score=_absorption_score(event),
        level_id=f"absorption-{event.price:.2f}",
        description=(
            f"{event.side_inferred.replace('_', ' ')} at {event.price:,.2f}: "
            f"vol {event.volume:,}, delta {event.net_delta:+,}, "
            f"confidence {event.confidence}"
        ),
    )
    return MappedEvent(
        payload=payload,
        message_type="event",
        family="absorption",
        zone_price=event.price,
        intensity=_absorption_score(event),
        high_urgency=False,
    )


def map_dislocation(event: DeltaDislocationEvent) -> MappedEvent:
    payload = SignalPayload(
        event_type=f"delta_dislocation_{event.side}_detected",
        level_id=event.level_id,
        description=(
            f"Delta dislocation {event.side} at {event.level_text} "
            f"({event.level_price:,.2f}): candle {event.candle_direction}, "
            f"CVD {event.hourly_cvd:+,}, confidence {event.confidence}"
        ),
        intensity=abs(float(event.hourly_cvd)),
        confidence=_confidence(event.confidence),  # type: ignore[arg-type]
        metadata={
            "family": "dislocation",
            "side": event.side,
            "level_price": event.level_price,
            "hourly_cvd": event.hourly_cvd,
            "is_strong": event.is_strong,
        },
    )
    return MappedEvent(
        payload=payload,
        message_type="event",
        family="dislocation",
        zone_price=event.level_price,
        intensity=abs(float(event.hourly_cvd)),
        high_urgency=True,  # delta dislocation is a single high-urgency event
    )


def map_iceberg(event: IcebergEvent) -> MappedEvent:
    payload = IcebergPayload(
        price=event.level_price,
        side=event.side,
        refills=event.refill_count,
        total_consumed=event.total_consumed,
        level_id=event.level_id,
        description=event.description,
    )
    return MappedEvent(
        payload=payload,
        message_type="event",
        family="iceberg",
        zone_price=event.level_price,
        intensity=event.intensity,
        high_urgency=False,
    )


def map_aggressor(event: AggressorFlowEvent) -> MappedEvent:
    payload = SignalPayload(
        event_type=event.event_type,
        level_id=event.level_id,
        description=event.description,
        intensity=event.intensity,
        confidence=_confidence(event.confidence),  # type: ignore[arg-type]
        metadata={
            "family": "aggressor_flow",
            "direction": event.direction,
            "level_price": event.level_price,
        },
    )
    return MappedEvent(
        payload=payload,
        message_type="event",
        family="aggressor_flow",
        zone_price=event.level_price,
        intensity=event.intensity,
        high_urgency=False,
    )


def map_regime(signals: LiveSignals) -> MappedEvent | None:
    """Map the current volatility regime to a VolRegimePayload, or None.

    Returns None when the regime is UNKNOWN/absent (do NOT widen the contract).
    """
    vr = signals.volatility_regime
    if vr is None:
        return None
    regime = _to_regime(vr.regime)
    if regime is None:
        return None
    sigma = vr.sigma_effective_pts or vr.ewma_sigma_pts or vr.observation_sigma_pts or 0.0
    payload = VolRegimePayload(
        regime=regime,
        sigma=float(sigma),
        description=f"Vol regime → {regime} ({vr.reason})",
    )
    return MappedEvent(
        payload=payload,
        message_type="regime",
        family="vol_regime",
        zone_price=None,
        intensity=float(sigma),
        high_urgency=False,
    )


def events_to_payloads(diff: SignalDiff, signals: LiveSignals) -> list[MappedEvent]:
    """Translate a :class:`SignalDiff` into ordered :class:`MappedEvent`s."""
    mapped: list[MappedEvent] = []
    mapped.extend(map_sweep(e) for e in diff.sweeps)
    mapped.extend(map_absorption(e) for e in diff.absorption)
    mapped.extend(map_dislocation(e) for e in diff.dislocations)
    mapped.extend(map_iceberg(e) for e in diff.icebergs)
    mapped.extend(map_aggressor(e) for e in diff.aggressor)
    if diff.regime_changed:
        regime_event = map_regime(signals)
        if regime_event is not None:
            mapped.append(regime_event)
    return mapped


# --------------------------------------------------------------------------
# Tiering — GREEN-LIT tier policy with RA-050 confluence reuse
# --------------------------------------------------------------------------


def _stacked_families_at(
    zone_price: float | None,
    recent_signals: list[RecentSignal],
    current_price: float | None,
    *,
    max_price_distance: float,
) -> int:
    """Count distinct signal families stacked within proximity of ``zone_price``.

    Uses the RA-050 :func:`build_multi_signal_stack_alerts` layer so the
    confluence definition matches the dashboard exactly. Returns the family
    count for the stack whose zone is nearest ``zone_price`` (and within the
    30 pt window of current price); 1 if no qualifying stack contains it.
    """
    if zone_price is None:
        return 1
    alerts = build_multi_signal_stack_alerts(
        recent_signals=recent_signals,
        current_price=current_price,
        max_price_distance=max_price_distance,
    )
    best = 1
    for alert in alerts:
        if abs(alert.zone_price - zone_price) <= max_price_distance:
            best = max(best, len(alert.families))
    return best


def classify_tier(
    event: MappedEvent,
    *,
    recent_signals: list[RecentSignal],
    current_price: float | None,
    max_price_distance: float,
) -> Tier:
    """Apply the GREEN-LIT tier policy to one mapped event.

    - CRITICAL: >= 3 distinct families stacked at one zone within <= 30 pt.
    - HIGH: 2 families stacked OR a single high-urgency event
      (delta dislocation, or sweep intensity >= 4.5).
    - MEDIUM: everything else surfaced.
    """
    stacked = _stacked_families_at(
        event.zone_price,
        recent_signals,
        current_price,
        max_price_distance=max_price_distance,
    )
    if stacked >= 3:
        return "CRITICAL"
    if stacked == 2 or event.high_urgency:
        return "HIGH"
    return "MEDIUM"


def classify_payloads(
    events: Iterable[MappedEvent],
    *,
    recent_signals: list[RecentSignal],
    current_price: float | None,
    max_price_distance: float,
) -> list[tuple[MappedEvent, Tier]]:
    """Pair each mapped event with its tier."""
    return [
        (
            event,
            classify_tier(
                event,
                recent_signals=recent_signals,
                current_price=current_price,
                max_price_distance=max_price_distance,
            ),
        )
        for event in events
    ]


# --------------------------------------------------------------------------
# Snapshot — full current state for initial load / resync
# --------------------------------------------------------------------------


def zones_from_envelope(envelope: dict[str, Any] | None) -> list[ZoneState]:
    """Build chart price-line ZoneStates from the analytics envelope."""
    if not envelope:
        return []
    zones: list[ZoneState] = []
    for line in envelope.get("reference_lines", []):
        if not isinstance(line, dict):
            continue
        price = line.get("price")
        source = str(line.get("source", ""))
        if price is None or not source:
            continue
        try:
            price_f = float(price)
        except (TypeError, ValueError):
            continue
        zones.append(
            ZoneState(
                id=f"ref-{source}-{price_f:.2f}",
                kind=source,
                price=price_f,
                label=str(line.get("text", source)),
            )
        )
    return zones


def build_snapshot_payload(
    signals: LiveSignals | None,
    *,
    envelope: dict[str, Any] | None,
    recent_signals: list[RecentSignal],
) -> SnapshotPayload:
    """Assemble the full SnapshotPayload for initial load / resync."""
    price: float | None = None
    sigma: float | None = None
    regime: Regime | None = None
    if signals is not None:
        price = signals.live_vwap.vwap
        sigma = signals.live_vwap.sigma
        if signals.volatility_regime is not None:
            regime = _to_regime(signals.volatility_regime.regime)

    signal_payloads = [
        SignalPayload(
            event_type=rs.event_type,
            level_id=rs.level_id,
            description=rs.description,
            intensity=_recent_intensity(rs),
            confidence=_recent_confidence(rs),  # type: ignore[arg-type]
            metadata={"family": rs.family, "zone_text": rs.zone_text},
        )
        for rs in recent_signals
    ]

    return SnapshotPayload(
        price=price,
        sigma=sigma,
        regime=regime,
        zones=zones_from_envelope(envelope),
        recent_signals=signal_payloads,
        open_scenarios=[],
    )


def _recent_confidence(rs: RecentSignal) -> str:
    """RecentSignal exposes urgency, not the contract confidence enum.

    Map the urgency band onto a confidence band so snapshot SignalPayloads
    satisfy the contract's required ``confidence`` field.
    """
    return {"high": "high", "medium": "medium", "low": "low"}.get(rs.urgency, "medium")


def _recent_intensity(rs: RecentSignal) -> float:
    """Stable numeric intensity derived from the RecentSignal urgency band.

    RecentSignal carries no public numeric intensity; the contract's
    SignalPayload requires one, so derive a monotonic 0..1 value from urgency.
    """
    return {"high": 0.9, "medium": 0.6, "low": 0.3}.get(rs.urgency, 0.5)


__all__ = [
    "HIGH_SWEEP_INTENSITY",
    "MappedEvent",
    "SignalDiff",
    "diff_signals",
    "events_to_payloads",
    "map_sweep",
    "map_absorption",
    "map_dislocation",
    "map_iceberg",
    "map_aggressor",
    "map_regime",
    "classify_tier",
    "classify_payloads",
    "zones_from_envelope",
    "build_snapshot_payload",
]
