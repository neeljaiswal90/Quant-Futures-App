import { GENERATED_CANDIDATE_STRATEGY_IDS } from './generated-candidate-strategy-ids.js';

export const ACTIVE_STRATEGY_IDS = [] as const;

export const CANDIDATE_STRATEGY_IDS = GENERATED_CANDIDATE_STRATEGY_IDS;

export const REGISTERED_INACTIVE_STRATEGY_IDS = [
  'trend_pullback_long',
  'trend_pullback_short',
  'breakout_retest_long',
  'breakdown_retest_short',
  'regime_mean_reversion_long',
  'regime_mean_reversion_short',
  'liquidity_sweep_reversal_long',
  'liquidity_sweep_reversal_short',
  'vwap_overnight_reversal_long',
  'vwap_overnight_reversal_short',
  'regime_shock_reversion_short_v2',
  'regime_shock_reversion_short_v2_utc_16_18_exclusion',
  'opening_range_box_breakout_long',
  'regime_shock_reversion_short_v3',
  'regime_shock_reversion_short_v4_delay',
  'regime_shock_reversion_short_v4_persist',
  'regime_shock_reversion_short_v5_strict_deadline',
  'regime_shock_reversion_short_v5_trail_at_deadline',
] as const;

export const ALL_STRATEGY_IDS = [
  ...ACTIVE_STRATEGY_IDS,
  ...REGISTERED_INACTIVE_STRATEGY_IDS,
] as const;

export const ANY_STRATEGY_IDS = [
  ...ALL_STRATEGY_IDS,
  ...CANDIDATE_STRATEGY_IDS,
] as const;

export type ActiveStrategyId = (typeof ACTIVE_STRATEGY_IDS)[number];
export type CandidateStrategyId = (typeof CANDIDATE_STRATEGY_IDS)[number];
export type RegisteredInactiveStrategyId = (typeof REGISTERED_INACTIVE_STRATEGY_IDS)[number];
export type StrategyId = (typeof ALL_STRATEGY_IDS)[number];
export type AnyStrategyId = StrategyId | CandidateStrategyId;

const STRATEGY_ID_SET = new Set<string>(ALL_STRATEGY_IDS);
const ANY_STRATEGY_ID_SET = new Set<string>(ANY_STRATEGY_IDS);

export function isStrategyId(value: string): value is StrategyId {
  return STRATEGY_ID_SET.has(value);
}

export function isAnyStrategyId(value: string): value is AnyStrategyId {
  return ANY_STRATEGY_ID_SET.has(value);
}

export function parseStrategyId(value: string): StrategyId {
  if (!isStrategyId(value)) {
    throw new Error(`Unknown strategy_id: ${value}`);
  }
  return value;
}

export function parseAnyStrategyId(value: string): AnyStrategyId {
  if (!isAnyStrategyId(value)) {
    throw new Error(`Unknown strategy_id: ${value}`);
  }
  return value;
}

