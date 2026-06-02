/**
 * Normalized client store shape (RA-061).
 *
 * Single source of truth driven by a useReducer. The chart layer does NOT
 * read price ticks from here (those flow via refs so per-tick updates bypass
 * React re-render) — but the store still tracks the latest tick for the
 * Tier-4 price-context panel and banner-decay math.
 */
import type {
  AuctionVsValueState,
  DepthPayload,
  MbpPulsePayload,
  PersistentLevelPayload,
  Regime,
  OrderflowStats,
  ScenarioState,
  Shelf,
  TacticalStatus,
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

  /**
   * RA-112e step 3: rolling tactical-anchor (60-min VWAP) position vs the
   * full-session value area. Separate state from `regime` (which measures
   * volatility) — they describe different things and render as their own
   * chip in the top bar. `null` until the first frame with envelope.
   */
  auctionVsValue: AuctionVsValueState | null;
  /** Non-negative distance from the nearest value-area boundary, in ticks. */
  auctionDistanceTicks: number | null;

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
  /**
   * RA-112e step 4: σ supply/demand shelves rendered as filled bands on the
   * chart. Carries both ``sigma_v3_vwap_anchor`` (production) and
   * ``sigma_v2_session_value_anchor`` (legacy shadow) families. Refreshed on
   * snapshot + zone_update; empty until the first v3 compute lands.
   */
  shelves: Shelf[];
  /**
   * RA-112e step 5: Globex/RTH tactical split. ``warmup`` = trailing window
   * too short for stable σ (right after RTH open, etc.) — shelves are still
   * rendered but the Trade Posture panel marks them. ``no_data`` = no shelves
   * available this cycle. ``null`` = older snapshot (treat as live for back-
   * compat).
   */
  tacticalStatus: TacticalStatus | null;
  /** Trailing-window span in minutes used by the latest compute. */
  tacticalTapeMinutes: number | null;

  /**
   * RA-112e step 7: live MBP1 pulse. Same fields as the touch logger's
   * pre-touch features; the realtime backend snapshots its rolling
   * accumulator at ~1Hz and broadcasts via MbpPulsePayload. Trade Posture
   * reads OFI/spread/imbalance/microprice from here instead of computing
   * client-side. ``null`` until the first pulse lands.
   */
  mbpPulse: MbpPulsePayload | null;
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
    auctionVsValue: null,
    auctionDistanceTicks: null,
    shelves: [],
    tacticalStatus: null,
    tacticalTapeMinutes: null,
    mbpPulse: null,
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
