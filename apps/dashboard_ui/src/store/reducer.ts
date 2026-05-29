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
  isError,
  isHeartbeat,
  isIceberg,
  isPriceTick,
  isSignal,
  isSnapshot,
  isSweep,
  isVolRegime,
  isZoneUpdate,
} from "../contract/guards";
import { isFeedFamily, mergeZones, messageToFeedItem } from "../contract/render";
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
  nowMs: number,
): DashboardState {
  const p: RealtimePayload = msg.payload;
  let next = state;

  if (isSnapshot(p)) {
    // Full resync frame — replace authoritative state, preserve session
    // history + feed (those are client-accumulated, not in the snapshot).
    next = {
      ...next,
      price: {
        price: p.price,
        bid: next.price.bid,
        ask: next.price.ask,
        volume: next.price.volume,
        tsNs: msg.ts_ns,
      },
      sigma: p.sigma,
      regime: p.regime,
      zones: p.zones,
      scenarios: p.open_scenarios,
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
        tsNs: msg.ts_ns,
      },
    };
    return next;
  }

  if (isVolRegime(p)) {
    next = { ...next, regime: p.regime, sigma: p.sigma };
    // Regime transitions also surface in the feed.
  }

  if (isZoneUpdate(p)) {
    next = { ...next, zones: mergeZones(next.zones, p.zones) };
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

  // Tier-1 CRITICAL banner: any CRITICAL-tier signal raises a banner anchored
  // to the current price. We do not re-derive — the backend decided CRITICAL.
  if (msg.tier === "CRITICAL" && isSignal(p)) {
    const triggerPrice = next.price.price ?? 0;
    next = {
      ...next,
      critical: {
        seq: msg.seq,
        triggerPrice,
        description: p.description || p.event_type,
        raisedAtMs: nowMs,
      },
    };
  }

  // Feed + history accumulation for the discrete event families.
  if (
    isFeedFamily(p.family) &&
    (isSignal(p) || isSweep(p) || isIceberg(p) || isAbsorption(p) || isVolRegime(p))
  ) {
    const item = messageToFeedItem(msg);
    const feed = [...next.feed, item].slice(-FEED_CAP);
    const history = [...next.history, item].slice(-HISTORY_CAP);
    next = { ...next, feed, history };
  }

  return next;
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
