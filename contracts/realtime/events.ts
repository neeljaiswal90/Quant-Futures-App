/**
 * Realtime wire contract — TypeScript mirror of events.py (RA-067).
 *
 * This is the hand-kept TypeScript twin of the Pydantic source of truth in
 * `events.py`. The React UI (RA-061) and any TS consumer import these types.
 *
 * `tests/test_parity.py` parses the `as const` arrays below and the
 * envelope interface and asserts they match the Pydantic models exactly.
 * If you change one side, change both — a drift reds the parity test in
 * every worktree (the integration tripwire).
 *
 * RA-050 extensibility: an unknown payload family is represented by
 * `GenericPayload` and round-trips through the envelope unchanged.
 */

export const SCHEMA_VERSION = 1;

// --- Machine-checkable contract surface (parsed by test_parity.py) ---------

export const MESSAGE_TYPES = ["snapshot", "event", "heartbeat", "regime", "error"] as const;
export const TIERS = ["CRITICAL", "HIGH", "MEDIUM"] as const;
export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export const REGIMES = ["LOW", "NORMAL", "HIGH"] as const;
export const FLOW_DIRECTIONS = ["bullish", "bearish", "neutral"] as const;
export const TRADE_AGGRESSORS = ["buy", "sell", "unknown"] as const;
export const INFERRED_DIRECTIONS = ["bullish", "bearish", "neutral", "unknown"] as const;
export const FOOTPRINT_SIDES = ["buy", "sell", "none", "unknown"] as const;
export const ORDERFLOW_QUALITIES = ["high", "inferred", "stale_l1", "unavailable"] as const;
export const DEPTH_QUALITIES = ["live", "inferred", "stale_l1", "unavailable"] as const;
export const DEPTH_N_TICKS_MAX = 200;

export const KNOWN_FAMILIES = [
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
] as const;

// RA-112e step 3: rolling tactical-anchor position vs full-session value area.
export const AUCTION_VS_VALUE_STATES = [
  "above_value",
  "inside_value",
  "below_value",
  "unknown",
] as const;
export type AuctionVsValueState = typeof AUCTION_VS_VALUE_STATES[number];

export const ENVELOPE_FIELDS = [
  "type",
  "seq",
  "ts_ns",
  "ts_pt",
  "tier",
  "schema_version",
  "payload",
] as const;

// --- Derived literal types -------------------------------------------------

export type MessageType = (typeof MESSAGE_TYPES)[number];
export type Tier = (typeof TIERS)[number];
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];
export type Regime = (typeof REGIMES)[number];
export type FlowDirection = (typeof FLOW_DIRECTIONS)[number];
export type TradeAggressor = (typeof TRADE_AGGRESSORS)[number];
export type InferredDirection = (typeof INFERRED_DIRECTIONS)[number];
export type FootprintSide = (typeof FOOTPRINT_SIDES)[number];
export type OrderflowQuality = (typeof ORDERFLOW_QUALITIES)[number];
export type DepthQuality = (typeof DEPTH_QUALITIES)[number];
export type Family = (typeof KNOWN_FAMILIES)[number];

// --- Payload families ------------------------------------------------------

export interface SignalPayload {
  family: "signal";
  event_type: string;
  level_id: string | null;
  description: string;
  intensity: number;
  confidence: Confidence;
  metadata: Record<string, unknown>;
}

export interface IcebergPayload {
  family: "iceberg";
  price: number;
  side: "bid" | "ask";
  refills: number;
  total_consumed: number;
  level_id: string | null;
  description: string;
}

export interface AbsorptionPayload {
  family: "absorption";
  price: number;
  side: "bid" | "ask";
  score: number;
  level_id: string | null;
  description: string;
}

export interface SweepPayload {
  family: "sweep";
  price: number;
  direction: "up" | "down";
  ticks_cleared: number;
  level_id: string | null;
  description: string;
}

export interface VolRegimePayload {
  family: "vol_regime";
  regime: Regime;
  sigma: number;
  description: string;
}

/**
 * Inference-derived CVD summary. Rithmic F/T action types are not currently
 * present in the normalized stream (RA-064), so direction is inferred from
 * aggressor/L1 logic rather than exchange-provided truth.
 */
export interface CvdStats {
  session_cvd: number;
  last_60m_cvd: number;
  last_15m_cvd: number;
  session_direction: FlowDirection;
  last_15m_direction: FlowDirection;
  momentum_flip: boolean;
}

export interface AggressorWindowStats {
  window_seconds: number;
  label: string;
  lift_ask: number;
  hit_bid: number;
  net: number;
  ratio: number;
  total_volume: number;
  direction: InferredDirection;
}

export interface VDeltaStats {
  window_seconds: number;
  value: number;
  direction: InferredDirection;
  sign_flip: boolean;
  prior_direction: InferredDirection;
  confirmed_seconds: number;
}

/**
 * Latest footprint summary. `stacked_side` uses trade-side vocabulary
 * (buy/sell/none), distinct from flow-bias vocabulary
 * (bullish/bearish/neutral).
 */
export interface FootprintStats {
  bar_start_ns: number | null;
  bar_end_ns: number | null;
  stacked_side: FootprintSide;
  stacked_count: number;
  stacked_low_price: number | null;
  stacked_high_price: number | null;
}

/**
 * Optional compute-path orderflow context. Fast-path price ticks carry null;
 * the UI retains the latest non-null value for the orderflow panel.
 */
