export const ACTIVE_STRATEGY_IDS = [
  'trend_pullback_long',
  'trend_pullback_short',
  'breakout_retest_long',
  'breakdown_retest_short',
] as const;

export type StrategyId = typeof ACTIVE_STRATEGY_IDS[number];

export function isStrategyId(value: string): value is StrategyId {
  return (ACTIVE_STRATEGY_IDS as readonly string[]).includes(value);
}
