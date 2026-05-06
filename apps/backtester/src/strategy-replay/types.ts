import type { Candidate, StrategyEvaluation } from '../../../strategy_runtime/src/contracts/index.js';
import type { StrategyId } from '../../../strategy_runtime/src/contracts/strategy-ids.js';
import type { UnixNs } from '../../../strategy_runtime/src/contracts/time.js';
import type { BuiltBar } from '../../../strategy_runtime/src/data/bar-builder/index.js';
import type { StrategyFeatureSnapshot } from '../../../strategy_runtime/src/strategies/index.js';

// Future replay consumers must dispatch on this marker before treating feature
// snapshots as validation-grade; replay_sanity_v1 intentionally contains
// placeholder fields and is not a real feature-derivation contract.
export const STRATEGY_REPLAY_FEATURE_SOURCE = 'replay_sanity_v1' as const;

export const REPLAY_SANITY_PLACEHOLDER_FIELDS = [
  'session.trading_date',
  'session.phase',
  'quote.bid_px',
  'quote.ask_px',
  'microstructure.l3_authority',
  'microstructure.values.ofi_z',
  'indicators.supertrend_direction',
  'structure.values.breakout_level',
  'structure.values.broken_support',
  'structure.values.retest_hold',
  'structure.values.retest_reject',
] as const;

export type ReplaySanityPlaceholderField =
  (typeof REPLAY_SANITY_PLACEHOLDER_FIELDS)[number];

export interface StrategyReplayOptions {
  readonly strategy_ids: readonly (StrategyId | string)[];
  readonly bars: AsyncIterable<BuiltBar> | readonly BuiltBar[];
}

export interface StrategyReplayFeatureSnapshot {
  readonly feature_source: typeof STRATEGY_REPLAY_FEATURE_SOURCE;
  readonly placeholder_fields: readonly ReplaySanityPlaceholderField[];
  readonly snapshot: StrategyFeatureSnapshot;
}

export interface StrategyReplayEvaluation {
  readonly strategy_id: StrategyId;
  readonly bar_id: string;
  readonly ts_ns: UnixNs;
  readonly evaluation: StrategyEvaluation;
  readonly candidate?: Candidate;
}

export interface StrategyReplaySanityResult {
  readonly strategy_id: StrategyId;
  readonly bars_evaluated: number;
  readonly evaluations_emitted: number;
  readonly errors: readonly string[];
}

export interface StrategyReplayResult {
  readonly evaluations: readonly StrategyReplayEvaluation[];
  readonly summary: readonly StrategyReplaySanityResult[];
}
