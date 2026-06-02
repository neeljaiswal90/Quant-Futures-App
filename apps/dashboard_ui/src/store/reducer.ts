/**
 * Store reducer — the realtime state machine core.
 *
 * Pure and synchronous: every wire frame, connection transition, and clock
 * tick flows through here. The WS hook is a thin shell that feeds raw frames
 * in and reacts to the derived `resyncing` flag. Keeping the machine pure is
 * what makes the reconnect / backoff / seq-gap behavior unit-testable without
 * a socket or canvas.
 *
 * HARD RULE: backend owns signal logic. This reducer normalizes and routes
 * contract payloads for display; it never re-derives a signal.
 */
import type { RealtimeMessage, RealtimePayload } from "@contracts/realtime/events";
import {
  isAbsorption,
  isAuctionState,
  isDepth,
  isError,
  isHeartbeat,
  isIceberg,
  isMbpPulse,
  isPersistentLevel,
  isPriceTick,
  isSignal,
  isSnapshot,
  isSweep,
  isVolRegime,
  isZoneUpdate,
} from "../contract/guards";
import {
  isFeedFamily,
  mergeZones,
  messageToFeedItem,
  snapshotSignalToFeedItem,
  type FeedItem,
} from "../contract/render";
import {
  type DashboardState,
  FEED_CAP,
  HISTORY_CAP,
  initialState,
  type StoreAction,
} from "./types";

/**
 * Best-effort structural validation of a wire frame. We do NOT reject unknown
 * payload families (RA-050 extensibility) — only frames that are not shaped
 * like an envelope at all. Returns null on a malformed frame.
 */
export function parseMessage(raw: unknown): RealtimeMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.type !== "string") return null;
  if (typeof o.seq !== "number") return null;
  if (typeof o.ts_ns !== "number") return null;
  if (typeof o.payload !== "object" || o.payload === null) return null;
  const payload = o.payload as Record<string, unknown>;
  if (typeof payload.family !== "string") return null;
  return raw as RealtimeMessage;
}

function applyPayload(
  state: DashboardState,
  msg: RealtimeMessage,
  _nowMs: number,
): DashboardState {
  const p: RealtimePayload = msg.payload;
  let next = state;

  if (isSnapshot(p)) {
    const snapshotFeed = p.recent_signals.map((signal, index) =>
      snapshotSignalToFeedItem(signal, msg.seq, msg.ts_ns, index),
    );
    // Full resync frame — replace authoritative state, preserve session
    // history + feed while hydrating any snapshot recent_signals idempotently.
    next = {
      ...next,
      price: {
        price: p.price,
        bid: next.price.bid,
        ask: next.price.ask,
        volume: next.price.volume,
        orderflow: next.price.orderflow,
        tsNs: msg.ts_ns,
      },
      sigma: p.sigma,
      regime: p.regime,
      // RA-112e step 3: snapshot carries the chip state for cold-start. Older
      // snapshots without the field leave it null (renders no chip).
      auctionVsValue: p.auction_vs_value ?? null,
      auctionDistanceTicks: p.auction_distance_ticks ?? null,
      // RA-112e step 4c: shelves from the v3 compute. Empty until v3 runs.
      shelves: p.shelves ?? [],
      // RA-112e step 5: tactical status. null when older snapshot ships no
      // field; UI treats null as "live" for back-compat.
      tacticalStatus: p.tactical_status ?? null,
      tacticalTapeMinutes: p.tactical_tape_minutes ?? null,
      zones: p.zones,
      scenarios: p.open_scenarios,
      feed: mergeFeedItems(next.feed, snapshotFeed, FEED_CAP),
      history: mergeFeedItems(next.history, snapshotFeed, HISTORY_CAP),
      resyncing: false,
    };
    return next;
  }

  if (isPriceTick(p)) {
    next = {
      ...next,
      price: {
        price: p.price,
        bid: p.bid,
        ask: p.ask,
        volume: p.volume,
        orderflow: p.orderflow ?? next.price.orderflow,
        tsNs: msg.ts_ns,
      },
    };
    return next;
  }

  if (isDepth(p)) {
    // Depth is chart state, not a feed-worthy event. The heatmap primitive
    // retains the time-series history so React only stores the latest snapshot.
    return { ...next, depth: p };
  }

  if (isVolRegime(p)) {
    next = { ...next, regime: p.regime, sigma: p.sigma };
    // Regime transitions also surface in the feed.
  }

  if (isZoneUpdate(p)) {
    // RA-112e step 4c: a zone_update may also carry refreshed shelves. An
    // empty / omitted shelves array means "no shelf change in this update"
    // — keep what we have. A non-empty list fully replaces the in-memory
    // set (snapshot-style, since v3 always produces the full 10 shelves).
    const shelves =
      p.shelves != null && p.shelves.length > 0 ? p.shelves : next.shelves;
    next = { ...next, zones: mergeZones(next.zones, p.zones), shelves };
    return next;
  }

  if (isHeartbeat(p)) {
    // Heartbeat staleness is tracked separately in the message handler.
    return next;
  }

  if (isError(p)) {
    next = { ...next, lastError: { code: p.code, message: p.message } };
    return next;
  }

  // RA-112e step 3: auction-vs-value transition event. Updates the chip
  // state between snapshot refreshes; the snapshot path seeds the same
  // fields on cold start.
  if (isAuctionState(p)) {
    next = {
      ...next,
      auctionVsValue: p.state,
      auctionDistanceTicks: p.distance_ticks,
    };
    return next;
  }

  // RA-112e step 7: live MBP1 pulse — replace the slice wholesale so a
  // stale pulse never lingers if a field went from non-null to null.
  if (isMbpPulse(p)) {
    next = { ...next, mbpPulse: p };
    return next;
  }

  // RA-108: persistent-level payloads update the persistentLevels map keyed
  // by level_id. The chart manager reads from this map on each render and
  // applies its own diff to add/update/remove price lines.
  if (isPersistentLevel(p)) {
    const persistentLevels = { ...next.persistentLevels, [p.level_id]: p };
    next = { ...next, persistentLevels };
    // Fall through: persistent_level is also a feed family so the operator
    // sees the LVL chip in the LiveFeed when a level is promoted / transitions.
  }

  // Feed + history accumulation for the discrete event families.
  if (
    isFeedFamily(p.family) &&
    (isSignal(p) ||
      isSweep(p) ||
      isIceberg(p) ||
      isAbsorption(p) ||
      isVolRegime(p) ||
      isPersistentLevel(p))
  ) {
    const item = messageToFeedItem(msg);
    const feed = [...next.feed, item].slice(-FEED_CAP);
    const history = [...next.history, item].slice(-HISTORY_CAP);
    next = { ...next, feed, history };
  }

  return next;
}

