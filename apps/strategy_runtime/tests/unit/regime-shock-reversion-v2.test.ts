import { describe, expect, it } from 'vitest';

import {
  generateRegimeShockReversionShortV2,
  type StrategyFeatureSnapshot,
  type StrategyFeatureSnapshotRegime,
} from '../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

describe('regime_shock_reversion_short_v2 gate stack', () => {
  it('arms on high-regime positive VWAP shock above the tightened v2 threshold', () => {
    const result = generateRegimeShockReversionShortV2({
      strategy_id: 'regime_shock_reversion_short_v2',
      snapshot: withRegimeAndShock('high', 2.5),
    });

    expect(result.candidate?.direction).toBe('short');
    expect(result.evaluation.gate_state).toBe('armed');
    expect(result.evaluation.reasons).toContain('signed_shock_vwap:2.5');
  });

  it('blocks high-regime shocks below the v2 threshold', () => {
    const result = generateRegimeShockReversionShortV2({
      strategy_id: 'regime_shock_reversion_short_v2',
      snapshot: withRegimeAndShock('high', 1.5),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe(
      'regime_shock_reversion_short_v2:high_regime_shock_below_pos_threshold',
    );
  });

  it('blocks low-regime shocks below the stricter low-regime threshold', () => {
    const result = generateRegimeShockReversionShortV2({
      strategy_id: 'regime_shock_reversion_short_v2',
      snapshot: withRegimeAndShock('low', 2.5),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe(
      'regime_shock_reversion_short_v2:low_regime_shock_below_strict_pos_threshold',
    );
  });

  it('fails closed when the regime label is unavailable', () => {
    const result = generateRegimeShockReversionShortV2({
      strategy_id: 'regime_shock_reversion_short_v2',
      snapshot: withRegimeAndShock('unknown', 2.5),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe(
      'regime_shock_reversion_short_v2:missing_regime_label',
    );
  });
});

function withRegimeAndShock(
  regime: StrategyFeatureSnapshotRegime,
  shock: number,
): StrategyFeatureSnapshot {
  const base = STRATEGY_SYNTHETIC_FIXTURES.regime_shock_reversion_short_v2.snapshot;
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
    },
  };
}
