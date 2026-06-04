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

FlowDirection = Literal["bullish", "bearish", "neutral"]
TradeAggressor = Literal["buy", "sell", "unknown"]
InferredDirection = Literal["bullish", "bearish", "neutral", "unknown"]
FootprintSide = Literal["buy", "sell", "none", "unknown"]
OrderflowQuality = Literal["high", "inferred", "stale_l1", "unavailable"]
DepthQuality = Literal["live", "inferred", "stale_l1", "unavailable"]
FLOW_DIRECTIONS: tuple[str, ...] = ("bullish", "bearish", "neutral")
TRADE_AGGRESSORS: tuple[str, ...] = ("buy", "sell", "unknown")
INFERRED_DIRECTIONS: tuple[str, ...] = ("bullish", "bearish", "neutral", "unknown")
FOOTPRINT_SIDES: tuple[str, ...] = ("buy", "sell", "none", "unknown")
ORDERFLOW_QUALITIES: tuple[str, ...] = ("high", "inferred", "stale_l1", "unavailable")
DEPTH_QUALITIES: tuple[str, ...] = ("live", "inferred", "stale_l1", "unavailable")
DEPTH_N_TICKS_MAX: int = 200

# Known payload families. Adding a family here REQUIRES a matching entry in
# events.ts KNOWN_FAMILIES or the parity test fails.
KNOWN_FAMILIES: tuple[str, ...] = (
    "signal",
    "iceberg",
    "absorption",
    "sweep",
    "vol_regime",
    "price_tick",
    "depth",
    "zone_update",
    "snapshot",
    "heartbeat",
    "error",
    "persistent_level",
    "auction_state",
    "mbp_pulse",
    "methodology_health",
)

# RA-112e step 3: rolling tactical-anchor position vs full-session value area.
# A separate state from `Regime` (which measures vol) — the rolling 60-min
# VWAP can sit above, inside, or below today's value area regardless of vol.
AuctionVsValueState = Literal[
    "above_value", "inside_value", "below_value", "unknown"
]

# RA-112e step 5: Globex/RTH tactical split status.
#   live     — trailing 60-min window has matured enough that σ + shelves
#              are trustworthy (≥ WARMUP_MIN_TAPE_MINUTES of data).
#   warmup   — shelves are still computed (so the chart shows rough levels)
#              but the trailing window is too short for stable σ — the UI
#              should mark the shelves as warming up.
#   no_data  — no shelves available this cycle (cold start, missing envelope,
#              etc.). Different from warmup: no shelves at all to render.
TacticalStatus = Literal["live", "warmup", "no_data"]

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


class CvdStats(BaseModel):
    """Inference-derived CVD summary from normalized trades.

    Rithmic does not currently provide normalized F/T action types in this
    stack (RA-064), so CVD direction is inferred from aggressor/L1 logic.
    """

    session_cvd: int
    last_60m_cvd: int
    last_15m_cvd: int
    session_direction: FlowDirection
    last_15m_direction: FlowDirection
    momentum_flip: bool


class AggressorWindowStats(BaseModel):
    """Inference-derived lift-ask / hit-bid window metrics."""

    window_seconds: int
    label: str
    lift_ask: int
    hit_bid: int
    net: int
    ratio: float
    total_volume: int
    direction: InferredDirection


class VDeltaStats(BaseModel):
    """Inference-derived short-window delta velocity."""

    window_seconds: int
    value: int
    direction: InferredDirection
    sign_flip: bool
    prior_direction: InferredDirection
    confirmed_seconds: int


class FootprintStats(BaseModel):
    """Inference-derived footprint summary for the latest aggregation bar.

    ``stacked_side`` uses trade-side vocabulary (buy/sell/none), not flow-bias
    vocabulary (bullish/bearish/neutral).
    """

    bar_start_ns: int | None = None
    bar_end_ns: int | None = None
    stacked_side: FootprintSide
    stacked_count: int
    stacked_low_price: float | None = None
    stacked_high_price: float | None = None


