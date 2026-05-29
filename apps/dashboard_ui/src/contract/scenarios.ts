/**
 * Pure scenario prioritization (Tier 2) and Tier-1 banner decay.
 *
 * Presentation logic only — proximity filtering and decay are client-side
 * display concerns, NOT signal re-derivation (the backend owns signals).
 */
import type { ScenarioState } from "@contracts/realtime/events";

export interface RankedScenario extends ScenarioState {
  /** Absolute distance from current price, or Infinity when unknown. */
  distancePt: number;
}

/**
 * Active scenarios: at most `max` (default 3) whose target lies within
 * `windowPt` (default 100) of the current price, sorted by priority.
 *
 * Priority: higher probability first; ties break by nearer target. Scenarios
 * with no target_price are kept (can't proximity-filter them) but sink below
 * any in-window targeted scenario.
 */
export function rankScenarios(
  scenarios: ScenarioState[],
  currentPrice: number | null,
  opts: { windowPt?: number; max?: number } = {},
): RankedScenario[] {
  const windowPt = opts.windowPt ?? 100;
  const max = opts.max ?? 3;

  const ranked: RankedScenario[] = scenarios.map((s) => ({
    ...s,
    distancePt:
      currentPrice != null && s.target_price != null
        ? Math.abs(s.target_price - currentPrice)
        : Infinity,
  }));

  const inWindow = ranked.filter(
    (s) => s.distancePt === Infinity || s.distancePt <= windowPt,
  );

  inWindow.sort((a, b) => {
    const pa = a.probability ?? -1;
    const pb = b.probability ?? -1;
    if (pb !== pa) return pb - pa;
    return a.distancePt - b.distancePt;
  });

  return inWindow.slice(0, max);
}

// --- Tier-1 CRITICAL banner decay ------------------------------------------

export interface CriticalBanner {
  /** Monotonic id (envelope seq) of the triggering CRITICAL message. */
  seq: number;
  triggerPrice: number;
  description: string;
  /** Wall-clock ms when the banner was raised. */
  raisedAtMs: number;
}

export const DECAY_MOVE_PT = 50;
export const DECAY_AGE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Whether a CRITICAL banner should still be shown given the live price and
 * wall clock. Decays when price has moved > 50pt from the trigger OR the
 * banner is older than 30min. Presentation decay, not signal re-derivation.
 */
export function isBannerActive(
  banner: CriticalBanner,
  currentPrice: number | null,
  nowMs: number,
): boolean {
  if (nowMs - banner.raisedAtMs >= DECAY_AGE_MS) return false;
  if (
    currentPrice != null &&
    Math.abs(currentPrice - banner.triggerPrice) > DECAY_MOVE_PT
  ) {
    return false;
  }
  return true;
}