function feedDedupeKey(item: FeedItem): string {
  return item.eventKey ?? `${item.family}|${item.tsNs}|${item.text}`;
}

function mergeFeedItems(existing: FeedItem[], incoming: FeedItem[], cap: number): FeedItem[] {
  const byKey = new Map<string, FeedItem>();
  for (const item of existing) byKey.set(feedDedupeKey(item), item);
  for (const item of incoming) byKey.set(feedDedupeKey(item), item);
  return [...byKey.values()].sort((a, b) => a.tsNs - b.tsNs).slice(-cap);
}

export function reducer(
  state: DashboardState,
  action: StoreAction,
): DashboardState {
  switch (action.kind) {
    case "conn": {
      // A fresh "connecting"/"open" after a drop resets the seq baseline so
      // the re-emitted snapshot is accepted without a phantom gap.
      if (action.status === "open") {
        return { ...state, conn: "open" };
      }
      if (action.status === "connecting" || action.status === "reconnecting") {
        return { ...state, conn: action.status, lastSeq: -1 };
      }
      return { ...state, conn: action.status };
    }

    case "resync-failed":
      // A resync attempt concluded without a snapshot (fetch failed / bad
      // body). Clear the pending flag so the UI is not wedged "resyncing"
      // forever; the next gap bumps resyncEpoch and re-fires, and a reconnect
      // re-snapshots as the ultimate fallback.
      return { ...state, resyncing: false };

    case "dismiss-critical":
      return { ...state, critical: null };

    case "raise-critical":
      return { ...state, critical: action.critical };

    case "tick-clock":
      // Pure clock pulse — used to re-evaluate staleness / decay at render.
      // The frame-age staleness (>10s no frame) is derived in selectors.
      return state;

    case "message": {
      const msg = parseMessage(action.raw);
      if (!msg) return state;

      const nowMs = action.nowMs;

      // --- seq-gap detection -------------------------------------------
      // The snapshot frame (re)bases the sequence; accept it unconditionally.
      const isSnap = isSnapshot(msg.payload);
      const expected = state.lastSeq + 1;
      const gap =
        !isSnap && state.lastSeq >= 0 && msg.seq > expected;

      // Out-of-order / duplicate (seq <= lastSeq) and not a snapshot: ignore
      // but do not regress lastSeq.
      if (!isSnap && state.lastSeq >= 0 && msg.seq <= state.lastSeq) {
        return state;
      }

      let next = applyPayload(state, msg, nowMs);

      // Every frame refreshes liveness; heartbeat carries explicit staleness.
      const hb = isHeartbeat(msg.payload)
        ? {
            serverTsNs: msg.payload.server_ts_ns,
            lastCaptureTsNs: msg.payload.last_capture_ts_ns,
            stale: msg.payload.stale,
            lastFrameAtMs: nowMs,
          }
        : { ...next.heartbeat, lastFrameAtMs: nowMs };
      next = { ...next, heartbeat: hb };

      next.lastSeq = isSnap ? msg.seq : Math.max(state.lastSeq, msg.seq);
      next.schemaVersion = msg.schema_version ?? next.schemaVersion;

      if (gap) {
        // Mark resync pending + bump the monotonic epoch the hook keys on, so
        // each gap re-fires a resync even if a prior one failed (no false->true
        // transition needed). We still applied this frame's payload so the UI
        // is not frozen while resync lands.
        next = { ...next, resyncing: true, resyncEpoch: state.resyncEpoch + 1 };
      }

      return next;
    }

    default:
      return state;
  }
}

export { initialState };