class OrderflowStats(BaseModel):
    """Optional orderflow context attached to compute-path price ticks.

    Fast-path price ticks set this field to ``None``. Compute-path ticks carry
    inference-derived CVD, aggressor, v-delta, and footprint context from the
    detector stack. ``quality`` reflects how reliable the aggressor/L1 inputs
    were for that inference; these fields are not exchange-provided truth.
    """

    quality: OrderflowQuality
    last_trade_aggressor: TradeAggressor
    last_trade_delta: int | None = None
    cvd: CvdStats | None = None
    aggressor_windows: list[AggressorWindowStats] = Field(default_factory=list)
    v_delta: VDeltaStats | None = None
    footprint: FootprintStats | None = None


class PriceTickPayload(RealtimePayload):
    """Top-of-book / last-trade tick. Routes to chart ``series.update()``.

    ``orderflow`` is ``None`` for low-latency fast-path ticks and populated on
    compute-path ticks. The client retains the latest non-null struct for the
    orderflow panel while accepting null fast ticks for price motion.
    """

    family: Literal["price_tick"] = "price_tick"
    price: float
    bid: float | None = None
    ask: float | None = None
    volume: int | None = None
    orderflow: OrderflowStats | None = None


class DepthLevel(BaseModel):
    """One bounded DOM level in a full depth snapshot."""

    price: float
    size: int = Field(ge=0)


class DepthPayload(RealtimePayload):
    """Bounded full depth snapshot for heatmap/DOM rendering.

    This is a full snapshot, not a diff. The backend caps each side to
    ``n_ticks`` levels so the wire payload remains bounded under busy opens;
    ``n_ticks`` means max levels per side. ``bid_levels`` are ordered
    descending by price (best/nearest bid first); ``ask_levels`` are ordered
    ascending by price (best/nearest ask first). ``quality`` meanings:
    ``live`` = seeded MBO book with fresh bid/ask mid; ``inferred`` = seeded
    book centered from latest trade because bid/ask is unavailable;
    ``stale_l1`` = stale price or depth context; ``unavailable`` = no usable
    book or mid.
    """

    family: Literal["depth"] = "depth"
    ts_ns: int
    mid: float | None = None
    bid_levels: list[DepthLevel] = Field(
        default_factory=list,
        max_length=DEPTH_N_TICKS_MAX,
    )
    ask_levels: list[DepthLevel] = Field(
        default_factory=list,
        max_length=DEPTH_N_TICKS_MAX,
    )
    n_ticks: int = Field(ge=1, le=DEPTH_N_TICKS_MAX)
    quality: DepthQuality


class ZoneState(BaseModel):
    """One horizontal level rendered as a chart price line."""

    model_config = ConfigDict(extra="allow")

    id: str
    kind: str  # vpoc | vah | val | sigma1 | sigma2 | demand | supply | wvwap | ...
    price: float
    label: str | None = None


class Shelf(BaseModel):
    """RA-112e step 4: a σ supply/demand shelf rendered as a filled band.

    Mirrors the on-disk schema in
    ``services/realtime_backend/zone_snapshots.py`` so a record can move
    losslessly between the WS frame and the JSONL stream.

    ``family`` distinguishes the production v3 (VWAP-anchored) shelves from
    the v2-legacy shadow shelves the operator wants drawn side-by-side until
    v3 is validated.
    """

    model_config = ConfigDict(extra="allow")

    family: str
    name: str
    low: float
    high: float
    tier: int
    bound_source: str  # "estimator" | "atr_cap"
    cap_bound: bool
    overlaps_vah: bool = False
    overlaps_val: bool = False
    nearest_structural_level: str | None = None
    distance_to_structural_level_ticks: float | None = None


