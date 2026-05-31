const DECIMAL_NS_PATTERN = /^\d+$/;

export const NANOSECONDS_PER_SECOND = 1_000_000_000n;
export const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

export function parseNsDecimal(value: unknown, path: string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'string' && DECIMAL_NS_PATTERN.test(value)) {
    return BigInt(value);
  }
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return BigInt(value.toFixed(0));
  }
  throw new Error(`${path} must be an unsigned decimal nanosecond timestamp`);
}

export function nsToDecimalString(value: bigint): string {
  return value.toString();
}

export function addNs(value: bigint, deltaNs: bigint): bigint {
  return value + deltaNs;
}

export function secondsToNs(seconds: number): bigint {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(`horizon seconds must be a positive integer, got ${seconds}`);
  }
  return BigInt(seconds) * NANOSECONDS_PER_SECOND;
}

export function cmpNs(left: bigint, right: bigint): -1 | 0 | 1 {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function diffNsToMillis(left: bigint, right: bigint): number {
  const delta = left - right;
  return Number(delta / NANOSECONDS_PER_MILLISECOND);
}
