/**
 * React context wrapping the single realtime store + connection.
 *
 * One `useRealtime()` instance lives at the provider; it exposes a STABLE api
 * value (the external store + dispatch + imperative refs). Components read
 * state through selector hooks:
 *
 *   - `useDashboardSelector(s => s.slice)` — re-renders only when the selected
 *     slice changes identity (the common, performant path).
 *   - `useDashboardState()` — subscribes to the whole state (back-compat for
 *     components that legitimately depend on many slices, e.g. the DOM ladder).
 *   - `useDashboard()` — the raw api (refs + dispatch + store). Used by the
 *     chart, which pulls liveTickRef/snapshotRef so per-tick updates bypass
 *     React state entirely.
 *
 * Selectors MUST return a stable reference for unchanged state (a slice object
 * or a primitive). The reducer preserves slice identity for untouched slices,
 * so `s => s.feed` is stable across price ticks. Do NOT return a freshly built
 * object/array from a selector — `useSyncExternalStore` would then re-render
 * on every notification.
 */
/* eslint-disable react-refresh/only-export-components --
   Provider component + its consumer hooks are intentionally colocated; this is
   a context module, not a fast-refreshable component file. */
import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useRealtime, type RealtimeApi } from "../ws/useRealtime";
import type { DashboardState } from "./types";

const DashboardContext = createContext<RealtimeApi | null>(null);

export function DashboardProvider({ children }: { children: ReactNode }) {
  const api = useRealtime();
  return (
    <DashboardContext.Provider value={api}>
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard(): RealtimeApi {
  const ctx = useContext(DashboardContext);
  if (!ctx) {
    throw new Error("useDashboard must be used within <DashboardProvider>");
  }
  return ctx;
}

/**
 * Subscribe to a slice of dashboard state. Re-renders the calling component
 * only when `selector(state)` changes by `Object.is`. The selector should
 * return a slice reference or primitive (see module note on stability).
 */
export function useDashboardSelector<T>(
  selector: (state: DashboardState) => T,
): T {
  const { store } = useDashboard();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
  );
}

/**
 * Subscribe to the whole dashboard state. Re-renders on every state change —
 * use only where a component genuinely depends on many slices. Prefer
 * `useDashboardSelector` for everything else.
 */
export function useDashboardState(): DashboardState {
  const { store } = useDashboard();
  return useSyncExternalStore(store.subscribe, store.getState);
}
