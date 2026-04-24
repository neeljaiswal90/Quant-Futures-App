import type { StrategyEvaluation } from '../contracts/candidate.js';
import type { IndicatorConfig } from '../contracts/config.js';
import type { LobSnapshot, MarketSnapshot } from '../contracts/market.js';
import type { OrderflowRollingBuffer } from '../features/orderflow-state.js';
import { buildEntryStateVector } from '../features/entry-state.js';
import { buildStrategyRejection, withSetupCandidate } from './common/rejection.js';
import {
  clampTarget,
  computeRr,
  validateSetupTargets,
} from './common/target-utils.js';
import { classifyRegime } from './common/freshness.js';

export function genBreakdownRetestShort(
  snap: MarketSnapshot,
  lob: LobSnapshot | null,
  config: IndicatorConfig,
  orderflowBuffer?: OrderflowRollingBuffer,
): StrategyEvaluation {
  const setupType: 'breakdown_retest_short' = 'breakdown_retest_short';
  const setupFamily = 'breakout_retest';
  const price = snap.price;
  const ind = snap.indicators_1m;
  const levels = snap.key_levels;

  const bosSell = ind.smart_money_bos_sell ?? levels.bos_sell;
  const chochSell = ind.smart_money_choch_sell ?? levels.choch_sell;
  const chochBuy = ind.smart_money_choch_buy ?? levels.choch_buy;

  const resistanceZoneLow = bosSell ?? chochSell;
  const resistanceZoneHigh = chochSell ?? bosSell;
  if (resistanceZoneLow === null || resistanceZoneHigh === null) {
    return buildStrategyRejection(setupType, setupFamily, 'breakdown_retest_short:resistance_zone_missing');
  }
  if (price >= resistanceZoneHigh) {
    return buildStrategyRejection(setupType, setupFamily, 'breakdown_retest_short:not_below_retest_zone');
  }
  if (resistanceZoneLow - price > 250) {
    return buildStrategyRejection(setupType, setupFamily, 'breakdown_retest_short:too_far_below_retest_zone');
  }
  if (chochBuy !== null && price <= chochBuy) {
    return buildStrategyRejection(setupType, setupFamily, 'breakdown_retest_short:below_choch_buy');
  }

  const entryStateVector = buildEntryStateVector(snap, lob, 'short', setupType, {
    regime: classifyRegime(snap),
    orderflowBuffer,
  });
  if (!entryStateVector) {
    return buildStrategyRejection(setupType, setupFamily, 'breakdown_retest_short:state_vector_unavailable');
  }

  const entryLow = Math.min(resistanceZoneLow, price + 10);
  const entryHigh = Math.max(resistanceZoneHigh, entryLow + 20);
  const entryMid = (entryLow + entryHigh) / 2;
  const stopAbove = resistanceZoneHigh + Math.max(12, entryStateVector.sigma_pts * 0.25);
  const stop = Math.max(stopAbove, entryHigh + entryStateVector.sigma_pts * 0.2);
  const riskPts = stop - entryMid;
  if (!(riskPts > 0)) {
    return buildStrategyRejection(setupType, setupFamily, 'breakdown_retest_short:non_positive_risk');
  }

  const t1 = clampTarget(chochBuy, entryMid, riskPts, 2, 'short');
  const t2Raw = (levels.daily_open !== null && levels.daily_open < t1)
    ? levels.daily_open
    : (levels.pivot_support[0] ?? null);
  const t2 = clampTarget(t2Raw, entryMid, riskPts, 4, 'short');
  const t3 = levels.weekly_open !== null && levels.weekly_open < entryMid ? levels.weekly_open : null;
  const rrT1 = computeRr(t1, entryMid, riskPts, 'short');
  const rrT2 = computeRr(t2, entryMid, riskPts, 'short');
  if (rrT1 < 1 || rrT2 <= 0) {
    return buildStrategyRejection(setupType, setupFamily, 'breakdown_retest_short:targets_invalid');
  }

  void config;
  const candidate = {
    direction: 'short' as const,
    setup_type: setupType,
    entry_low: round4(entryLow),
    entry_high: round4(entryHigh),
    stop: round4(stop),
    target_1: round4(t1),
    target_2: round4(t2),
    target_3: t3 !== null ? round4(t3) : null,
    risk_pts: round4(riskPts),
    rr_t1: rrT1,
    rr_t2: rrT2,
    confidence: 8.05,
    confidence_factors: ['breakdown_retest_zone_identified', 'bos_sell_overhead'],
    reason: `Breakdown retest short with broken support acting as resistance`,
    entry_state_vector: entryStateVector,
    ...validateSetupTargets({
      direction: 'short',
      entry_low: entryLow,
      entry_high: entryHigh,
      target_1: t1,
      target_2: t2,
      target_3: t3,
      risk_pts: riskPts,
    }),
  };
  return withSetupCandidate(setupType, setupFamily, candidate);
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