class ZoneUpdatePayload(RealtimePayload):
    """Full or incremental set of active zones (drives price-line layer)."""

    family: Literal["zone_update"] = "zone_update"
    zones: list[ZoneState] = Field(default_factory=list)
    # RA-112e step 4: v3 + v2-legacy shelves. Broadcast on material change so
    # the chart can refresh the band overlay between snapshots. Empty list →
    # no shelf change in this update; consumers keep their last-known shelves.
    shelves: list[Shelf] = Field(default_factory=list)


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
    # RA-112e step 3: rolling tactical-anchor (60-min VWAP) position vs the
    # full-session value area. Optional so older snapshots without the field
    # still parse; absent / None → renders as "unknown" / no chip.
    auction_vs_value: AuctionVsValueState | None = None
    auction_distance_ticks: float | None = None
    # RA-112e step 4: cap-bind flags per shelf id (``"<family>:<name>"``) plus
    # the live shelves themselves. shelves is empty when v3 compute hasn't run
    # yet (cold start) or no envelope was available.
    cap_bind_flags: dict[str, bool] = Field(default_factory=dict)
    shelves: list[Shelf] = Field(default_factory=list)
    # RA-112e step 5: tactical status. None = legacy clients/older snapshots;
    # consumers should treat None as "live" for back-compat.
    tactical_status: TacticalStatus | None = None
    # How much of the trailing window the compute used (minutes). Useful for
    # debugging + showing "warming up — 12/30 min" style chips.
    tactical_tape_minutes: float | None = None
    # R12.1 (2026-06-04): composite-derived S/D zones (iceberg + absorption +
    # sweep evidence aggregated by PersistentLevelDetector). These are the
    # operator's primary "real" supply/demand levels — behavior-derived,
    # NOT statistical like sigma shelves. Sorted by composite strength
    # (confidence weight + evidence-source count, descending). Field is
    # optional / defaults empty so older snapshots without it still parse.
    persistent_levels: list["PersistentLevelPayload"] = Field(default_factory=list)


class MbpPulsePayload(RealtimePayload):
    """RA-112e step 7: periodic MBP1 readout for the live dashboard.

    Snapshotted from the RollingFeatureAccumulator at a ~1 Hz cadence so the
    Trade Posture panel can render OFI, depth imbalance, microprice offset,
    spread, and approach speed without doing rolling math client-side.

    Field naming mirrors zone_touches.PreTouchFeatures so a touch event row
    and the live pulse use the same wire shape — the operator sees the
    same number at touch time that gets recorded into the touch log.
    """

    family: Literal["mbp_pulse"] = "mbp_pulse"
    ts_ns: int
    ofi_5s: float | None = None
    ofi_15s: float | None = None
    ofi_30s: float | None = None
    ofi_60s: float | None = None
    trade_imbalance_5s: float | None = None
    trade_imbalance_15s: float | None = None
    trade_imbalance_30s: float | None = None
    trade_imbalance_60s: float | None = None
    approach_speed_1s: float | None = None
    approach_speed_5s: float | None = None
    approach_speed_15s: float | None = None
    depth_imbalance_touch: float | None = None
    depth_imbalance_mean_5s: float | None = None
    microprice_offset_touch: float | None = None
    microprice_offset_mean_5s: float | None = None
    spread_touch: float | None = None
    spread_max_5s: float | None = None


class AnchorVsValueDistribution(BaseModel):
    """RA-112e step 8: share-of-window decomposition of the auction-vs-value
    chip across the methodology-health window. Floats in [0, 1] summing to ~1.
    """

    above_value: float = 0.0
    inside_value: float = 0.0
    below_value: float = 0.0
    unknown: float = 0.0


