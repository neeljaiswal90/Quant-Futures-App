import type { MaybeAvailable, UnixNsString } from '@quant-futures/operator-console-contracts';

export function formatMaybeNumber(
  value: MaybeAvailable<number>,
  options: {
    readonly unit?: string;
    readonly currency?: boolean;
    readonly fractionDigits?: number;
  } = {},
): string {
  if (value.status === 'unavailable') {
    return 'unavailable';
  }

  if (options.currency === true) {
    return new Intl.NumberFormat('en-US', {
      currency: 'USD',
      maximumFractionDigits: options.fractionDigits ?? 2,
      minimumFractionDigits: options.fractionDigits ?? 2,
      style: 'currency',
    }).format(value.value);
  }

  const formatted = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: options.fractionDigits ?? 0,
  }).format(value.value);
  return options.unit === undefined ? formatted : `${formatted} ${options.unit}`;
}

export function formatMaybeText(value: MaybeAvailable<string>): string {
  return value.status === 'unavailable' ? 'unavailable' : value.value;
}

export function formatNsTimestamp(value: UnixNsString | null): string {
  if (value === null) {
    return 'unavailable';
  }

  try {
    const ms = Number(BigInt(value) / 1_000_000n);
    if (!Number.isSafeInteger(ms)) {
      return value;
    }
    return new Date(ms).toISOString();
  } catch {
    return value;
  }
}

export function compactId(value: string | null): string {
  if (value === null || value.length === 0) {
    return 'unavailable';
  }
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

export function titleCaseValue(value: string): string {
  return value.replaceAll('_', ' ');
}
