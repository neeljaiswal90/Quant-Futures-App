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

export const QUANT_TP_Z_EMA9_MIN = 0.15;
export const QUANT_TP_Z_EMA9_MAX = 1.25;
export const QUANT_TP_PULLBACK_RATIO_MIN = 0.25;
export const QUANT_TP_PULLBACK_RATIO_MAX = 0.62;
export const QUANT_TP_FLOW_CONFIRMATION_MIN = 0.2;
export const QUANT_TP_ENTRY_HALF_BAND_SIGMA = 0.1;
export const QUANT_TP_K_SL = 1.05;

export function genTrendPullbackLong(
  snap: MarketSnapshot,
  lob: LobSnapshot | null,
  config: IndicatorConfig,
  orderflowBuffer?: OrderflowRollingBuffer,
): StrategyEvaluation {
  const setupType: 'trend_pullback_long' = 'trend_pullback_long';
  const setupFamily = 'trend_pullback';
  const ind = snap.indicators_1m;
  if (ind.supertrend_direction !== 'up') {
    return buildStrategyRejection(setupType, setupFamily, 'trend_pullback_long:supertrend_not_up');
  }
  if (!(ind.ema_9 && ind.ema_21 && ind.ema_50)) {
    return buildStrategyRejection(setupType, setupFamily, 'trend_pullback_long:ema_stack_missing');
  }
  if (!(ind.ema_9 > ind.ema_21 && ind.ema_21 > ind.ema_50)) {
    return buildStrategyRejection(setupType, setupFamily, 'trend_pullback_long:ema_stack_not_bullish');
  }

  const freshness = isTrendFresh(snap, 'long', config, setupType);
  if (!freshness.fresh) {
    return buildStrategyRejection(setupType, setupFamily, `trend_pullback_long:${freshness.reason}`);
  }

  const entryStateVector = buildEntryStateVector(snap, lob, 'long', setupType, {
    regime: classifyRegime(snap),
    orderflowBuffer,
  });
  if (!entryStateVector) {
    return buildStrategyRejection(setupType, setupFamily, 'trend_pullback_long:state_vector_unavailable');
  }

  const zEma9 = entryStateVector.z_ema9;
  if (zEma9 === null || zEma9 < QUANT_TP_Z_EMA9_MIN || zEma9 > QUANT_TP_Z_EMA9_MAX) {
    return buildStrategyRejection(setupType, setupFamily, 'trend_pullback_long:z_ema9_out_of_band');
  }
  const pbRatio = entryStateVector.pullback_ratio;
  if (pbRatio !== null && (pbRatio < QUANT_TP_PULLBACK_RATIO_MIN || pbRatio > QUANT_TP_PULLBACK_RATIO_MAX)) {
    return buildStrategyRejection(setupType, setupFamily, 'trend_pullback_long:pullback_ratio_out_of_band');
  }
  const zFlow = entryStateVector.z_ofi_blend;
  if (zFlow !== null && zFlow < QUANT_TP_FLOW_CONFIRMATION_MIN) {
    return buildStrategyRejection(setupType, setupFamily, 'trend_pullback_long:flow_confirmation_below_threshold');
  }

  const sigma = entryStateVector.sigma_pts;
  const entryHalfBand = sigma * QUANT_TP_ENTRY_HALF_BAND_SIGMA;
  const entryLow = snap.price - entryHalfBand;
  const entryHigh = snap.price + entryHalfBand;
  const entryMid = snap.price;
  const stop = entryMid - sigma * QUANT_TP_K_SL;
  const riskPts = entryMid - stop;
  if (!(riskPts > 0)) {
    return buildStrategyRejection(setupType, setupFamily, 'trend_pullback_long:non_positive_risk');
  }
  if (!hasRoomToUpside(snap, entryMid, 1.0)) {
    return buildStrategyRejection(setupType, setupFamily, 'trend_pullback_long:insufficient_upside_room');
  }

  const t1 = clampTarget(ind.smart_money_choch_sell ?? snap.key_levels.choch_sell ?? null, entryMid, riskPts, 2, 'long');
  const t2 = clampTarget(snap.key_levels.pivot_resistance[0] ?? null, entryMid, riskPts, 4, 'long');
  const rrT1 = computeRr(t1, entryMid, riskPts, 'long');
  const rrT2 = computeRr(t2, entryMid, riskPts, 'long');
  if (rrT1 < 1 || rrT2 <= 0) {
    return buildStrategyRejection(setupType, setupFamily, 'trend_pullback_long:targets_invalid');
  }

  const confidence = clampConfidence(
    8.1 +
      (zFlow ?? 0) * 0.15 +
      (pbRatio !== null ? (0.45 - Math.abs(pbRatio - 0.45)) * 0.5 : 0),
  );

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
    confidence,
    confidence_factors: [
      'trend_pullback',
      'ema_stack_bullish',
      'supertrend_up',
      freshness.reason,
      'upside_room_confirmed',
    ],
    reason: `Trend pullback long around EMA cluster with sigma-based stop ${round4(stop)}`,
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

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(10, round2(value)));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
