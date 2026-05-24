import { describe, expect, it } from 'vitest';

import {
  generateRegimeShockReversionShortV3,
  type SignedShockAnchorType,
  type StrategyFeatureSnapshot,
  type StrategyFeatureSnapshotRegime,
} from '../../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../../fixtures/strategies/synthetic-feature-snapshots.js';

describe('regime_shock_reversion_short_v3: sizing uniformity across anchor and VIX arming buckets', () => {
  const regimes = ['low', 'mid', 'high'] as const;
  const signedShockCells = [-3, -1.5, 0, 1.5, 3] as const;
  const anchorTypes = ['vwap', 'prior_close'] as const;
  const vixPercentiles = [0.25, 0.66, 0.85, 0.92] as const;

  for (const regime of regimes) {
    for (const shock of signedShockCells) {
      for (const anchorType of anchorTypes) {
        for (const vixPercentile of vixPercentiles) {
          it(
            `keeps risk sizing stable when candidate fires (regime=${regime}, shock=${shock}, anchor=${anchorType}, vix=${vixPercentile})`,
            () => {
              const baseline = generateRegimeShockReversionShortV3({
                strategy_id: 'regime_shock_reversion_short_v3',
                snapshot: withRegimeShockAnchorAndVix('high', 3, 'vwap', 0.92),
              }).candidate;
              const result = generateRegimeShockReversionShortV3({
                strategy_id: 'regime_shock_reversion_short_v3',
                snapshot: withRegimeShockAnchorAndVix(regime, shock, anchorType, vixPercentile),
              });

              if (result.candidate !== undefined) {
                expect(baseline).toBeDefined();
                expect(result.candidate.risk_points).toBeCloseTo(baseline!.risk_points, 4);
                expect(result.candidate.targets.map((target) => target.quantity_fraction))
                  .toEqual(baseline!.targets.map((target) => target.quantity_fraction));
              }
            },
          );
        }
      }
    }
  }
});

function withRegimeShockAnchorAndVix(
  regime: StrategyFeatureSnapshotRegime,
  shock: number,
  anchorType: SignedShockAnchorType,
  vixPercentile: number,
): StrategyFeatureSnapshot {
  const base = STRATEGY_SYNTHETIC_FIXTURES.regime_shock_reversion_short_v3.snapshot;
  const anchor = 18600;
  const sigma = 6;
  const midPx = anchor + shock * sigma;
  const signedShock = {
    value: shock,
    anchor_type: anchorType,
    anchor_value: anchor,
    sigma_basis: 'atr_14' as const,
    sigma_basis_value: sigma,
  };
  return {
    ...base,
    quote: {
      bid_px: midPx - 0.125,
      ask_px: midPx + 0.125,
      mid_px: midPx,
    },
    last_trade_price: midPx,
    indicators: {
      ...base.indicators,
      sigma_pts: sigma,
      atr_14_pts: sigma,
    },
    context: {
      ...base.context,
      regime_label: regime,
      vix_prior_close_percentile: vixPercentile,
      session_vwap: anchor,
      signed_shock_vwap: anchorType === 'vwap'
        ? signedShock
        : {
          value: null,
          anchor_type: 'vwap',
          anchor_value: null,
          sigma_basis: 'atr_14',
          sigma_basis_value: null,
        },
      signed_shock_prior_close: anchorType === 'prior_close'
        ? signedShock
        : {
          value: null,
          anchor_type: 'prior_close',
          anchor_value: null,
          sigma_basis: 'atr_14',
          sigma_basis_value: null,
        },
    },
  };
}