class MethodologyHealthPayload(RealtimePayload):
    """RA-112e step 8: rolling diagnostics for the methodology rework.

    Broadcast on a slow cadence (default 10s) — these metrics shift slowly,
    so a high-frequency emit would just churn React for no benefit. The
    audit reviewer asked for: cap-bind rate, shelf-cross-anchor rate,
    touch-decay rate, estimator divergence. Touch-decay needs persistent
    per-zone touch counting and is deferred; everything else is here.

    Cap-bind rate fields are `None` when no observations carried any flag
    for that family — the dashboard treats `None` as "not yet observed."
    Cross-anchor rates default to 0.0 (the healthy state).
    """

    family: Literal["methodology_health"] = "methodology_health"
    ts_ns: int
    window_seconds: int
    observation_count: int = 0
    emit_count: int = 0
    emit_rate_per_minute: float = 0.0
    v3_cap_bind_rate: float | None = None
    v3_quantile_cap_bind_rate: float | None = None
    v3_shelf_cross_anchor_failure_rate: float = 0.0
    v2_shelf_cross_anchor_failure_rate: float = 0.0
    anchor_vs_value_distribution: AnchorVsValueDistribution = Field(
        default_factory=AnchorVsValueDistribution
    )
    warmup_share: float = 0.0
    estimator_width_divergence_sup_1_ticks: float | None = None
    # RA-112e step 10 / Move 3 — volatility guardrail surfacing (shadow mode).
    # None until shadow_enabled produces its first observation.
    active_cap_basis_dominant: str | None = None
    shadow_cap_basis_dominant: str | None = None
    # Share-of-window for each health tag (additive — sums can exceed 1.0
    # when multiple tags apply to the same observation).
    shadow_cap_health_share: dict[str, float] = Field(default_factory=dict)
    shadow_yz_mean_ladder_span_pts: float | None = None
    shadow_p99_mean_ladder_span_pts: float | None = None
    # RA-112e step 10 / Move 3 — cap-binding state classification.
    # ``legacy_cap_bind_rate`` = fraction of tier-observations where the
    #     legacy ATR cap binds (raw estimator wants more than the cap allows).
    # ``shadow_cap_bind_rate`` = same for the new YZ/p99 cap.
    # ``estimator_limited_rate`` = neither cap binds; the raw estimator IS
    #     the binding constraint. High value = today's failure mode is
    #     "estimator undersized", NOT "cap too tight".
    # All are None when no tier observations have landed yet.
    legacy_cap_bind_rate: float | None = None
    shadow_cap_bind_rate: float | None = None
    estimator_limited_rate: float | None = None
    cap_state_tier_count: int = 0
    # RA-112e step 10 / Move 3 — metric-hardening (separates tier vs snapshot
    # denominators; exposes window bounds; surfaces side+tier breakdowns and
    # raw RMS ladder span readouts).
    cap_state_snapshot_count: int = 0
    cap_state_window_start_ts_ns: int | None = None
    cap_state_window_end_ts_ns: int | None = None
    legacy_cap_bind_rate_by_side: dict[str, float] = Field(default_factory=dict)
    legacy_cap_bind_rate_by_tier: dict[str, float] = Field(default_factory=dict)
    shadow_cap_bind_rate_by_side: dict[str, float] = Field(default_factory=dict)
    shadow_cap_bind_rate_by_tier: dict[str, float] = Field(default_factory=dict)
    raw_rms_ladder_span_mean_pts: float | None = None
    raw_rms_ladder_span_p50_pts: float | None = None
    raw_rms_ladder_span_p95_pts: float | None = None
    active_cap_ladder_span_mean_pts: float | None = None
    shadow_cap_ladder_span_mean_pts: float | None = None


class AuctionStatePayload(RealtimePayload):
    """RA-112e step 3: standalone auction-vs-value chip event.

    Emitted on every state transition (above ↔ inside ↔ below) so the
    dashboard chip updates between snapshot refreshes. Carries the same
    fields as the SnapshotPayload addition plus a ``prior_state`` so the
    transition direction is explicit in the wire.
    """

    family: Literal["auction_state"] = "auction_state"
    state: AuctionVsValueState
    distance_ticks: float = 0.0
    prior_state: AuctionVsValueState | None = None
    anchor_price: float | None = None
    vah: float | None = None
    val: float | None = None


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


