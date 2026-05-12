import { describe, expect, it } from 'vitest';

import {
  generateRegimeMeanReversionLong,
  generateRegimeMeanReversionShort,
  type StrategyFeatureSnapshot,
  type StrategyFeatureSnapshotRegime,
} from '../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

describe('regime_mean_reversion_long: regime-uniform sizing across 15-cell matrix', () => {
  const regimes = ['low', 'mid', 'high'] as const;
  const signedShockCells = [-3, -1.5, 0, 1.5, 3] as const;

  for (const regime of regimes) {
    for (const shock of signedShockCells) {
      it(`keeps risk sizing stable when candidate fires (regime=${regime}, shock=${shock})`, () => {
        const baseline = generateRegimeMeanReversionLong({
          strategy_id: 'regime_mean_reversion_long',
          snapshot: withRegimeAndShock('regime_mean_reversion_long', 'high', -3),
        }).candidate;
        const result = generateRegimeMeanReversionLong({
          strategy_id: 'regime_mean_reversion_long',
          snapshot: withRegimeAndShock('regime_mean_reversion_long', regime, shock),
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
});

describe('regime_mean_reversion_short: regime-uniform sizing across 15-cell matrix', () => {
  const regimes = ['low', 'mid', 'high'] as const;
  const signedShockCells = [-3, -1.5, 0, 1.5, 3] as const;

  for (const regime of regimes) {
    for (const shock of signedShockCells) {
      it(`keeps risk sizing stable when candidate fires (regime=${regime}, shock=${shock})`, () => {
        const baseline = generateRegimeMeanReversionShort({
          strategy_id: 'regime_mean_reversion_short',
          snapshot: withRegimeAndShock('regime_mean_reversion_short', 'high', 3),
        }).candidate;
        const result = generateRegimeMeanReversionShort({
          strategy_id: 'regime_mean_reversion_short',
          snapshot: withRegimeAndShock('regime_mean_reversion_short', regime, shock),
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
});

function withRegimeAndShock(
  strategyId: 'regime_mean_reversion_long' | 'regime_mean_reversion_short',
  regime: StrategyFeatureSnapshotRegime,
  shock: number,
): StrategyFeatureSnapshot {
  const base = STRATEGY_SYNTHETIC_FIXTURES[strategyId].snapshot;
  const reference = 100;
  const sigmaPts = 4;
  const midPx = reference + shock * sigmaPts;
  return {
    ...base,
    quote: {
      bid_px: midPx - 0.125,
      ask_px: midPx + 0.125,
      mid_px: midPx,
    },
    last_trade_price: midPx,
    bars: base.bars.map((bar) => ({
      ...bar,
      open: reference,
      high: reference + 1,
      low: reference - 1,
      close: reference,
      volume: 100,
    })),
    indicators: {
      ...base.indicators,
      sigma_pts: sigmaPts,
    },
    context: {
      ...base.context,
      regime_label: regime,
    },
  };
}
