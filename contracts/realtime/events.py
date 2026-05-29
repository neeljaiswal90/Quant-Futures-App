"""Realtime wire contract — Pydantic v2 source of truth (RA-067).

This module is the single authoritative definition of the v2 realtime
dashboard wire format. The backend (RA-060), the React UI (RA-061), the
notification daemon (RA-062), and the alert-config system (RA-063) all
bind to the envelope + payload families declared here.

`events.ts` is the hand-kept TypeScript mirror; `tests/test_parity.py`
fails on any drift between the two (the integration tripwire described in
the parallel-execution dispatch). Do not edit one without the other.

Envelope shape::

    {type, seq, ts_ns, ts_pt, tier, schema_version, payload}

- ``type``      — coarse routing category for the client.
- ``seq``       — monotonic; client detects gaps and resyncs via REST.
- ``ts_ns``     — server-side event time, integer nanoseconds.
- ``ts_pt``     — ISO-8601 wall-clock in America/Los_Angeles (trader TZ).
- ``tier``      — CRITICAL / HIGH / MEDIUM / None (urgency for alerting).
- ``payload``   — family-discriminated body (see ``RealtimePayload``).

RA-050 schema-extensibility contract: an **unknown payload family**
round-trips through the envelope (parsed into :class:`GenericPayload`,
serialized back with all original fields intact via ``SerializeAsAny``)
and reaches the feed without crashing the renderer. ``test_extensibility``
enforces this.
"""

from __future__ import annotations

import time
from datetime import datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, SerializeAsAny, field_validator

# --------------------------------------------------------------------------
# Versioning + enumerations (mirrored as `as const` arrays in events.ts)
# --------------------------------------------------------------------------

SCHEMA_VERSION: int = 1

MessageType = Literal["snapshot", "event", "heartbeat", "regime", "error"]
MESSAGE_TYPES: tuple[str, ...] = ("snapshot", "event", "heartbeat", "regime", "error")

Tier = Literal["CRITICAL", "HIGH", "MEDIUM"]
TIERS: tuple[str, ...] = ("CRITICAL", "HIGH", "MEDIUM")

Confidence = Literal["high", "medium", "low"]

Regime = Literal["LOW", "NORMAL", "HIGH"]

# Known payload families. Adding a family here REQUIRES a matching entry in
# events.ts KNOWN_FAMILIES or the parity test fails.
KNOWN_FAMILIES: tuple[str, ...] = (
    "signal",
    "iceberg",
    "absorption",
    "sweep",
    "vol_regime",
    "price_tick",
    "zone_update",
    "snapshot",
    "heartbeat",
    "error",
)

# Envelope field order — mirrored in events.ts ENVELOPE_FIELDS for parity.
ENVELOPE_FIELDS: tuple[str, ...] = (
    "type",
    "seq",
    "ts_ns",
    "ts_pt",
    "tier",
    "schema_version",
    "payload",
)

PT: ZoneInfo = ZoneInfo("America/Los_Angeles")


def now_pt_iso() -> str:
    """Current wall-clock in the trader's timezone, ISO-8601."""
    return datetime.now(PT).isoformat()


# --------------------------------------------------------------------------
# Payloads — family-discriminated bodies
# --------------------------------------------------------------------------


class RealtimePayload(BaseModel):
    """Base for every payload family.

    ``extra="allow"`` so forward-added fields (and unknown-family bodies)
    survive a parse/serialize round-trip rather than being dropped — the
    RA-050 extensibility contract.
    """

    model_config = ConfigDict(extra="allow")

    family: str


class SignalPayload(RealtimePayload):
    """Generic prominence-layer event — the RA-050 audit event schema."""

    family: Literal["signal"] = "signal"
    event_type: str
    level_id: str | None = None
    description: str
    intensity: float
    confidence: Confidence
    metadata: dict[str, Any] = Field(default_factory=dict)


class IcebergPayload(RealtimePayload):
    """RA-059 inferred iceberg-like refill event."""

    family: Literal["iceberg"] = "iceberg"
    price: float
    side: Literal["bid", "ask"]
    refills: int
    total_consumed: int
    level_id: str | None = None
    description: str = ""


class AbsorptionPayload(RealtimePayload):
    """Absorption (RA-015 4-factor / RA-046 proxy) event."""

    family: Literal["absorption"] = "absorption"
    price: float
    side: Literal["bid", "ask"]
    score: float
    level_id: str | None = None
    description: str = ""


class SweepPayload(RealtimePayload):
    """RA-046 structural-level sweep (3-tick clearing)."""

    family: Literal["sweep"] = "sweep"
    price: float
    direction: Literal["up", "down"]
    ticks_cleared: int
    level_id: str | None = None
    description: str = ""


class VolRegimePayload(RealtimePayload):
    """RA-053 EWMA volatility regime state / transition."""

    family: Literal["vol_regime"] = "vol_regime"
    regime: Regime
    sigma: float
    description: str = ""


class PriceTickPayload(RealtimePayload):
    """Top-of-book / last-trade tick. Routes to chart ``series.update()``."""

    family: Literal["price_tick"] = "price_tick"
    price: float
    bid: float | None = None
    ask: float | None = None
    volume: int | None = None


