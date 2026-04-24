import type { StrategyEvaluation } from '../contracts/candidate.js';
import type { IndicatorConfig } from '../contracts/config.js';
import type { LobSnapshot, MarketSnapshot } from '../contracts/market.js';
import type { OrderflowRollingBuffer } from '../features/orderflow-state.js';
import { buildEntryStateVector } from '../features/entry-state.js';
import { buildStrategyRejection, withSetupCandidate } from './common/rejection.js';
import {
  clampTarget,
  computeRr,
  hasRoomToUpside,
  validateSetupTargets,
} from './common/target-utils.js';
import { classifyRegime, isTrendFresh } from './common/freshness.js';

export function genBreakoutRetestLong(
  snap: MarketSnapshot,
  lob: LobSnapshot | null,
  config: IndicatorConfig,
  orderflowBuffer?: OrderflowRollingBuffer,
): StrategyEvaluation {
  const setupType: 'breakout_retest_long' = 'breakout_retest_long';
  const setupFamily = 'breakout_retest';
  const price = snap.price;
  const ind = snap.indicators_1m;
  if (ind.supertrend_direction !== 'up') {
    return buildStrategyRejection(setupType, setupFamily, 'breakout_retest_long:supertrend_not_up');
  }
  if (!(ind.ema_9 && ind.ema_21 && ind.ema_50)) {
    return buildStrategyRejection(setupType, setupFamily, 'breakout_retest_long:ema_stack_missing');
  }
  if (!(price > ind.ema_9 && ind.ema_9 > ind.ema_21 && ind.ema_21 > ind.ema_50)) {
    return buildStrategyRejection(setupType, setupFamily, 'breakout_retest_long:ema_stack_not_bullish');
  }

  const freshness = isTrendFresh(snap, 'long', config, setupType);
  if (!freshness.fresh) {
    return buildStrategyRejection(setupType, setupFamily, `breakout_retest_long:${freshness.reason}`);
  }

  const entryStateVector = buildEntryStateVector(snap, lob, 'long', setupType, {
    regime: classifyRegime(snap),
    orderflowBuffer,
  });
  if (!entryStateVector) {
    return buildStrategyRejection(setupType, setupFamily, 'breakout_retest_long:state_vector_unavailable');
  }

  const ema9Distance = price - ind.ema_9;
  if (ema9Distance < 0 || ema9Distance > entryStateVector.sigma_pts * 0.85) {
    return buildStrategyRejection(setupType, setupFamily, 'breakout_retest_long:not_near_ema9');
  }

  const entryLow = Math.min(ind.ema_9, price - entryStateVector.sigma_pts * 0.1);
  const entryHigh = price + entryStateVector.sigma_pts * 0.15;
  const entryMid = (entryLow + entryHigh) / 2;
  const stop = ind.ema_21 - entryStateVector.sigma_pts * 0.5;
  const riskPts = entryMid - stop;
  if (!(riskPts > 0)) {
    return buildStrategyRejection(setupType, setupFamily, 'breakout_retest_long:non_positive_risk');
  }
  if (!hasRoomToUpside(snap, entryMid, 1.0)) {
    return buildStrategyRejection(setupType, setupFamily, 'breakout_retest_long:insufficient_upside_room');
  }

  const resistance = snap.key_levels.pivot_resistance[0] ?? snap.key_levels.session_high ?? null;
  if (resistance === null) {
    return buildStrategyRejection(setupType, setupFamily, 'breakout_retest_long:nearest_resistance_missing');
  }
  const t1 = clampTarget(resistance, entryMid, riskPts, 2, 'long');
  const t2 = clampTarget(snap.key_levels.pivot_resistance[1] ?? null, entryMid, riskPts, 4, 'long');
  const rrT1 = computeRr(t1, entryMid, riskPts, 'long');
  const rrT2 = computeRr(t2, entryMid, riskPts, 'long');
  if (rrT1 < 1 || rrT2 <= 0) {
    return buildStrategyRejection(setupType, setupFamily, 'breakout_retest_long:targets_invalid');
  }

  const candidate = {
    direction: 'long' as const,
    setup_type: setupType,
    entry_low: round4(entryLow),
    entry_high: round4(entryHigh),
    stop: round4(stop),
    target_1: round4(t1),
    target_2: round4(t2),
    target_3: null,
    risk_pts: round4(riskPts),
    rr_t1: rrT1,
    rr_t2: rrT2,
    confidence: 8.1,
    confidence_factors: ['breakout_retest', 'ema_stack_bullish', freshness.reason],
    reason: `Breakout retest long with EMA9 support and pivot resistance target`,
    freshness,
    entry_state_vector: entryStateVector,
    ...validateSetupTargets({
      direction: 'long',
      entry_low: entryLow,
      entry_high: entryHigh,
      target_1: t1,
      target_2: t2,
      target_3: null,
      risk_pts: riskPts,
    }),
  };
  return withSetupCandidate(setupType, setupFamily, candidate);
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
