export interface FailureExitBucket {
  t_min: number;
  n: number;
  low_confidence: boolean;
  q20_peak_win: number;
  q80_mae_win: number;
}

export interface FailureExitCurves {
  family: string;
  family_sample_size: number;
  family_low_confidence: boolean;
  min_n_per_bucket: number;
  buckets: FailureExitBucket[];
}

export function queryFailureExitCurve(
  curves: FailureExitCurves,
  tMin: number,
): { q20_peak: number; q80_mae: number } | null {
  const first = curves.buckets[0];
  const last = curves.buckets[curves.buckets.length - 1];
  if (!first || !last) return null;
  if (tMin < first.t_min || tMin > last.t_min) return null;

  for (let index = 0; index < curves.buckets.length - 1; index += 1) {
    const left = curves.buckets[index];
    const right = curves.buckets[index + 1];
    if (!left || !right) continue;
    if (tMin < left.t_min || tMin > right.t_min) continue;
    if (left.low_confidence || right.low_confidence) return null;
    if (tMin === left.t_min) {
      return { q20_peak: left.q20_peak_win, q80_mae: left.q80_mae_win };
    }
    if (tMin === right.t_min) {
      return { q20_peak: right.q20_peak_win, q80_mae: right.q80_mae_win };
    }
    const span = right.t_min - left.t_min;
    if (!(span > 0)) {
      return { q20_peak: left.q20_peak_win, q80_mae: left.q80_mae_win };
    }
    const frac = (tMin - left.t_min) / span;
    return {
      q20_peak: left.q20_peak_win + frac * (right.q20_peak_win - left.q20_peak_win),
      q80_mae: left.q80_mae_win + frac * (right.q80_mae_win - left.q80_mae_win),
    };
  }

  if (last.low_confidence) return null;
  return { q20_peak: last.q20_peak_win, q80_mae: last.q80_mae_win };
}