class ZoneState(BaseModel):
    """One horizontal level rendered as a chart price line."""

    model_config = ConfigDict(extra="allow")

    id: str
    kind: str  # vpoc | vah | val | sigma1 | sigma2 | demand | supply | wvwap | ...
    price: float
    label: str | None = None


class ZoneUpdatePayload(RealtimePayload):
    """Full or incremental set of active zones (drives price-line layer)."""

    family: Literal["zone_update"] = "zone_update"
    zones: list[ZoneState] = Field(default_factory=list)


class ScenarioState(BaseModel):
    """One Tier-2 active scenario."""

    model_config = ConfigDict(extra="allow")

    id: str
    label: str
    probability: float | None = None
    target_price: float | None = None


class SnapshotPayload(RealtimePayload):
    """Full current state for initial load + post-reconnect resync."""

    family: Literal["snapshot"] = "snapshot"
    price: float | None = None
    sigma: float | None = None
    regime: Regime | None = None
    zones: list[ZoneState] = Field(default_factory=list)
    recent_signals: list[SignalPayload] = Field(default_factory=list)
    open_scenarios: list[ScenarioState] = Field(default_factory=list)


class HeartbeatPayload(RealtimePayload):
    """Liveness + staleness beacon. ``stale`` true → UI shows degraded."""

    family: Literal["heartbeat"] = "heartbeat"
    server_ts_ns: int
    last_capture_ts_ns: int | None = None
    stale: bool = False


class ErrorPayload(RealtimePayload):
    """Server-emitted error surfaced to the client."""

    family: Literal["error"] = "error"
    code: str
    message: str


class GenericPayload(RealtimePayload):
    """Catch-all for unknown / future families (RA-050 extensibility).

    Any body whose ``family`` is not in :data:`KNOWN_FAMILIES` parses into
    this model; ``extra="allow"`` preserves every original field so it can
    be re-serialized losslessly and reach the feed unchanged.
    """

    family: str


_PAYLOAD_REGISTRY: dict[str, type[RealtimePayload]] = {
    "signal": SignalPayload,
    "iceberg": IcebergPayload,
    "absorption": AbsorptionPayload,
    "sweep": SweepPayload,
    "vol_regime": VolRegimePayload,
    "price_tick": PriceTickPayload,
    "zone_update": ZoneUpdatePayload,
    "snapshot": SnapshotPayload,
    "heartbeat": HeartbeatPayload,
    "error": ErrorPayload,
}


def parse_payload(data: RealtimePayload | dict[str, Any]) -> RealtimePayload:
    """Coerce a dict (or pass through a model) into the right payload type.

    Known ``family`` → its typed model. Unknown ``family`` →
    :class:`GenericPayload` (round-trips losslessly). A missing ``family``
    raises ``ValueError`` — the envelope requires a discriminator.
    """
    if isinstance(data, RealtimePayload):
        return data
    if not isinstance(data, dict):
        raise TypeError(f"payload must be a dict or RealtimePayload, got {type(data)!r}")
    family = data.get("family")
    if not isinstance(family, str) or not family:
        raise ValueError("payload is missing a non-empty 'family' discriminator")
    model = _PAYLOAD_REGISTRY.get(family, GenericPayload)
    return model.model_validate(data)


# --------------------------------------------------------------------------
# Envelope
# --------------------------------------------------------------------------


class RealtimeMessage(BaseModel):
    """The single wire envelope. Every WS frame is one of these, JSON-encoded."""

    model_config = ConfigDict(extra="forbid")

    type: MessageType
    seq: int
    ts_ns: int
    ts_pt: str
    tier: Tier | None = None
    schema_version: int = SCHEMA_VERSION
    # SerializeAsAny: dump the concrete payload subclass's fields, not just
    # the RealtimePayload base — load-bearing for the extensibility contract.
    payload: SerializeAsAny[RealtimePayload]

    @field_validator("payload", mode="before")
    @classmethod
    def _coerce_payload(cls, value: object) -> RealtimePayload:
        return parse_payload(value)  # type: ignore[arg-type]


def make_message(
    *,
    type: MessageType,
    payload: RealtimePayload | dict[str, Any],
    seq: int,
    tier: Tier | None = None,
    ts_ns: int | None = None,
    ts_pt: str | None = None,
) -> RealtimeMessage:
    """Construct a :class:`RealtimeMessage`, stamping ts fields if omitted."""
    return RealtimeMessage(
        type=type,
        seq=seq,
        ts_ns=ts_ns if ts_ns is not None else time.time_ns(),
        ts_pt=ts_pt if ts_pt is not None else now_pt_iso(),
        tier=tier,
        payload=parse_payload(payload),
    )


__all__ = [
    "SCHEMA_VERSION",
    "MESSAGE_TYPES",
    "TIERS",
    "KNOWN_FAMILIES",
    "ENVELOPE_FIELDS",
    "MessageType",
    "Tier",
    "Confidence",
    "Regime",
    "PT",
    "now_pt_iso",
    "RealtimePayload",
    "SignalPayload",
    "IcebergPayload",
    "AbsorptionPayload",
    "SweepPayload",
    "VolRegimePayload",
    "PriceTickPayload",
    "ZoneState",
    "ZoneUpdatePayload",
    "ScenarioState",
    "SnapshotPayload",
    "HeartbeatPayload",
    "ErrorPayload",
    "GenericPayload",
    "parse_payload",
    "RealtimeMessage",
    "make_message",
]
