export const ACTIVE_STRATEGY_IDS = [
  'trend_pullback_long',
  'trend_pullback_short',
  'breakout_retest_long',
  'breakdown_retest_short',
] as const;

export type StrategyId = (typeof ACTIVE_STRATEGY_IDS)[number];

const ACTIVE_STRATEGY_ID_SET = new Set<string>(ACTIVE_STRATEGY_IDS);

export function isStrategyId(value: string): value is StrategyId {
  return ACTIVE_STRATEGY_ID_SET.has(value);
}

export function parseStrategyId(value: string): StrategyId {
  if (!isStrategyId(value)) {
    throw new Error(`Unknown strategy_id: ${value}`);
  }
  return value;
}
