import { describe, expect, it } from 'vitest';

import { computeInLoopSScore } from '../../../../../scripts/strategy-gen/in-loop-s-score.js';

const baseMetrics = {
  annualized_sharpe: 1.5,
  profit_factor: 1.4,
  expectancy_cents: 25,
  max_drawdown_pct: 0.04,
  trade_count: 42,
  fold_scores: [12, 14, 13],
} as const;

describe('strategy-gen in-loop S score', () => {
  it('computes a deterministic score from validation metrics', () => {
    const result = computeInLoopSScore({
      candidate_strategy_id: 'regime_shock_reversion_short_v2_gen_unit',
      partition_role: 'validation',
      metrics: baseMetrics,
    });

    expect(result.score_name).toBe('strategy_gen_in_loop_s_v1');
    expect(result.partition_role).toBe('validation');
    expect(result.components.sharpe_component).toBe(30);
    expect(result.components.profit_factor_component).toBe(20);
    expect(result.components.expectancy_component).toBe(2.5);
    expect(result.components.drawdown_penalty).toBe(8);
    expect(result.components.trade_floor_penalty).toBe(0);
    expect(result.score).toBe(24.087585);
  });

  it('penalizes below-floor trade counts', () => {
    const result = computeInLoopSScore({
      candidate_strategy_id: 'regime_shock_reversion_short_v2_gen_unit',
      partition_role: 'train',
      metrics: {
        ...baseMetrics,
        trade_count: 10,
      },
      min_trade_count: 30,
    });

    expect(result.components.trade_floor_penalty).toBe(40);
    expect(result.score).toBeLessThan(0);
  });

  it('refuses held-out and paper partitions', () => {
    expect(() => computeInLoopSScore({
      candidate_strategy_id: 'regime_shock_reversion_short_v2_gen_unit',
      partition_role: 'held_out',
      metrics: baseMetrics,
    })).toThrow('TRAIN/VALIDATION');

    expect(() => computeInLoopSScore({
      candidate_strategy_id: 'regime_shock_reversion_short_v2_gen_unit',
      partition_role: 'paper',
      metrics: baseMetrics,
    })).toThrow('TRAIN/VALIDATION');
  });
});
