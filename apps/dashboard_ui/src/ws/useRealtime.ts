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
import type { RealtimeMessage } from "@contracts/realtime/events";

const DEFAULT_WS_URL = "ws://127.0.0.1:8765/ws";
const DEFAULT_SNAPSHOT_URL = "/snapshot";

export interface LiveTick {
  price: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  tsNs: number;
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
}

export function useRealtime(): RealtimeApi {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  const liveTickRef = useRef<LiveTick | null>(null);
  const snapshotRef = useRef<RealtimeMessage | null>(null);
  const tickEpoch = useRef(0);

  const wsRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByUs = useRef(false);
  const resyncInFlight = useRef(false);

  const wsUrl = import.meta.env.VITE_WS_URL ?? DEFAULT_WS_URL;
  const snapshotUrl = import.meta.env.VITE_SNAPSHOT_URL ?? DEFAULT_SNAPSHOT_URL;

  // Apply a raw frame: into the reducer AND (for ticks/snapshots) into refs.
  const applyFrame = useCallback((raw: unknown) => {
    const msg = parseMessage(raw);
    if (msg) {
      if (isPriceTick(msg.payload)) {
        liveTickRef.current = {
          price: msg.payload.price,
          bid: msg.payload.bid,
          ask: msg.payload.ask,
          volume: msg.payload.volume,
          tsNs: msg.ts_ns,
        };
        tickEpoch.current += 1;
      } else if (isSnapshot(msg.payload)) {
        snapshotRef.current = msg;
        if (msg.payload.price != null) {
          liveTickRef.current = {
            price: msg.payload.price,
            bid: liveTickRef.current?.bid ?? null,
            ask: liveTickRef.current?.ask ?? null,
            volume: liveTickRef.current?.volume ?? null,
            tsNs: msg.ts_ns,
          };
          tickEpoch.current += 1;
        }
      }
    }
    dispatch({ kind: "message", raw, nowMs: Date.now() });
  }, []);

  const resync = useCallback(async () => {
    if (resyncInFlight.current) return;
    resyncInFlight.current = true;
    try {
      const res = await fetch(snapshotUrl, { cache: "no-store" });
      if (!res.ok) return;
      const body: unknown = await res.json();
      applyFrame(body);
    } catch {
      // Resync best-effort; reconnect's re-snapshot is the fallback.
    } finally {
      resyncInFlight.current = false;
    }
  }, [snapshotUrl, applyFrame]);

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
  }, [wsUrl, applyFrame, scheduleReconnect]);

  connectRef.current = connect;

  // Drive resync whenever the reducer flags a seq gap.
  useEffect(() => {
    if (state.resyncing && !resyncInFlight.current) {
      void resync();
    }
  }, [state.resyncing, resync]);

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

  return { state, dispatch, liveTickRef, snapshotRef, tickEpoch };
}