class PersistentLevelEvidence(BaseModel):
    """RA-108: per-source evidence contributing to a level's persistence.

    Each entry records WHY a level is being marked structural: which
    upstream detector (iceberg refill chain, absorption cluster, sweep
    anchor, sustained resting size), how many observations have
    accumulated, when the last one fired, and the cumulative size that
    has rested or transacted at this price.
    """

    model_config = ConfigDict(extra="forbid")

    source: Literal["resting_size", "iceberg_refill", "absorption", "sweep_anchor"]
    count: int = Field(ge=1)
    last_seen_ts_ns: int
    cumulative_size: float = Field(ge=0)


class PersistentLevelPayload(RealtimePayload):
    """RA-108: session-long structural price level.

    A level is "persistent" when multiple upstream detectors agree it's
    been defended over time. Unlike RA-107a wall markers (short-window,
    visible-depth only), persistent levels are session-scoped and remain
    marked on the chart even when price moves far from them — they will
    matter again on retest.

    Lifecycle:
        active        — currently accumulating evidence; trade off this
        deteriorating — no new evidence for the deterioration window;
                        operator should be cautious
        broken        — price traded through with conviction; one final
                        emit, then this level stops being emitted

    Side semantics:
        bid — buyers defending floor below mid
        ask — sellers defending ceiling above mid
        unknown — direction ambiguous (rare; usually mid-straddling cluster)
    """

    family: Literal["persistent_level"] = "persistent_level"
    level_id: str  # stable across emissions for the same (price, side) pair
    price: float
    side: Literal["bid", "ask", "unknown"]
    persistence_seconds: float = Field(ge=0.0)
    confidence: Confidence
    evidence: list[PersistentLevelEvidence] = Field(default_factory=list)
    last_active_ts_ns: int
    status: Literal["active", "deteriorating", "broken"]
    notes: str | None = None


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
    "depth": DepthPayload,
    "zone_update": ZoneUpdatePayload,
    "snapshot": SnapshotPayload,
    "heartbeat": HeartbeatPayload,
    "error": ErrorPayload,
    "persistent_level": PersistentLevelPayload,
    "auction_state": AuctionStatePayload,
    "mbp_pulse": MbpPulsePayload,
    "methodology_health": MethodologyHealthPayload,
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
    # RA-069 (LOW): monotonic-by-emitter-discipline; ge=0 rejects a negative seq
    # at the envelope boundary (the emitter starts at 0 and only increments).
    seq: int = Field(ge=0)
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
    "FLOW_DIRECTIONS",
    "TRADE_AGGRESSORS",
    "INFERRED_DIRECTIONS",
    "FOOTPRINT_SIDES",
    "ORDERFLOW_QUALITIES",
    "DEPTH_QUALITIES",
    "DEPTH_N_TICKS_MAX",
    "AuctionVsValueState",
    "TacticalStatus",
    "FlowDirection",
    "TradeAggressor",
    "InferredDirection",
    "FootprintSide",
    "OrderflowQuality",
    "DepthQuality",
    "PT",
    "now_pt_iso",
    "RealtimePayload",
    "SignalPayload",
    "IcebergPayload",
    "AbsorptionPayload",
    "SweepPayload",
    "VolRegimePayload",
    "CvdStats",
    "AggressorWindowStats",
    "VDeltaStats",
    "FootprintStats",
    "OrderflowStats",
    "PriceTickPayload",
    "DepthLevel",
    "DepthPayload",
    "ZoneState",
    "Shelf",
    "ZoneUpdatePayload",
    "ScenarioState",
    "SnapshotPayload",
    "HeartbeatPayload",
    "ErrorPayload",
    "PersistentLevelEvidence",
    "PersistentLevelPayload",
    "AuctionStatePayload",
    "MbpPulsePayload",
    "AnchorVsValueDistribution",
    "MethodologyHealthPayload",
    "GenericPayload",
    "parse_payload",
    "RealtimeMessage",
    "make_message",
]
