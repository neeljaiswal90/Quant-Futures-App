export const ACTIVE_STRATEGY_IDS = [] as const;

export const CANDIDATE_STRATEGY_IDS = [] as const;

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
  'regime_shock_reversion_short_v3',
  'regime_shock_reversion_short_v5_strict_deadline',
  'regime_shock_reversion_short_v5_trail_at_deadline',
] as const;

export const ALL_STRATEGY_IDS = [
  ...ACTIVE_STRATEGY_IDS,
  ...CANDIDATE_STRATEGY_IDS,
  ...REGISTERED_INACTIVE_STRATEGY_IDS,
] as const;

export type ActiveStrategyId = (typeof ACTIVE_STRATEGY_IDS)[number];
export type CandidateStrategyId = (typeof CANDIDATE_STRATEGY_IDS)[number];
export type RegisteredInactiveStrategyId = (typeof REGISTERED_INACTIVE_STRATEGY_IDS)[number];
export type StrategyId = (typeof ALL_STRATEGY_IDS)[number];

const STRATEGY_ID_SET = new Set<string>(ALL_STRATEGY_IDS);

export function isStrategyId(value: string): value is StrategyId {
  return STRATEGY_ID_SET.has(value);
}

export function parseStrategyId(value: string): StrategyId {
  if (!isStrategyId(value)) {
    throw new Error(`Unknown strategy_id: ${value}`);
  }
  return value;
}
