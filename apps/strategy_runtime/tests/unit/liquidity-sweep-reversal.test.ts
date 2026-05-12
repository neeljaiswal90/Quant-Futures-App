import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIQUIDITY_SWEEP_REVERSAL_LONG_CONFIG,
  DEFAULT_LIQUIDITY_SWEEP_REVERSAL_SHORT_CONFIG,
  type LiquiditySweepReversalStrategyParameters,
} from '../../src/config/index.js';
import {
  detectSweep,
  validateLiquiditySweepParameters,
} from '../../src/strategies/liquidity_sweep_reversal_common.js';
import {
  generateLiquiditySweepReversalLong,
  generateLiquiditySweepReversalShort,
} from '../../src/strategies/index.js';
import type { StrategyFeatureSnapshot } from '../../src/strategies/types.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

describe('liquidity_sweep_reversal strategy generators', () => {
  it('detects a bearish sweep and emits a long reversal candidate', () => {
    const snapshot = STRATEGY_SYNTHETIC_FIXTURES.liquidity_sweep_reversal_long.snapshot;
    const sweep = detectSweep(snapshot, DEFAULT_LIQUIDITY_SWEEP_REVERSAL_LONG_CONFIG);
    const result = generateLiquiditySweepReversalLong({
      strategy_id: 'liquidity_sweep_reversal_long',
      snapshot,
    });

    expect(sweep).toEqual(expect.objectContaining({
      sweep_direction: 'down',
      post_sweep_depth_ratio: 0.25,
    }));
    expect(result.evaluation.gate_state).toBe('armed');
    expect(result.candidate).toEqual(expect.objectContaining({
      direction: 'long',
      setup_family: 'liquidity_sweep_reversal',
      confidence: DEFAULT_LIQUIDITY_SWEEP_REVERSAL_LONG_CONFIG.confidence_score,
    }));
    expect(result.candidate?.targets.map((target) => target.quantity_fraction)).toEqual([0.5, 0.5]);
  });

  it('detects a bullish sweep and emits a short reversal candidate', () => {
    const snapshot = STRATEGY_SYNTHETIC_FIXTURES.liquidity_sweep_reversal_short.snapshot;
    const sweep = detectSweep(snapshot, DEFAULT_LIQUIDITY_SWEEP_REVERSAL_SHORT_CONFIG);
    const result = generateLiquiditySweepReversalShort({
      strategy_id: 'liquidity_sweep_reversal_short',
      snapshot,
    });

    expect(sweep).toEqual(expect.objectContaining({
      sweep_direction: 'up',
      post_sweep_depth_ratio: 0.26,
    }));
    expect(result.evaluation.gate_state).toBe('armed');
    expect(result.candidate).toEqual(expect.objectContaining({
      direction: 'short',
      setup_family: 'liquidity_sweep_reversal',
      confidence: DEFAULT_LIQUIDITY_SWEEP_REVERSAL_SHORT_CONFIG.confidence_score,
    }));
  });

  it('rejects opposite sweep direction before sizing', () => {
    const result = generateLiquiditySweepReversalLong({
      strategy_id: 'liquidity_sweep_reversal_long',
      snapshot: STRATEGY_SYNTHETIC_FIXTURES.liquidity_sweep_reversal_short.snapshot,
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe(
      'liquidity_sweep_reversal_long:wrong_sweep_direction_for_long_reversal',
    );
  });

  it('rejects stale sweeps and non-exhausted queues', () => {
    const stale = generateLiquiditySweepReversalLong({
      strategy_id: 'liquidity_sweep_reversal_long',
      snapshot: withMicrostructure(
        STRATEGY_SYNTHETIC_FIXTURES.liquidity_sweep_reversal_long.snapshot,
        { bars_since_sweep: 3 },
      ),
    });
    const notExhausted = generateLiquiditySweepReversalLong({
      strategy_id: 'liquidity_sweep_reversal_long',
      snapshot: withMicrostructure(
        STRATEGY_SYNTHETIC_FIXTURES.liquidity_sweep_reversal_long.snapshot,
        { depth_imbalance: -0.1 },
      ),
    });

    expect(stale.evaluation.reasons[0]).toBe('liquidity_sweep_reversal_long:snapback_window_expired');
    expect(notExhausted.evaluation.reasons[0]).toBe('liquidity_sweep_reversal_long:queue_not_exhausted');
  });

  it('fail-closes invalid parameter manifests', () => {
    const invalid: LiquiditySweepReversalStrategyParameters = {
      ...DEFAULT_LIQUIDITY_SWEEP_REVERSAL_LONG_CONFIG,
      pre_committed_retirement: false,
    };

    expect(() => validateLiquiditySweepParameters(invalid)).toThrow(
      'pre_committed_retirement=true',
    );
  });
});

function withMicrostructure(
  snapshot: StrategyFeatureSnapshot,
  values: Record<string, number>,
): StrategyFeatureSnapshot {
  return {
    ...snapshot,
    microstructure: {
      ...snapshot.microstructure,
      values: {
        ...snapshot.microstructure.values,
        ...values,
      },
    },
  };
}
