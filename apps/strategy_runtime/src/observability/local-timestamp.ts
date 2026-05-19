import { ns, type UnixNs } from '../contracts/time.js';

const NS_PER_MS = 1_000_000n;

const wallClockAnchorNs = BigInt(Date.now()) * NS_PER_MS;
const monotonicAnchorNs = process.hrtime.bigint();

/**
 * Capture a local Unix nanosecond timestamp using a monotonic clock delta
 * anchored to wall-clock time at module load.
 */
export function captureLocalTimestampNs(): UnixNs {
  return ns(wallClockAnchorNs + (process.hrtime.bigint() - monotonicAnchorNs));
}
