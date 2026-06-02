/**
 * Derived view-state selectors (pure).
 *
 * Degraded detection, banner activity, scenario ranking, and feed ordering
 * are computed from the store + the current wall clock. Kept pure so the
 * degraded/empty/reconnect logic is testable without React.
 */
import type { DashboardState } from "./types";
import { isBannerActive, rankScenarios } from "../contract/scenarios";
import { sortFeed } from "../contract/render";

/**
 * No frame within this window => degraded (stale link).
 *
 * Operator-tuned 2026-06-02: was 10s. The backend emits heartbeats every 5s,
 * so 10s meant a single skipped beat (network jitter, GC pause, brief compute
 * spike) painted the banner. 25s requires ~5 missed beats before raising
 * the alarm — same coverage for a real outage, far fewer false alarms.
 */
export const FRAME_STALE_MS = 25_000;

/**
 * Degraded when the server flagged heartbeat.stale OR no frame of any kind
 * has arrived in > FRAME_STALE_MS. Before the first frame we are
 * "connecting", not degraded.
 */
export function isDegraded(state: DashboardState, nowMs: number): boolean {
  if (state.heartbeat.stale) return true;
  const last = state.heartbeat.lastFrameAtMs;
  if (last == null) return false;
  return nowMs - last > FRAME_STALE_MS;
}

/** True before any data has been applied (empty state). */
export function isEmpty(state: DashboardState): boolean {
  return state.lastSeq < 0 && state.price.price == null;
}

export function activeCritical(state: DashboardState, nowMs: number) {
  if (!state.critical) return null;
  return isBannerActive(state.critical, state.price.price, nowMs)
    ? state.critical
    : null;
}

export function activeScenarios(state: DashboardState) {
  return rankScenarios(state.scenarios, state.price.price, {
    windowPt: 100,
    max: 3,
  });
}

export function orderedFeed(state: DashboardState) {
  return sortFeed(state.feed);
}
