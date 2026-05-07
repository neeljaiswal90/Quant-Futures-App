import type { AlignedOfiBucket, OfiBucket, OfiSeriesStats } from './types.js';

export function alignOfiBuckets(
  reference: readonly OfiBucket[],
  synthesized: readonly OfiBucket[],
): readonly AlignedOfiBucket[] {
  const synthesizedByStart = new Map(
    synthesized.map((bucket) => [bucket.bucket_start_ts_ns.toString(), bucket]),
  );
  return reference
    .filter((bucket) => synthesizedByStart.has(bucket.bucket_start_ts_ns.toString()))
    .map((bucket) => {
      const matched = synthesizedByStart.get(bucket.bucket_start_ts_ns.toString())!;
      return Object.freeze({
        bucket_start_ts_ns: bucket.bucket_start_ts_ns,
        reference_ofi: bucket.ofi,
        synthesized_ofi: matched.ofi,
      });
    });
}

export function computeOfiSeriesStats(values: readonly bigint[]): OfiSeriesStats | null {
  if (values.length === 0) {
    return null;
  }
  const numericValues = values.map(bigintToFiniteNumber);
  const mean = numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length;
  const variance =
    numericValues.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / numericValues.length;
  return {
    mean,
    std: Math.sqrt(variance),
  };
}

export function zscore(values: readonly bigint[], stats: OfiSeriesStats): readonly number[] {
  return values.map((value) => (bigintToFiniteNumber(value) - stats.mean) / stats.std);
}

export function pearsonFromZscores(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length !== right.length || left.length === 0) {
    throw new Error('z-score arrays must be non-empty and equal length');
  }
  return left.reduce((sum, value, index) => sum + value * right[index]!, 0) / left.length;
}

export function pearsonToPpm(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error('pearson correlation must be finite');
  }
  const tolerance = 1e-9;
  const clamped = value > 1 && value <= 1 + tolerance
    ? 1
    : value < -1 && value >= -1 - tolerance
      ? -1
      : value;
  if (clamped < -1 || clamped > 1) {
    throw new Error('pearson correlation is outside [-1, 1]');
  }
  const ppm = Math.round(clamped * 1_000_000);
  if (!Number.isSafeInteger(ppm) || ppm < -1_000_000 || ppm > 1_000_000) {
    throw new Error('pearson ppm is outside [-1_000_000, 1_000_000]');
  }
  return ppm;
}

function bigintToFiniteNumber(value: bigint): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error('OFI value cannot be represented as a finite number');
  }
  return numeric;
}
