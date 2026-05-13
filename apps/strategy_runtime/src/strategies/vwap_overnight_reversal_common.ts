import type { VwapOvernightReversalStrategyParameters } from '../config/index.js';
import type { PriceTarget } from '../contracts/index.js';
import type {
  SignedShockAnchorType,
  StrategyFeatureSnapshot,
  StrategyFeatureSnapshotRegime,
} from './types.js';

export type VwapOvernightDirection = 'long' | 'short';

export function isVwapOvernightTradingRegime(
  regime: StrategyFeatureSnapshotRegime,
): regime is 'high' | 'low' {
  return regime === 'high' || regime === 'low';
}

export function validateVwapOvernightReversalParameters(
  parameters: VwapOvernightReversalStrategyParameters,
): readonly string[] {
  const issues: string[] = [];
  if (parameters.low_regime_z_entry_sigma <= parameters.high_regime_z_entry_sigma) {
    issues.push('low_regime_z_entry_sigma_must_exceed_high_regime_z_entry_sigma');
  }
  if (!Number.isInteger(parameters.exclude_first_minutes) || parameters.exclude_first_minutes < 0) {
    issues.push('exclude_first_minutes_invalid');
  }
  if (!Number.isInteger(parameters.time_stop_minutes) || parameters.time_stop_minutes <= 0) {
    issues.push('time_stop_minutes_invalid');
  }
  if (parameters.confidence_score > 1) {
    issues.push('confidence_score_must_be_lte_one');
  }
  if (parameters.target_1_anchor !== 'vwap_touch') {
    issues.push('target_1_anchor_must_be_vwap_touch');
  }
  return issues;
}

export function selectVwapSignedShockValue(
  snapshot: StrategyFeatureSnapshot,
  anchorType: SignedShockAnchorType = 'vwap',
): number | null {
  if (anchorType !== 'vwap') {
    return null;
  }
  return finiteOrNull(snapshot.context.signed_shock_vwap.value);
}

export function thresholdForRegime(
  regime: 'high' | 'low',
  parameters: VwapOvernightReversalStrategyParameters,
): number {
  return regime === 'high'
    ? parameters.high_regime_z_entry_sigma
    : parameters.low_regime_z_entry_sigma;
}

export function getAtr14Pts(snapshot: StrategyFeatureSnapshot): number | null {
  const value = snapshot.indicators.atr_14_pts;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function buildVwapOvernightReversalTargets(input: {
  readonly direction: VwapOvernightDirection;
  readonly entryPrice: number;
  readonly riskPts: number;
  readonly sessionVwap: number | null;
  readonly parameters: VwapOvernightReversalStrategyParameters;
  readonly tickSize: number;
}): readonly PriceTarget[] | null {
  const vwap = finiteOrNull(input.sessionVwap);
  if (vwap === null) {
    return null;
  }
  const pt1 = roundToTickVwapOvernight(vwap, input.tickSize);
  const sign = input.direction === 'long' ? 1 : -1;
  if (sign * (pt1 - input.entryPrice) <= 0) {
    return null;
  }
  const pt2 = roundToTickVwapOvernight(pt1 + sign * input.parameters.target_2_rr * input.riskPts, input.tickSize);
  if (sign * (pt2 - pt1) <= 0) {
    return null;
  }
  return [
    {
      label: 'pt1',
      price: pt1,
      quantity_fraction: 0.5,
    },
    {
      label: 'pt2',
      price: pt2,
      quantity_fraction: 0.5,
    },
  ];
}

export function rewardRiskVwapOvernight(
  targetPrice: number,
  entryPrice: number,
  riskPts: number,
  direction: VwapOvernightDirection,
): number {
  if (!(riskPts > 0)) {
    return 0;
  }
  const rewardPts = direction === 'long'
    ? targetPrice - entryPrice
    : entryPrice - targetPrice;
  return round4VwapOvernight(rewardPts / riskPts);
}

export function roundToTickVwapOvernight(value: number, tickSize: number): number {
  return round4VwapOvernight(Math.round(value / tickSize) * tickSize);
}

export function round4VwapOvernight(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
