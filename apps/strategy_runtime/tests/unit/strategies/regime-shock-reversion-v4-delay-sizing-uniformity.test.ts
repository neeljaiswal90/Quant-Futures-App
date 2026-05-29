import { describe, expect, it } from 'vitest';

import {
  generateRegimeShockReversionShortV4Delay,
  type StrategyFeatureSnapshot,
  type StrategyFeatureSnapshotRegime,
} from '../../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../../fixtures/strategies/synthetic-feature-snapshots.js';

describe('regime_shock_reversion_short_v4_delay: sizing uniformity across delay arming buckets', () => {
  const regimes = ['low', 'mid', 'high'] as const;
  const signedShockCells = [-3, -1.5, 0, 1.5, 3] as const;

  for (const regime of regimes) {
    for (const shock of signedShockCells) {
      it(`keeps risk sizing stable when candidate fires (regime=${regime}, shock=${shock})`, () => {
        const baseline = generateRegimeShockReversionShortV4Delay({
          strategy_id: 'regime_shock_reversion_short_v4_delay',
          snapshot: withRegimeShockAndRecent('high', 3),
        }).candidate;
        const result = generateRegimeShockReversionShortV4Delay({
          strategy_id: 'regime_shock_reversion_short_v4_delay',
          snapshot: withRegimeShockAndRecent(regime, shock),
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

function withRegimeShockAndRecent(
  regime: StrategyFeatureSnapshotRegime,
  shock: number,
): StrategyFeatureSnapshot {
  const base = STRATEGY_SYNTHETIC_FIXTURES.regime_shock_reversion_short_v4_delay.snapshot;
  const anchor = 18600;
  const sigma = 6;
  const midPx = anchor + shock * sigma;
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
      session_vwap: anchor,
      signed_shock_vwap: {
        value: shock,
        anchor_type: 'vwap',
        anchor_value: anchor,
        sigma_basis: 'atr_14',
        sigma_basis_value: sigma,
      },
      signed_shock_vwap_recent_values: [shock, shock],
    },
  };
}