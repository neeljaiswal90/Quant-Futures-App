import type { StrategyGenPartitionRole } from './data-split-spine.js';

export interface InLoopScoreMetrics {
  readonly annualized_sharpe: number;
  readonly profit_factor: number;
  readonly expectancy_cents: number;
  readonly max_drawdown_pct: number;
  readonly trade_count: number;
  readonly fold_scores: readonly number[];
}

export interface InLoopScoreInput {
  readonly candidate_strategy_id: string;
  readonly partition_role: StrategyGenPartitionRole;
  readonly metrics: InLoopScoreMetrics;
  readonly min_trade_count?: number;
}

export interface InLoopScoreComponents {
  readonly sharpe_component: number;
  readonly profit_factor_component: number;
  readonly expectancy_component: number;
  readonly drawdown_penalty: number;
  readonly fold_dispersion_penalty: number;
  readonly trade_floor_penalty: number;
}

export interface InLoopScoreResult {
  readonly candidate_strategy_id: string;
  readonly partition_role: 'train' | 'validation';
  readonly score_schema_version: 1;
  readonly score_name: 'strategy_gen_in_loop_s_v1';
  readonly score: number;
  readonly components: InLoopScoreComponents;
  readonly min_trade_count: number;
  readonly trade_count: number;
}

const DEFAULT_MIN_TRADE_COUNT = 30;

export function computeInLoopSScore(input: InLoopScoreInput): InLoopScoreResult {
  if (input.partition_role !== 'train' && input.partition_role !== 'validation') {
    throw new Error(
      `in-loop S score may only read TRAIN/VALIDATION partitions, got ${input.partition_role}`,
    );
  }
  if (input.candidate_strategy_id.trim() === '') {
    throw new Error('candidate_strategy_id is required');
  }
  const minTradeCount = input.min_trade_count ?? DEFAULT_MIN_TRADE_COUNT;
  if (!Number.isInteger(minTradeCount) || minTradeCount <= 0) {
    throw new Error('min_trade_count must be a positive integer');
  }
  const metrics = validateMetrics(input.metrics);
  const components: InLoopScoreComponents = {
    sharpe_component: round6(clamp(metrics.annualized_sharpe, -5, 5) * 20),
    profit_factor_component: round6(clamp((metrics.profit_factor - 1) * 50, -100, 100)),
    expectancy_component: round6(clamp(metrics.expectancy_cents / 10, -50, 50)),
    drawdown_penalty: round6(clamp(metrics.max_drawdown_pct * 100, 0, 100) * 2),
    fold_dispersion_penalty: round6(stddev(metrics.fold_scores) * 25),
    trade_floor_penalty: round6(Math.max(0, minTradeCount - metrics.trade_count) * 2),
  };
  const score = round6(
    components.sharpe_component +
    components.profit_factor_component +
    components.expectancy_component -
    components.drawdown_penalty -
    components.fold_dispersion_penalty -
    components.trade_floor_penalty,
  );
  return {
    candidate_strategy_id: input.candidate_strategy_id,
    partition_role: input.partition_role,
    score_schema_version: 1,
    score_name: 'strategy_gen_in_loop_s_v1',
    score,
    components,
    min_trade_count: minTradeCount,
    trade_count: metrics.trade_count,
  };
}

function validateMetrics(metrics: InLoopScoreMetrics): InLoopScoreMetrics {
  finite(metrics.annualized_sharpe, 'annualized_sharpe');
  finite(metrics.profit_factor, 'profit_factor');
  finite(metrics.expectancy_cents, 'expectancy_cents');
  finite(metrics.max_drawdown_pct, 'max_drawdown_pct');
  finite(metrics.trade_count, 'trade_count');
  if (metrics.profit_factor < 0) {
    throw new Error('profit_factor must be non-negative');
  }
  if (metrics.max_drawdown_pct < 0) {
    throw new Error('max_drawdown_pct must be non-negative');
  }
  if (!Number.isInteger(metrics.trade_count) || metrics.trade_count < 0) {
    throw new Error('trade_count must be a non-negative integer');
  }
  if (metrics.fold_scores.length === 0) {
    throw new Error('fold_scores must contain at least one TRAIN/VALIDATION fold score');
  }
  for (const [index, value] of metrics.fold_scores.entries()) {
    finite(value, `fold_scores[${index}]`);
  }
  return metrics;
}

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite`);
  }
}

function stddev(values: readonly number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
