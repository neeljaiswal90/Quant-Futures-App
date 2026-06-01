/**
 * Realtime connection hook.
 *
 * Owns the WebSocket lifecycle and feeds raw frames into the pure store
 * reducer. Responsibilities:
 *   - connect to VITE_WS_URL (default ws://127.0.0.1:8765/ws)
 *   - reconnect with 500ms-base x2 backoff, 10s cap, +-20% jitter; reset on
 *     a clean open
 *   - on seq gap (derived `resyncing` flag) -> fetch GET /snapshot and apply
 *   - reconnect itself re-snapshots: the server re-emits frame-0 snapshot on
 *     every fresh connection, which rebases lastSeq (WS fallback resync)
 *   - mirror every price_tick into a ref so the chart updates WITHOUT a React
 *     re-render (per-tick series.update() path)
 *
 * The hook is intentionally thin; the testable state machine lives in the
 * reducer + backoff modules.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import { backoffDelayMs } from "./backoff";
import { initialState, reducer } from "../store/reducer";
import { parseMessage } from "../store/reducer";
import type { DashboardState, StoreAction } from "../store/types";
import { isPriceTick, isSnapshot } from "../contract/guards";
import type { OrderflowStats, RealtimeMessage } from "@contracts/realtime/events";
import {
  isBookmapFrame,
  mergeBackfillWithLiveFrames,
  normalizeBookmapBackfill,
  type BookmapBackfillResponse,
} from "../bookmap/backfill";

const DEFAULT_WS_URL = "ws://127.0.0.1:8765/ws";
const DEFAULT_SNAPSHOT_URL = "/snapshot";
const DEFAULT_BOOKMAP_BACKFILL_URL = "/api/bookmap-backfill";

export interface LiveTick {
  source: "price_tick" | "snapshot";
  price: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  orderflow: OrderflowStats | null;
  tsNs: number;
  seq: number;
}

export interface RealtimeApi {
  state: DashboardState;
  dispatch: React.Dispatch<StoreAction>;
  /**
   * Latest price/snapshot tick. Read by the chart imperatively via this ref
   * so per-tick updates never trigger a React render.
   */
  liveTickRef: React.MutableRefObject<LiveTick | null>;
  /** Latest full snapshot message — chart setData() source on resync. */
  snapshotRef: React.MutableRefObject<RealtimeMessage | null>;
  /** Monotonic counter bumped whenever a tick lands (chart effect dep). */
  tickEpoch: React.MutableRefObject<number>;
  /** Latest REST backfill payload for imperative chart hydration. */
  bookmapBackfillRef: React.MutableRefObject<BookmapBackfillResponse | null>;
  /** Monotonic counter bumped whenever a new backfill lands. */
  bookmapBackfillEpoch: React.MutableRefObject<number>;
}

