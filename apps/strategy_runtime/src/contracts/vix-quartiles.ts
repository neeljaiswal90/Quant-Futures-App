import type { VixQuartile, VixQuartileBoundaries, VixSeries } from './vix-series.js';

/**
 * Computes deterministic nearest-rank quartile boundaries from non-null VIX observations.
 * Null observations are FRED holiday/missing values and are excluded while still counted.
 */
export function computeVixQuartileBoundaries(series: VixSeries): VixQuartileBoundaries {
  const values = series.observations
    .flatMap((observation) => (observation.value === null ? [] : [observation.value]))
    .sort((left, right) => left - right);

  if (values.length === 0) {
    throw new Error('Cannot compute VIX quartile boundaries: no non-null observations');
  }

  return {
    q1_high: nearestRankHigh(values, 0.25),
    q2_high: nearestRankHigh(values, 0.5),
    q3_high: nearestRankHigh(values, 0.75),
    sample_count: values.length,
    excluded_null_count: series.observations.length - values.length,
  };
}

/** Assigns a numeric VIX value to a deterministic quartile bucket. */
export function bucketByVixQuartile(value: number, boundaries: VixQuartileBoundaries): VixQuartile {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot bucket non-finite VIX value: ${value}`);
  }

  if (value <= boundaries.q1_high) {
    return 'Q1_low';
  }
  if (value <= boundaries.q2_high) {
    return 'Q2';
  }
  if (value <= boundaries.q3_high) {
    return 'Q3';
  }
  return 'Q4_high';
}

/** Looks up the VIX close for a YYYY-MM-DD date, returning null when absent or null in FRED. */
export function lookupVixOnDate(series: VixSeries, date: string): number | null {
  return series.observations.find((observation) => observation.date === date)?.value ?? null;
}

function nearestRankHigh(values: readonly number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(values.length * fraction) - 1);
  const value = values[index];
  if (value === undefined) {
    throw new Error('Cannot compute VIX quartile boundary from an empty sample');
  }
  return value;
}
