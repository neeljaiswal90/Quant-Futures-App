/**
 * Reconnect backoff schedule (pure).
 *
 * 500ms base, x2 per attempt, capped at 10s, with +-20% jitter. The jitter
 * source is injectable so tests are deterministic. Attempt counter resets on
 * a clean open (handled by the connection hook).
 */
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 10_000;
export const BACKOFF_JITTER = 0.2;

/**
 * Delay before reconnect attempt `attempt` (0-based: the first retry is
 * attempt 0). `rand` returns [0,1); default Math.random.
 */
export function backoffDelayMs(
  attempt: number,
  rand: () => number = Math.random,
): number {
  const exp = BACKOFF_BASE_MS * 2 ** Math.max(0, attempt);
  const capped = Math.min(exp, BACKOFF_CAP_MS);
  // +-20% jitter: scale by [0.8, 1.2).
  const factor = 1 + (rand() * 2 - 1) * BACKOFF_JITTER;
  return Math.round(capped * factor);
}

/** The deterministic (un-jittered) base delay for an attempt — for asserting bounds. */
export function backoffBaseMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt), BACKOFF_CAP_MS);
}
