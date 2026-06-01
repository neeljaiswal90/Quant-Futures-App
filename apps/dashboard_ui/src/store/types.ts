/**
 * Normalized client store shape (RA-061).
 *
 * Single source of truth driven by a useReducer. The chart layer does NOT
 * read price ticks from here (those flow via refs so per-tick updates bypass
 * React re-render) — but the store still tracks the latest tick for the
 * Tier-4 price-context panel and banner-decay math.
 */
import type {
  DepthPayload,
  PersistentLevelPayload,
  Regime,
  OrderflowStats,
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
  /** Latest non-null compute-path orderflow context retained across fast ticks. */
  orderflow: OrderflowStats | null;
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
  /**
   * Monotonic counter bumped on EVERY detected seq gap. The WS hook keys its
   * resync effect on this (not `resyncing`) so repeated gaps always re-fire a
   * resync — even after a prior resync failed and left no state transition.
   */
  resyncEpoch: number;
  schemaVersion: number | null;

  price: PriceState;
  sigma: number | null;
  regime: Regime | null;

  heartbeat: HeartbeatState;

  /** Latest bounded depth snapshot; chart primitive owns retained history. */
  depth: DepthPayload | null;

  /**
   * RA-108: session-long persistent levels keyed by level_id. The backend
   * emits one PersistentLevelPayload per state change (promotion or status
   * transition). The reducer keeps the latest payload per level so the
   * chart manager can re-render the current set on each store update.
   * Levels with status="broken" stay in the map briefly so the chart layer
   * can run the fade-out animation, then a follow-up reducer call drops
   * them. v1: broken levels stay until the next session reset.
   */
  persistentLevels: Record<string, PersistentLevelPayload>;

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
export const HISTORY_CAP = 5_000;

export function initialState(): DashboardState {
  return {
    conn: "connecting",
    lastSeq: -1,
    resyncing: false,
    resyncEpoch: 0,
    schemaVersion: null,
    price: {
      price: null,
      bid: null,
      ask: null,
      volume: null,
      orderflow: null,
      tsNs: null,
    },
    heartbeat: {
      serverTsNs: null,
      lastCaptureTsNs: null,
      stale: false,
      lastFrameAtMs: null,
    },
    depth: null,
    persistentLevels: {},
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
  | { kind: "raise-critical"; critical: CriticalBanner }
  | { kind: "resync-failed" }
  | { kind: "dismiss-critical" }
  | { kind: "tick-clock"; nowMs: number };

/** Discriminator carried with each tier color for the price ladder. */
export type { Tier };
