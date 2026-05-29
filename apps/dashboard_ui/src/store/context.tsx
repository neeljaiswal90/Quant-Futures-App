/**
 * React context wrapping the single realtime store + connection.
 *
 * One `useRealtime()` instance lives at the provider; every tier reads from
 * it via `useDashboard()`. The chart pulls refs (liveTickRef / snapshotRef)
 * from the same value so per-tick updates bypass React state.
 */
/* eslint-disable react-refresh/only-export-components --
   Provider component + its consumer hook are intentionally colocated; this is
   a context module, not a fast-refreshable component file. */
import { createContext, useContext, type ReactNode } from "react";
import { useRealtime, type RealtimeApi } from "../ws/useRealtime";

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
