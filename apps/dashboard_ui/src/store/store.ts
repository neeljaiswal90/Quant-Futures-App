/**
 * RA-112 (Phase A): external store backing selector-scoped subscriptions.
 *
 * Replaces the single `useReducer` whose state object — recreated on every
 * dispatch — was carried through one React context value. That made the
 * context identity change on EVERY WebSocket frame, so every `useDashboard()`
 * consumer re-rendered at the full frame rate (10-50 Hz) even when its slice
 * was untouched.
 *
 * This store holds the reducer state outside React and notifies subscribers
 * only when the reducer returns a NEW reference. Combined with
 * `useDashboardSelector` (a `useSyncExternalStore` wrapper), a component
 * re-renders only when the specific slice it selects changes identity. The
 * reducer already preserves slice references for untouched slices (a price
 * tick replaces only `state.price`), so this is a drop-in granularity upgrade
 * with no reducer changes.
 *
 * Note: `tick-clock` and out-of-order frames return the SAME state reference;
 * the store deliberately skips notifying in that case, mirroring React's
 * `useReducer` bail-out so behavior is unchanged.
 */
import { initialState, reducer } from "./reducer";
import type { DashboardState, StoreAction } from "./types";

export interface DashboardStore {
  /** Current state snapshot. Stable reference until a mutating dispatch. */
  getState(): DashboardState;
  /** Run an action through the reducer; notify subscribers iff state changed. */
  dispatch(action: StoreAction): void;
  /** Subscribe to state changes. Returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void;
}

export function createDashboardStore(
  init: () => DashboardState = initialState,
): DashboardStore {
  let state = init();
  const listeners = new Set<() => void>();

  const getState = (): DashboardState => state;

  const dispatch = (action: StoreAction): void => {
    const next = reducer(state, action);
    // Preserve the useReducer bail-out: a same-reference result (e.g.
    // tick-clock, duplicate/out-of-order frame) is a no-op — do not notify.
    if (next === state) return;
    state = next;
    // Copy listeners so an unsubscribe during notification can't skip a peer.
    for (const listener of [...listeners]) listener();
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { getState, dispatch, subscribe };
}
