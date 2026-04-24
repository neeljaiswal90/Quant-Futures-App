import type { IndicatorConfig } from '../contracts/config.js';
import type { LobSnapshot, MarketSnapshot } from '../contracts/market.js';
import type { OrderflowRollingBuffer } from '../features/orderflow-state.js';
import type { StrategyId, StrategyEvaluation } from '../contracts/index.js';
import { genBreakdownRetestShort } from './breakdown_retest_short.js';
import { genBreakoutRetestLong } from './breakout_retest_long.js';
import { genTrendPullbackLong } from './trend_pullback_long.js';
import { genTrendPullbackShort } from './trend_pullback_short.js';

export type ActiveStrategyGenerator = (
  snap: MarketSnapshot,
  lob: LobSnapshot | null,
  config: IndicatorConfig,
  orderflowBuffer?: OrderflowRollingBuffer,
) => StrategyEvaluation;

export const ACTIVE_STRATEGIES: Record<StrategyId, ActiveStrategyGenerator> = {
  trend_pullback_long: genTrendPullbackLong,
  trend_pullback_short: genTrendPullbackShort,
  breakout_retest_long: genBreakoutRetestLong,
  breakdown_retest_short: genBreakdownRetestShort,
};

export {
  genTrendPullbackLong,
  genTrendPullbackShort,
  genBreakoutRetestLong,
  genBreakdownRetestShort,
};
