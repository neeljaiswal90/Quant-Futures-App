export const DEPTH_N_TICKS_HARD_CAP = 100;

export function clampDepthNTicks(nTicks: number): number {
  if (!Number.isFinite(nTicks)) return 1;
  return Math.max(1, Math.min(DEPTH_N_TICKS_HARD_CAP, Math.floor(nTicks)));
}
