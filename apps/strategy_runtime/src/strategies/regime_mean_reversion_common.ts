import type { RegimeMeanReversionStrategyParameters } from '../config/index.js';
import type {
  StrategyFeatureSnapshot,
  StrategyFeatureSnapshotRegime,
} from './types.js';

const NS_PER_MINUTE = 60_000_000_000n;

export function computeSignedShock(
  snapshot: StrategyFeatureSnapshot,
  parameters: RegimeMeanReversionStrategyParameters,
): number | null {
  const reference = computeVwapReference(snapshot, parameters);
  if (reference === null) {
    return null;
  }

  const sigma = getFiniteNumber(snapshot.indicators.sigma_pts);
  if (sigma === null || !(sigma > 0)) {
    return null;
  }

  const price = getFiniteNumber(snapshot.quote.mid_px);
  if (price === null) {
    return null;
  }

  return (price - reference) / sigma;
}

export function computeVwapReference(
  snapshot: StrategyFeatureSnapshot,
  parameters: RegimeMeanReversionStrategyParameters,
): number | null {
  switch (parameters.vwap_reference) {
    case 'session_vwap':
      return computeVolumeWeightedAverage(snapshot.bars);
    case 'opening_window_vwap':
      return computeOpeningWindowVwap(snapshot, parameters.opening_window_minutes);
    case 'prior_day_close':
      return getFiniteNumber(snapshot.context.prior_day_close);
  }
}

export function isTradingRegime(
  regime: StrategyFeatureSnapshotRegime,
): regime is 'high' | 'low' {
  return regime === 'high' || regime === 'low';
}

export function validateRegimeMeanReversionParameters(
  parameters: RegimeMeanReversionStrategyParameters,
): readonly string[] {
  const issues: string[] = [];
  if (parameters.low_shock_threshold_neg <= parameters.high_shock_threshold_neg) {
    issues.push('low_shock_threshold_neg_must_exceed_high_shock_threshold_neg');
  }
  if (parameters.low_shock_threshold_pos <= parameters.high_shock_threshold_pos) {
    issues.push('low_shock_threshold_pos_must_exceed_high_shock_threshold_pos');
  }
  if (parameters.confidence_score_low >= parameters.confidence_score_high) {
    issues.push('confidence_score_low_must_be_less_than_high');
  }
  if (parameters.target_1_rr < parameters.minimum_target_rr) {
    issues.push('target_1_rr_below_minimum_target_rr');
  }
  if (parameters.target_2_rr < parameters.target_1_rr) {
    issues.push('target_2_rr_below_target_1_rr');
  }
  if (!Number.isInteger(parameters.opening_window_minutes) || parameters.opening_window_minutes <= 0) {
    issues.push('opening_window_minutes_invalid');
  }
  return issues;
}

function computeOpeningWindowVwap(
  snapshot: StrategyFeatureSnapshot,
  openingWindowMinutes: number,
): number | null {
  const firstBar = snapshot.bars[0];
  if (firstBar === undefined || !Number.isInteger(openingWindowMinutes) || openingWindowMinutes <= 0) {
    return null;
  }
  const cutoff = firstBar.start_ts_ns + BigInt(openingWindowMinutes) * NS_PER_MINUTE;
  return computeVolumeWeightedAverage(
    snapshot.bars.filter((bar) => bar.start_ts_ns < cutoff),
  );
}

function computeVolumeWeightedAverage(
  bars: StrategyFeatureSnapshot['bars'],
): number | null {
  let notional = 0;
  let volume = 0;
  for (const bar of bars) {
    if (!Number.isFinite(bar.close) || !Number.isFinite(bar.volume) || !(bar.volume > 0)) {
      continue;
    }
    notional += bar.close * bar.volume;
    volume += bar.volume;
  }
  return volume > 0 ? notional / volume : null;
}

function getFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
