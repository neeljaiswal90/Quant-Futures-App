import { describe, expect, it } from 'vitest';

import {
  generateRegimeMeanReversionLong,
  generateRegimeMeanReversionShort,
  type StrategyFeatureSnapshot,
  type StrategyFeatureSnapshotRegime,
} from '../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

describe('regime mean reversion gate stack', () => {
  it('arms long only for high-regime negative overshoot', () => {
    const armed = generateRegimeMeanReversionLong({
      strategy_id: 'regime_mean_reversion_long',
      snapshot: withRegimeAndShock('regime_mean_reversion_long', 'high', -1.5),
    });
    const blocked = generateRegimeMeanReversionLong({
      strategy_id: 'regime_mean_reversion_long',
      snapshot: withRegimeAndShock('regime_mean_reversion_long', 'high', 1.5),
    });

    expect(armed.candidate?.direction).toBe('long');
    expect(armed.evaluation.gate_state).toBe('armed');
    expect(blocked.candidate).toBeUndefined();
    expect(blocked.evaluation.reasons[0]).toBe(
      'regime_mean_reversion_long:high_regime_shock_above_neg_threshold',
    );
  });

  it('arms short only for high-regime positive impulse', () => {
    const armed = generateRegimeMeanReversionShort({
      strategy_id: 'regime_mean_reversion_short',
      snapshot: withRegimeAndShock('regime_mean_reversion_short', 'high', 1.5),
    });
    const blocked = generateRegimeMeanReversionShort({
      strategy_id: 'regime_mean_reversion_short',
      snapshot: withRegimeAndShock('regime_mean_reversion_short', 'high', -1.5),
    });

    expect(armed.candidate?.direction).toBe('short');
    expect(armed.evaluation.gate_state).toBe('armed');
    expect(blocked.candidate).toBeUndefined();
    expect(blocked.evaluation.reasons[0]).toBe(
      'regime_mean_reversion_short:high_regime_shock_below_pos_threshold',
    );
  });

  it('fails closed for unknown and non-trading regimes', () => {
    const unknown = generateRegimeMeanReversionLong({
      strategy_id: 'regime_mean_reversion_long',
      snapshot: withRegimeAndShock('regime_mean_reversion_long', 'unknown', -3),
    });
    const mid = generateRegimeMeanReversionLong({
      strategy_id: 'regime_mean_reversion_long',
      snapshot: withRegimeAndShock('regime_mean_reversion_long', 'mid', -3),
    });

    expect(unknown.evaluation.reasons[0]).toBe('regime_mean_reversion_long:missing_regime_label');
    expect(mid.evaluation.reasons[0]).toBe('regime_mean_reversion_long:regime_state_non_trading');
  });

  it('requires a stricter low-regime shock hurdle', () => {
    const high = generateRegimeMeanReversionLong({
      strategy_id: 'regime_mean_reversion_long',
      snapshot: withRegimeAndShock('regime_mean_reversion_long', 'high', -1.5),
    });
    const low = generateRegimeMeanReversionLong({
      strategy_id: 'regime_mean_reversion_long',
      snapshot: withRegimeAndShock('regime_mean_reversion_long', 'low', -1.5),
    });

    expect(high.candidate).toBeDefined();
    expect(low.candidate).toBeUndefined();
    expect(low.evaluation.reasons[0]).toBe(
      'regime_mean_reversion_long:low_regime_shock_above_strict_neg_threshold',
    );
  });
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
