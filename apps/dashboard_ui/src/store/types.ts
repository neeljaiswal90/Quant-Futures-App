/**
 * Normalized client store shape (RA-061).
 *
 * Single source of truth driven by a useReducer. The chart layer does NOT
 * read price ticks from here (those flow via refs so per-tick updates bypass
 * React re-render) — but the store still tracks the latest tick for the
 * Tier-4 price-context panel and banner-decay math.
 */
import type {
  Regime,
  ScenarioState,
  Tier,
  ZoneState,
} from "@contracts/realtime/events";
import type { CriticalBanner } from "../contract/scenarios";
import type { FeedItem } from "../contract/render";

export type ConnStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface PriceState {
  price: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  /** ts_ns of the last price update (tick or snapshot). */
  tsNs: number | null;
}

export interface HeartbeatState {
  serverTsNs: number | null;
  lastCaptureTsNs: number | null;
  stale: boolean;
  /** Local wall-clock ms when the last frame of ANY kind arrived. */
  lastFrameAtMs: number | null;
}

export interface DashboardState {
  conn: ConnStatus;
  /** Highest envelope seq applied. -1 before the first frame. */
  lastSeq: number;
  /** True once a seq gap is detected and a resync is pending. */
  resyncing: boolean;
  schemaVersion: number | null;

  price: PriceState;
  sigma: number | null;
  regime: Regime | null;

  heartbeat: HeartbeatState;

  zones: ZoneState[];
  scenarios: ScenarioState[];

  /** Rolling event feed, newest-appended (capped at FEED_CAP). */
  feed: FeedItem[];
  /** Collapsed history of all feed-worthy events this session (Tier 5). */
  history: FeedItem[];

  /** Active Tier-1 CRITICAL banner, or null. Decay is computed at render. */
  critical: CriticalBanner | null;

  /** Last error payload received over the wire (if any). */
  lastError: { code: string; message: string } | null;
}

export const FEED_CAP = 10;
export const HISTORY_CAP = 200;

export function initialState(): DashboardState {
  return {
    conn: "connecting",
    lastSeq: -1,
    resyncing: false,
    schemaVersion: null,
    price: { price: null, bid: null, ask: null, volume: null, tsNs: null },
    heartbeat: {
      serverTsNs: null,
      lastCaptureTsNs: null,
      stale: false,
      lastFrameAtMs: null,
    },
    sigma: null,
    regime: null,
    zones: [],
    scenarios: [],
    feed: [],
    history: [],
    critical: null,
    lastError: null,
  };
}

export type StoreAction =
  | { kind: "conn"; status: ConnStatus }
  | { kind: "message"; raw: unknown; nowMs: number }
  | { kind: "resync-start" }
  | { kind: "dismiss-critical" }
  | { kind: "tick-clock"; nowMs: number };

/** Discriminator carried with each tier color for the price ladder. */
export type { Tier };
