import type { StrategyEvaluation } from '../contracts/candidate.js';
import type { IndicatorConfig } from '../contracts/config.js';
import type { LobSnapshot, MarketSnapshot } from '../contracts/market.js';
import type { OrderflowRollingBuffer } from '../features/orderflow-state.js';
import { buildEntryStateVector } from '../features/entry-state.js';
import { buildStrategyRejection, withSetupCandidate } from './common/rejection.js';
import {
  clampTarget,
  computeRr,
  hasRoomToDownside,
  validateSetupTargets,
} from './common/target-utils.js';
import { classifyRegime, isTrendFresh } from './common/freshness.js';
import {
  QUANT_TP_ENTRY_HALF_BAND_SIGMA,
  QUANT_TP_FLOW_CONFIRMATION_MIN,
  QUANT_TP_K_SL,
  QUANT_TP_PULLBACK_RATIO_MAX,
  QUANT_TP_PULLBACK_RATIO_MIN,
  QUANT_TP_Z_EMA9_MAX,
  QUANT_TP_Z_EMA9_MIN,
} from './trend_pullback_long.js';

export function genTrendPullbackShort(
  snap: MarketSnapshot,
  lob: LobSnapshot | null,
  config: IndicatorConfig,
  orderflowBuffer?: OrderflowRollingBuffer,
): StrategyEvaluation {
  const setupType: 'trend_pullback_short' = 'trend_pullback_short';
  const setupFamily = 'trend_pullback';
  const ind = snap.indicators_1m;
  if (ind.supertrend_direction !== 'down') {
    return buildStrategyRejection(setupType, setupFamily, 'trend_pullback_short:supertrend_not_down');
  }
  if (!(ind.ema_9 && ind.ema_21 && ind.ema_50)) {
    return buildStrategyRejection(setupType, setupFamily, 'trend_pullback_short:ema_stack_missing');
  }
  if (!(ind.ema_9 < ind.ema_21 && ind.ema_21 < ind.ema_50)) {
    return buildStrategyRejection(setupType, setupFamily, 'trend_pullback_short:ema_stack_not_bearish');
  }

  const freshness = isTrendFresh(snap, 'short', config, setupType);
  if (!freshness.fresh) {
    return buildStrategyRejection(setupType, setupFamily, `trend_pullback_short:${freshness.reason}`);
  }

  const entryStateVector = buildEntryStateVector(snap, lob, 'short', setupType, {
    regime: classifyRegime(snap),
    orderflowBuffer,
  });
  if (!entryStateVector) {
    return buildStrategyRejection(setupType, setupFamily, 'trend_pullback_short:state_vector_unavailable');
  }

  const zEma9 = entryStateVector.z_ema9;
  if (zEma9 === null || zEma9 < QUANT_TP_Z_EMA9_MIN || zEma9 > QUANT_TP_Z_EMA9_MAX) {
    return buildStrategyRejection(setupType, setupFamily, 'trend_pullback_short:z_ema9_out_of_band');
  }
  const pbRatio = entryStateVector.pullback_ratio;
  if (pbRatio !== null && (pbRatio < QUANT_TP_PULLBACK_RATIO_MIN || pbRatio > QUANT_TP_PULLBACK_RATIO_MAX)) {
    return buildStrategyRejection(setupType, setupFamily, 'trend_pullback_short:pullback_ratio_out_of_band');
  }
  const zFlow = entryStateVector.z_ofi_blend;
  if (zFlow !== null && zFlow < QUANT_TP_FLOW_CONFIRMATION_MIN) {
    return buildStrategyRejection(setupType, setupFamily, 'trend_pullback_short:flow_confirmation_below_threshold');
  }

  const sigma = entryStateVector.sigma_pts;
  const entryHalfBand = sigma * QUANT_TP_ENTRY_HALF_BAND_SIGMA;
  const entryLow = snap.price - entryHalfBand;
  const entryHigh = snap.price + entryHalfBand;
  const entryMid = snap.price;
  const stop = entryMid + sigma * QUANT_TP_K_SL;
  const riskPts = stop - entryMid;
  if (!(riskPts > 0)) {
    return buildStrategyRejection(setupType, setupFamily, 'trend_pullback_short:non_positive_risk');
  }
  if (!hasRoomToDownside(snap, entryMid, 1.0)) {
    return buildStrategyRejection(setupType, setupFamily, 'trend_pullback_short:insufficient_downside_room');
  }

  const t1 = clampTarget(ind.smart_money_choch_buy ?? snap.key_levels.choch_buy ?? null, entryMid, riskPts, 2, 'short');
  const t2 = clampTarget(snap.key_levels.pivot_support[0] ?? null, entryMid, riskPts, 4, 'short');
  const rrT1 = computeRr(t1, entryMid, riskPts, 'short');
  const rrT2 = computeRr(t2, entryMid, riskPts, 'short');
  if (rrT1 < 1 || rrT2 <= 0) {
    return buildStrategyRejection(setupType, setupFamily, 'trend_pullback_short:targets_invalid');
  }

  const confidence = clampConfidence(
    8.05 +
      (zFlow ?? 0) * 0.15 +
      (pbRatio !== null ? (0.45 - Math.abs(pbRatio - 0.45)) * 0.5 : 0),
  );

  const candidate = {
    direction: 'short' as const,
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
      'ema_stack_bearish',
      'supertrend_down',
      freshness.reason,
      'downside_room_confirmed',
    ],
    reason: `Trend pullback short around EMA cluster with sigma-based stop ${round4(stop)}`,
    freshness,
    entry_state_vector: entryStateVector,
    ...validateSetupTargets({
      direction: 'short',
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