export interface OrderflowStats {
  quality: OrderflowQuality;
  last_trade_aggressor: TradeAggressor;
  last_trade_delta: number | null;
  cvd: CvdStats | null;
  aggressor_windows: AggressorWindowStats[];
  v_delta: VDeltaStats | null;
  footprint: FootprintStats | null;
}

export interface PriceTickPayload {
  family: "price_tick";
  price: number;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  orderflow: OrderflowStats | null;
}

export interface DepthLevel {
  price: number;
  size: number;
}

/**
 * Bounded full depth snapshot for heatmap/DOM rendering. This is a full
 * snapshot, not a diff; n_ticks caps each side independently. bid_levels are
 * descending by price (best/nearest bid first); ask_levels are ascending by
 * price (best/nearest ask first). quality meanings: live = seeded MBO book
 * with fresh bid/ask mid; inferred = seeded book centered from latest trade;
 * stale_l1 = stale price or depth context; unavailable = no usable book or mid.
 */
export interface DepthPayload {
  family: "depth";
  ts_ns: number;
  mid: number | null;
  bid_levels: DepthLevel[];
  ask_levels: DepthLevel[];
  n_ticks: number;
  quality: DepthQuality;
}

export interface ZoneState {
  id: string;
  kind: string;
  price: number;
  label: string | null;
}

/**
 * RA-112e step 4: a σ supply/demand shelf rendered as a filled band on the
 * chart. ``family`` is one of
 *   - ``sigma_v3_vwap_anchor`` (production v3, VWAP-anchored)
 *   - ``sigma_v2_session_value_anchor`` (legacy v2, anchored at VAH/VAL —
 *     subordinate visual per shadow-mode spec)
 */
export interface Shelf {
  family: string;
  name: string;
  low: number;
  high: number;
  tier: number;
  bound_source: string;       // "estimator" | "atr_cap"
  cap_bound: boolean;
  overlaps_vah?: boolean;
  overlaps_val?: boolean;
  nearest_structural_level?: string | null;
  distance_to_structural_level_ticks?: number | null;
}

export interface ZoneUpdatePayload {
  family: "zone_update";
  zones: ZoneState[];
  // RA-112e step 4: empty list = no shelf change in this update.
  shelves?: Shelf[];
}

export interface ScenarioState {
  id: string;
  label: string;
  probability: number | null;
  target_price: number | null;
}

export interface SnapshotPayload {
  family: "snapshot";
  price: number | null;
  sigma: number | null;
  regime: Regime | null;
  zones: ZoneState[];
  recent_signals: SignalPayload[];
  open_scenarios: ScenarioState[];
  // RA-112e step 3: rolling tactical-anchor (60-min VWAP) position vs the
  // full-session value area. Optional so older snapshots still parse.
  auction_vs_value?: AuctionVsValueState | null;
  auction_distance_ticks?: number | null;
  cap_bind_flags?: Record<string, boolean>;
  shelves?: Shelf[];
}

export interface AuctionStatePayload {
  family: "auction_state";
  state: AuctionVsValueState;
  distance_ticks: number;
  prior_state: AuctionVsValueState | null;
  anchor_price: number | null;
  vah: number | null;
  val: number | null;
}

export interface HeartbeatPayload {
  family: "heartbeat";
  server_ts_ns: number;
  last_capture_ts_ns: number | null;
  stale: boolean;
}

export interface ErrorPayload {
  family: "error";
  code: string;
  message: string;
}

/**
 * RA-108: per-source evidence contributing to a level's persistence. Each
 * entry records WHY a level is structural — which upstream detector, how
 * many observations, when the last one fired, cumulative size at price.
 */
export interface PersistentLevelEvidence {
  source: "resting_size" | "iceberg_refill" | "absorption" | "sweep_anchor";
  count: number;
  last_seen_ts_ns: number;
  cumulative_size: number;
}

/**
 * RA-108: session-long structural price level. Unlike RA-107a wall markers
 * (short-window, visible-depth only), persistent levels are session-scoped
 * and remain marked even when price moves far from them.
 *
 * Lifecycle: active → deteriorating → broken (one final emit then silent).
 * Side: bid = floor (buyers defending below mid), ask = ceiling, unknown = rare.
 */
export interface PersistentLevelPayload {
  family: "persistent_level";
  level_id: string;
  price: number;
  side: "bid" | "ask" | "unknown";
  persistence_seconds: number;
  confidence: Confidence;
  evidence: PersistentLevelEvidence[];
  last_active_ts_ns: number;
  status: "active" | "deteriorating" | "broken";
  notes: string | null;
}

/** Catch-all for unknown / future families (RA-050 extensibility). */
export interface GenericPayload {
  family: string;
  [key: string]: unknown;
}

export type RealtimePayload =
  | SignalPayload
  | IcebergPayload
  | AbsorptionPayload
  | SweepPayload
  | VolRegimePayload
  | PriceTickPayload
  | DepthPayload
  | ZoneUpdatePayload
  | SnapshotPayload
  | HeartbeatPayload
  | ErrorPayload
  | PersistentLevelPayload
  | AuctionStatePayload
  | GenericPayload;

// --- Envelope --------------------------------------------------------------

export interface RealtimeMessage {
  type: MessageType;
  seq: number;
  ts_ns: number;
  ts_pt: string;
  tier: Tier | null;
  schema_version: number;
  payload: RealtimePayload;
}

/**
 * Narrow a payload by family. Returns true for known families; unknown
 * families fall through to GenericPayload handling at the call site.
 */
export function isFamily<F extends Family>(
  payload: RealtimePayload,
  family: F,
): boolean {
  return payload.family === family;
}