export function useRealtime(): RealtimeApi {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  const liveTickRef = useRef<LiveTick | null>(null);
  const snapshotRef = useRef<RealtimeMessage | null>(null);
  const tickEpoch = useRef(0);
  const bookmapBackfillRef = useRef<BookmapBackfillResponse | null>(null);
  const bookmapBackfillEpoch = useRef(0);

  const wsRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByUs = useRef(false);
  const resyncInFlight = useRef(false);
  const backfillInFlight = useRef(false);
  const backfillPending = useRef(false);
  const backfillLiveFrames = useRef<RealtimeMessage[]>([]);

  const wsUrl = import.meta.env.VITE_WS_URL ?? DEFAULT_WS_URL;
  const snapshotUrl = import.meta.env.VITE_SNAPSHOT_URL ?? DEFAULT_SNAPSHOT_URL;
  const bookmapBackfillUrl =
    import.meta.env.VITE_BOOKMAP_BACKFILL_URL ?? DEFAULT_BOOKMAP_BACKFILL_URL;

  // Apply a raw frame: into the reducer AND (for ticks/snapshots) into refs.
  const applyFrame = useCallback((raw: unknown) => {
    const msg = parseMessage(raw);
    if (msg) {
      if (backfillPending.current && isBookmapFrame(msg)) {
        backfillLiveFrames.current.push(msg);
      }
      if (isPriceTick(msg.payload)) {
        liveTickRef.current = {
          source: "price_tick",
          price: msg.payload.price,
          bid: msg.payload.bid,
          ask: msg.payload.ask,
          volume: msg.payload.volume,
          orderflow: msg.payload.orderflow ?? liveTickRef.current?.orderflow ?? null,
          tsNs: msg.ts_ns,
          seq: msg.seq,
        };
        tickEpoch.current += 1;
      } else if (isSnapshot(msg.payload)) {
        snapshotRef.current = msg;
        if (msg.payload.price != null) {
          liveTickRef.current = {
            source: "snapshot",
            price: msg.payload.price,
            bid: liveTickRef.current?.bid ?? null,
            ask: liveTickRef.current?.ask ?? null,
            volume: liveTickRef.current?.volume ?? null,
            orderflow: liveTickRef.current?.orderflow ?? null,
            tsNs: msg.ts_ns,
            seq: msg.seq,
          };
          tickEpoch.current += 1;
        }
      }
    }
    dispatch({ kind: "message", raw, nowMs: Date.now() });
  }, []);

  const hydrateBookmapBackfill = useCallback(async () => {
    if (backfillInFlight.current) return;
    backfillInFlight.current = true;
    backfillPending.current = true;
    backfillLiveFrames.current = [];
    try {
      const res = await fetch(bookmapBackfillUrl, { cache: "no-store" });
      if (!res.ok) return;
      const raw: unknown = await res.json();
      const normalized = normalizeBookmapBackfill(raw);
      if (!normalized) return;
      bookmapBackfillRef.current = mergeBackfillWithLiveFrames(
        normalized,
        backfillLiveFrames.current,
      );
      bookmapBackfillEpoch.current += 1;
    } catch {
      // Backfill is a reconnect quality upgrade; the live WS path remains primary.
    } finally {
      backfillPending.current = false;
      backfillLiveFrames.current = [];
      backfillInFlight.current = false;
    }
  }, [bookmapBackfillUrl]);

  const resync = useCallback(async () => {
    if (resyncInFlight.current) return;
    resyncInFlight.current = true;
    let applied = false;
    try {
      const res = await fetch(snapshotUrl, { cache: "no-store" });
      if (!res.ok) return;
      const body: unknown = await res.json();
      applyFrame(body);
      void hydrateBookmapBackfill();
      applied = true;
    } catch {
      // Resync best-effort; reconnect's re-snapshot is the fallback.
    } finally {
      resyncInFlight.current = false;
      // On a failed fetch the snapshot never applied, so `resyncing` would stay
      // true forever (no state transition) and wedge future gap-driven resyncs.
      // Clear it explicitly; the next gap bumps resyncEpoch and re-fires.
      if (!applied) dispatch({ kind: "resync-failed" });
    }
  }, [snapshotUrl, applyFrame, hydrateBookmapBackfill]);

  // `connect` and `scheduleReconnect` are mutually recursive. We break the
  // useCallback dependency cycle by routing the recursion through a ref.
  const connectRef = useRef<() => void>(() => {});

  const scheduleReconnect = useCallback(() => {
    dispatch({ kind: "conn", status: "reconnecting" });
    const delay = backoffDelayMs(attemptRef.current);
    attemptRef.current += 1;
    reconnectTimer.current = setTimeout(() => {
      connectRef.current();
    }, delay);
  }, []);

  const connect = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    dispatch({
      kind: "conn",
      status: attemptRef.current === 0 ? "connecting" : "reconnecting",
    });

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      scheduleReconnect();
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      attemptRef.current = 0; // reset backoff on a clean open
      dispatch({ kind: "conn", status: "open" });
      void hydrateBookmapBackfill();
    };

    ws.onmessage = (ev: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      applyFrame(parsed);
    };

    ws.onerror = () => {
      // onclose will follow; nothing to do here.
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (closedByUs.current) return;
      scheduleReconnect();
    };
  }, [wsUrl, applyFrame, hydrateBookmapBackfill, scheduleReconnect]);

  connectRef.current = connect;

  // Drive resync on EVERY seq gap. Keyed on the monotonic resyncEpoch (not the
  // `resyncing` boolean) so a fresh gap always re-fires — even if a prior
  // resync failed and left `resyncing` true (true->true is no transition).
  useEffect(() => {
    if (state.resyncEpoch > 0 && !resyncInFlight.current) {
      void resync();
    }
  }, [state.resyncEpoch, resync]);

  // Connection lifecycle + a 1s clock pulse for staleness/decay re-eval.
  useEffect(() => {
    closedByUs.current = false;
    connect();

    const clock = setInterval(() => {
      dispatch({ kind: "tick-clock", nowMs: Date.now() });
    }, 1000);

    return () => {
      closedByUs.current = true;
      clearInterval(clock);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    state,
    dispatch,
    liveTickRef,
    snapshotRef,
    tickEpoch,
    bookmapBackfillRef,
    bookmapBackfillEpoch,
  };
}
