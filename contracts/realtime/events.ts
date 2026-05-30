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
] as const;

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
 * snapshot, not a diff; each side is capped by n_ticks.
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

export interface ZoneUpdatePayload {
  family: "zone_update";
  zones: ZoneState[];
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
