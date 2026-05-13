import { describe, expect, it } from 'vitest';

import {
  generateVwapOvernightReversalLong,
  generateVwapOvernightReversalShort,
  type SignedShockAnchorType,
  type StrategyFeatureSnapshot,
  type StrategyFeatureSnapshotRegime,
} from '../../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../../fixtures/strategies/synthetic-feature-snapshots.js';

describe('vwap_overnight_reversal_long: sizing uniformity plus anchor invariance', () => {
  const regimes = ['low', 'mid', 'high'] as const;
  const signedShockCells = [-3, -1.5, 0, 1.5, 3] as const;
  const anchorTypes = ['vwap', 'prior_close'] as const;

  for (const regime of regimes) {
    for (const shock of signedShockCells) {
      for (const anchorType of anchorTypes) {
        it(`keeps risk sizing stable when candidate fires (regime=${regime}, shock=${shock}, anchor=${anchorType})`, () => {
          const baseline = generateVwapOvernightReversalLong({
            strategy_id: 'vwap_overnight_reversal_long',
            snapshot: withRegimeShockAndAnchor('long', 'high', -3, 'vwap'),
          }).candidate;
          const result = generateVwapOvernightReversalLong({
            strategy_id: 'vwap_overnight_reversal_long',
            snapshot: withRegimeShockAndAnchor('long', regime, shock, anchorType),
          });

          if (result.candidate !== undefined) {
            expect(baseline).toBeDefined();
            expect(result.candidate.risk_points).toBeCloseTo(baseline!.risk_points, 4);
            expect(result.candidate.targets.map((target) => target.quantity_fraction))
              .toEqual(baseline!.targets.map((target) => target.quantity_fraction));
          }
        });
      }
    }
  }
});

describe('vwap_overnight_reversal_short: sizing uniformity plus anchor invariance', () => {
  const regimes = ['low', 'mid', 'high'] as const;
  const signedShockCells = [-3, -1.5, 0, 1.5, 3] as const;
  const anchorTypes = ['vwap', 'prior_close'] as const;

  for (const regime of regimes) {
    for (const shock of signedShockCells) {
      for (const anchorType of anchorTypes) {
        it(`keeps risk sizing stable when candidate fires (regime=${regime}, shock=${shock}, anchor=${anchorType})`, () => {
          const baseline = generateVwapOvernightReversalShort({
            strategy_id: 'vwap_overnight_reversal_short',
            snapshot: withRegimeShockAndAnchor('short', 'high', 3, 'vwap'),
          }).candidate;
          const result = generateVwapOvernightReversalShort({
            strategy_id: 'vwap_overnight_reversal_short',
            snapshot: withRegimeShockAndAnchor('short', regime, shock, anchorType),
          });

          if (result.candidate !== undefined) {
            expect(baseline).toBeDefined();
            expect(result.candidate.risk_points).toBeCloseTo(baseline!.risk_points, 4);
            expect(result.candidate.targets.map((target) => target.quantity_fraction))
              .toEqual(baseline!.targets.map((target) => target.quantity_fraction));
          }
        });
      }
    }
  }
});

function withRegimeShockAndAnchor(
  direction: 'long' | 'short',
  regime: StrategyFeatureSnapshotRegime,
  shock: number,
  anchorType: SignedShockAnchorType,
): StrategyFeatureSnapshot {
  const strategyId = direction === 'long'
    ? 'vwap_overnight_reversal_long'
    : 'vwap_overnight_reversal_short';
  const base = STRATEGY_SYNTHETIC_FIXTURES[strategyId].snapshot;
  const anchor = 18600;
  const atr14 = 5;
  const midPx = anchor + shock * atr14;
  const signedShock = {
    value: shock,
    anchor_type: anchorType,
    anchor_value: anchor,
    sigma_basis: 'atr_14' as const,
    sigma_basis_value: atr14,
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
      atr_14_pts: atr14,
      adx_14: 16,
    },
    context: {
      ...base.context,
      regime_label: regime,
      session_vwap: anchor,
      overnight_return_bps: direction === 'long' ? -25 : 25,
      opening_range_minutes_elapsed: 15,
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
