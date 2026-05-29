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

export const KNOWN_FAMILIES = [
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

export interface PriceTickPayload {
  family: "price_tick";
  price: number;
  bid: number | null;
  ask: number | null;
  volume: number | null;
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
