"""Shared dataclasses and literals for the dashboard pipeline."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Literal

Conviction = Literal["SUPER", "HIGH", "MED", "LOW"]
LevelDirection = Literal["above", "below", "at"]
LevelMotion = Literal["approaching", "crossing", "moved_away"]
ScenarioLifecycle = Literal["DORMANT", "WATCHING", "ACTIVE", "IN_PROGRESS", "COMPLETED"]
ScenarioDirection = Literal["long", "short"]
SessionKind = Literal["globex", "rth", "between"]
DayTypeName = Literal[
    "pending",
    "trend_day_up",
    "trend_day_down",
    "double_distribution_up",
    "double_distribution_down",
    "neutral_day_extreme",
    "neutral_day_center",
    "normal_variation_up",
    "normal_variation_down",
    "normal_day",
]
DayTypeStatus = Literal["pending", "classified", "skipped"]
DayTypeConfidence = Literal["high", "medium", "low"]
VolatilityRegimeName = Literal["LOW", "NORMAL", "HIGH", "UNKNOWN"]
VolatilityRegimeStatus = Literal["active", "unconfigured", "insufficient_data"]


@dataclass(frozen=True)
class DataWarning:
    """Human-facing warning surfaced in the dashboard header."""

    severity: Literal["info", "warn", "fail"]
    message: str


@dataclass(frozen=True)
class DashboardSession:
    """Resolved session context for one generator invocation."""

    state: Literal["globex_active", "rth_active", "between_sessions"]
    session: SessionKind
    trading_date: str
    now_pt: datetime
    session_start_pt: datetime | None
    session_end_pt: datetime | None
    zones_path: Path
    capture_path: Path
    first_30min: bool

    @property
    def key(self) -> str:
        return f"{self.trading_date}_{self.session}"


@dataclass(frozen=True)
class PriceSnapshot:
    """Current or last-known price plus provenance."""

    price: float | None
    source_path: Path | None
    event_time_pt: datetime | None
    source: str
    warnings: tuple[DataWarning, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class SpoofBin:
    """Top price bin from the order-pressure summary."""

    price: float
    n_events: int
    spoof_score: float


@dataclass(frozen=True)
class TradeTick:
    """Minimal normalized trade tick parsed from raw or OBS tails."""

    timestamp_ns: int | None
    price: float
    quantity: int
    aggressor_side: Literal["buy", "sell", "unknown"]


@dataclass(frozen=True)
class SweepEvent:
    """Live bounded-tail sweep through a structural level."""

    timestamp_pt: str
    timestamp_ns: int | None
    level_id: str
    level_text: str
    level_price: float
    direction: Literal["up", "down"]
    intensity_score: float
    recovered_within_5min: bool | None


@dataclass(frozen=True)
class AbsorptionProxyEvent:
    """Live bounded-tail proxy for absorption from trade clustering."""

    timestamp_pt: str
    timestamp_ns: int | None
    price: float
    volume: int
    net_delta: int
    side_inferred: str
    confidence: Literal["high", "low"]


@dataclass(frozen=True)
class DeltaDislocationEvent:
    """Candle/CVD divergence at a nearby structural level."""

    timestamp_pt: str
    timestamp_ns: int | None
    side: Literal["long", "short"]
    level_id: str
    level_text: str
    level_price: float
    candle_direction: Literal["up", "down", "flat"]
    hourly_cvd: int
    threshold_used: float
    proximity_pts: float
    confidence: Literal["high", "low_tail_span"]
    rolling_window_start_ts: int | None
    tail_span_minutes: float
    is_strong: bool


@dataclass(frozen=True)
class InstitutionalFlowEvent:
    """Institutional concentration or block trade event near a structural level."""

    timestamp_pt: str
    timestamp_ns: int | None
    event_type: Literal["institutional_concentration_detected", "block_trade_at_zone"]
    level_id: str
    level_text: str
    level_price: float
    side: Literal["buy", "sell"]
    trade_count: int
    institutional_volume: int
    net_delta: int
    block_count: int
    largest_trade: int
    window_minutes: int
    confidence: Literal["high", "low_tail_span"]
    tail_span_minutes: float
    intensity: float
    description: str


@dataclass(frozen=True)
class InstitutionalFlowSummary:
    """Compact institutional-flow read for the dashboard pulse."""

    total_institutional_volume: int
    net_institutional_delta: int
    block_trade_count: int
    concentration_count: int
    top_zone_text: str | None
    top_zone_price: float | None
    top_zone_volume_pct: float | None
    latest_event: str | None


@dataclass(frozen=True)
class DayTypeEvent:
    """Canonical day-type/IB event emitted for RA-050 recent signals."""

    timestamp_pt: str
    timestamp_ns: int | None
    event_type: Literal[
        "day_type_classified",
        "day_type_revised",
        "day_type_skipped_partial_session",
        "day_type_skipped_no_capture_data",
        "ib_high_break",
        "ib_low_break",
        "ib_extension_reached",
    ]
    level_id: str | None
    level_text: str | None
    level_price: float | None
    direction: Literal["long", "short", "neutral"]
    description: str
    intensity: float
    confidence: DayTypeConfidence
    metadata: dict[str, float | str | bool | None]


@dataclass(frozen=True)
class DayTypeClassification:
    """Session-level auction-market-theory classification."""

    trading_date: str
    session: str
    computed_at_pt: str
    status: DayTypeStatus
    day_type: DayTypeName
    confidence: DayTypeConfidence
    reason: str
    classification_timestamp_pt: str | None = None
    ib_high: float | None = None
    ib_low: float | None = None
    ib_range: float | None = None
    ib_midpoint: float | None = None
    rth_open: float | None = None
    session_high: float | None = None
    session_low: float | None = None
    current_price: float | None = None
    extension_above_pts: float | None = None
    extension_below_pts: float | None = None
    current_extension_pts: float | None = None
    current_extension_x_ib: float | None = None
    partial_session: bool = False
    skipped_reason: str | None = None
    source_path: Path | None = None
    events: tuple[DayTypeEvent, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class VolatilityRegimeEvent:
    """Canonical EWMA volatility-regime event emitted for recent signals."""

    timestamp_pt: str
    timestamp_ns: int | None
    event_type: Literal["vol_regime_changed"]
    level_id: str | None
    level_text: str | None
    level_price: float | None
    direction: Literal["neutral"]
    description: str
    intensity: float
    confidence: Literal["high", "medium", "low"]
    metadata: dict[str, float | str | bool | None]


@dataclass(frozen=True)
class VolatilityRegime:
    """EWMA volatility read against the calibrated historical corpus."""

    trading_date: str
    session: str
    computed_at_pt: str
    status: VolatilityRegimeStatus
    regime: VolatilityRegimeName
    observation_window_minutes: int
    observation_sigma_pts: float | None
    ewma_sigma_pts: float | None
    sigma_effective_pts: float | None
    corpus_median_sigma_pts: float | None
    ratio: float | None
    lambda_value: float | None
    regime_factor: float | None
    calibration_path: Path | None
    state_path: Path | None
    reason: str
    prior_regime: VolatilityRegimeName | None = None
    events: tuple[VolatilityRegimeEvent, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class LiveVwap:
    """Rolling live VWAP and dispersion from recent trade tail."""

    window_minutes: int
    vwap: float | None
    sigma: float | None
    plus_1sd: float | None
    minus_1sd: float | None


@dataclass(frozen=True)
class LiveCvd:
    """Live CVD windows computed from recent trade tail."""

    session_cvd: int | None
    last_60m_cvd: int | None
    last_15m_cvd: int | None
    session_direction: Literal["bullish", "bearish", "neutral", "unknown"]
    last_15m_direction: Literal["bullish", "bearish", "neutral", "unknown"]
    momentum_flip: bool


@dataclass(frozen=True)
class VolumeVelocity:
    """Trades/min velocity versus a bounded-tail baseline."""

    trades_last_15m: int
    trades_per_min: float | None
    baseline_per_min: float | None
    ratio: float | None
    state: Literal["active", "normal", "quiet", "unknown"]


@dataclass(frozen=True)
class AggressorWindowMetric:
    """Windowed liftAsk/hitBid decomposition from recent trade flow."""

    window_seconds: int
    label: str
    lift_ask: int
    hit_bid: int
    net: int
    ratio: float | None
    total_volume: int
    direction: Literal["bullish", "bearish", "neutral", "unknown"]


@dataclass(frozen=True)
class VDelta:
    """Short-window signed volume with sign-flip hysteresis state."""

    window_seconds: int
    value: int | None
    direction: Literal["bullish", "bearish", "neutral", "unknown"]
    sign_flip: bool
    prior_direction: Literal["bullish", "bearish", "neutral", "unknown"] | None
    confirmed_seconds: int | None


@dataclass(frozen=True)
class FootprintLevel:
    """Per-price bid/ask trade volume inside a footprint bar."""

    price: float
    bid_volume: int
    ask_volume: int
    total_volume: int
    imbalance: float


@dataclass(frozen=True)
class FootprintBar:
    """Compact per-price footprint for the most recent completed bar."""

    bar_start_pt: str
    bar_end_pt: str
    bar_start_ns: int
    bar_end_ns: int
    levels: tuple[FootprintLevel, ...]
    stacked_side: Literal["buy", "sell", "none"]
    stacked_count: int
    stacked_low_price: float | None
    stacked_high_price: float | None


@dataclass(frozen=True)
class AggressorFlowEvent:
    """Canonical aggressor-flow/footprint event emitted for recent signals."""

    timestamp_pt: str
    timestamp_ns: int | None
    event_type: Literal[
        "aggressor_imbalance_extreme",
        "stacked_footprint_imbalance",
        "v_delta_sign_flip",
    ]
    level_id: str | None
    level_text: str | None
    level_price: float | None
    direction: Literal["long", "short", "neutral"]
    description: str
    intensity: float
    confidence: Literal["high", "medium", "low"]
    metadata: dict[str, float | int | str | bool | None]


@dataclass(frozen=True)
class MboOrderEvent:
    """Minimal normalized MBO order-lifecycle event from bounded tails."""

    timestamp_ns: int
    recv_ts_ns: int | None
    sequence: int | None
    action: Literal["A", "M", "C", "F", "T"]
    side: Literal["B", "A"]
    price: float
    size: int
    order_id: str
    # RA-065: Rithmic depth_order_priority (FIFO queue position) carried as a
    # raw string. Defaulted so pre-RA-065 ``.mbo.jsonl`` siblings (which lack
    # the field) and existing call sites stay loadable; parsed to int lazily
    # inside MboOrderTracker. None on the backward-compat path.
    priority: str | None = None


@dataclass(frozen=True)
class IcebergEvent:
    """Inferred iceberg-like refill/defended-level event."""

    timestamp_pt: str
    timestamp_ns: int | None
    event_type: Literal["iceberg_detected", "iceberg_high_intensity_stack_detected"]
    level_id: str
    level_text: str
    level_price: float
    side: Literal["bid", "ask"]
    direction: ScenarioDirection
    refill_count: int
    total_consumed: int
    median_refill_size: float
    window_seconds: int
    confidence: Literal["high", "medium", "low"]
    intensity: float
    description: str
    metadata: dict[str, float | int | str | bool | None]


@dataclass(frozen=True)
class IcebergSummary:
    """Compact iceberg read for the dashboard pulse."""

    active_count: int
    latest_event: str | None
    top_level_text: str | None
    top_level_price: float | None
    total_consumed: int
    dominant_direction: ScenarioDirection | Literal["neutral"] | None


@dataclass(frozen=True)
class LiveSignals:
    """All live intra-session signals computed on bounded capture tails."""

    trading_date: str
    session: str
    computed_at_pt: str
    source_path: Path
    tail_bytes: int
    trade_count: int
    live_vwap: LiveVwap
    cvd: LiveCvd
    velocity: VolumeVelocity
    sweeps: tuple[SweepEvent, ...]
    absorption_proxies: tuple[AbsorptionProxyEvent, ...]
    delta_dislocations: tuple[DeltaDislocationEvent, ...] = field(default_factory=tuple)
    institutional_flow_events: tuple[InstitutionalFlowEvent, ...] = field(default_factory=tuple)
    institutional_flow_summary: InstitutionalFlowSummary | None = None
    volatility_regime: VolatilityRegime | None = None
    aggressor_windows: tuple[AggressorWindowMetric, ...] = field(default_factory=tuple)
    v_delta: VDelta | None = None
    footprint_bar: FootprintBar | None = None
    aggressor_flow_events: tuple[AggressorFlowEvent, ...] = field(default_factory=tuple)
    iceberg_events: tuple[IcebergEvent, ...] = field(default_factory=tuple)
    iceberg_summary: IcebergSummary | None = None
    warnings: tuple[DataWarning, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class OrderflowPulse:
    """Compact orderflow read for the dashboard."""

    artifact_date: str
    artifact_session: str
    session_cvd: int | None
    last_60m_cvd: int | None
    buy_volume_pct: float | None
    spread_mean_ticks: float | None
    spread_p99_ticks: float | None
    crossed_quotes: int | None
    recent_absorption: str | None
    top_spoof_bins: tuple[SpoofBin, ...]
    pressure_status: str
    institutional_flow_summary: InstitutionalFlowSummary | None = None
    warnings: tuple[DataWarning, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class ActivePosture:
    """Short synthesized posture block for fast operator scanning."""

    title: str
    sentences: tuple[str, ...]


@dataclass(frozen=True)
class LevelDistance:
    """Distance from current price to a reference line or zone midpoint."""

    level_id: str
    price: float
    text: str
    source: str
    conviction: Conviction | None
    distance_pts: float
    distance_atr: float
    direction: LevelDirection
    state: LevelMotion


@dataclass(frozen=True)
class AdjustmentFactor:
    """One transparent probability multiplier displayed in a tooltip."""

    name: str
    multiplier: float
    reason: str
    trigger: str | None = None
    is_structural: bool = False


@dataclass(frozen=True)
class ScenarioState:
    """Rendered state for one scenario template."""

    scenario_id: str
    name: str
    direction: ScenarioDirection
    state: ScenarioLifecycle
    entry_zone_low: float
    entry_zone_high: float
    stop: float
    target_1: float
    target_2: float | None
    target_3: float | None
    prior_prob_low: float
    prior_prob_high: float
    adjusted_prob_low: float
    adjusted_prob_high: float
    r_multiple_t1: float
    r_multiple_t2: float | None
    r_multiple_t3: float | None
    current_r: float
    adjustment_factors: tuple[AdjustmentFactor, ...]
    tooltip: str
    reason: str


@dataclass(frozen=True)
class ConfluenceGroup:
    """A cluster of methods agreeing around the same price."""

    levels: tuple[LevelDistance, ...]
    center_price: float
    span_pts: float
    tightness: Literal["TIGHT", "LOOSE"]
    conviction_score: Conviction


@dataclass(frozen=True)
class SessionSignals:
    """First-30-minute session confirmation matrix."""

    open_print: float
    open_vs_close_ref: Literal["above", "below", "at"]
    first_30min_vwap: float | None
    first_30min_vwap_vs_threshold: Literal["bull", "bear", "neutral"]
    net_cvd_30min: int | None
    cvd_direction: Literal["bull", "bear", "neutral"]
    first_test_of_lower_confluence: bool
    first_test_of_upper_confluence: bool
    captured_at_pt: datetime | None = None


@dataclass(frozen=True)
class AuditEntry:
    """Rolling operator-facing event trail entry."""

    timestamp_pt: str
    event_type: Literal[
        "level_crossed",
        "scenario_state_change",
        "confluence_break",
        "data_warning",
        "sweep_detected",
        "absorption_proxy",
        "cvd_momentum_flip",
        "delta_dislocation_long_detected",
        "delta_dislocation_short_detected",
        "institutional_concentration_detected",
        "block_trade_at_zone",
        "day_type_classified",
        "day_type_revised",
        "day_type_skipped_partial_session",
        "day_type_skipped_no_capture_data",
        "ib_high_break",
        "ib_low_break",
        "ib_extension_reached",
        "dislocation_threshold_updated",
        "vol_regime_changed",
        "aggressor_imbalance_extreme",
        "stacked_footprint_imbalance",
        "v_delta_sign_flip",
        "iceberg_detected",
        "iceberg_high_intensity_stack_detected",
    ]
    description: str
    related_level_id: str | None = None
