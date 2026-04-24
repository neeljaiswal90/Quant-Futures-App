import {
  makeCandidateId,
  makeStrategyEvaluationId,
  type Candidate,
  type PriceTarget,
  type StrategyEvaluation,
} from '../contracts/index.js';
import type {
  StrategyEvaluationInput,
  StrategyFeatureSnapshot,
  StrategyGenerationResult,
  StrategyScalarMap,
} from './types.js';

export const BREAKDOWN_RETEST_SHORT_DEFAULTS = {
  max_retest_distance_sigma: 1.15,
  flow_confirmation_min: 0.2,
  stop_ema21_sigma_buffer: 0.5,
  entry_low_sigma_buffer: 0.15,
  entry_high_sigma_buffer: 0.1,
  minimum_target_1_rr: 1,
  minimum_target_2_rr: 0,
  default_target_1_rr: 2,
  default_target_2_rr: 4,
  confidence_score: 8.05,
} as const;

export function generateBreakdownRetestShort(
  input: StrategyEvaluationInput,
): StrategyGenerationResult {
  if (input.strategy_id !== 'breakdown_retest_short') {
    throw new Error(`breakdown_retest_short generator received ${input.strategy_id}`);
  }

  const { snapshot } = input;
  const reasons: string[] = [];
  const rejection = firstBreakdownRetestShortRejection(snapshot, reasons);
  if (rejection !== undefined) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [rejection, ...reasons]),
    };
  }

  const sigmaPts = getRequiredNumber(snapshot.indicators, 'sigma_pts');
  const ema9 = getRequiredNumber(snapshot.indicators, 'ema_9');
  const ema21 = getRequiredNumber(snapshot.indicators, 'ema_21');
  const price = snapshot.quote.mid_px;
  const entryLow = price - sigmaPts * BREAKDOWN_RETEST_SHORT_DEFAULTS.entry_low_sigma_buffer;
  const entryHigh = Math.max(ema9, price + sigmaPts * BREAKDOWN_RETEST_SHORT_DEFAULTS.entry_high_sigma_buffer);
  const entryMid = (entryLow + entryHigh) / 2;
  const stopPrice = roundToTick(
    ema21 + sigmaPts * BREAKDOWN_RETEST_SHORT_DEFAULTS.stop_ema21_sigma_buffer,
    snapshot.instrument.tick_size,
  );
  const riskPts = stopPrice - entryMid;
  if (!(riskPts > 0)) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [
        'breakdown_retest_short:non_positive_risk',
        ...reasons,
      ]),
    };
  }

  const target1Source = getOptionalNumber(snapshot.structure.values, 'choch_buy')
    ?? getOptionalNumber(snapshot.structure.values, 'nearest_support');
  const target2Source = getOptionalNumber(snapshot.structure.values, 'pivot_support_1')
    ?? getOptionalNumber(snapshot.structure.values, 'nearest_support')
    ?? target1Source;
  if (target1Source === undefined) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [
        'breakdown_retest_short:nearest_support_missing',
        ...reasons,
      ]),
    };
  }
  if (computeShortRr(target1Source, entryMid, riskPts) < BREAKDOWN_RETEST_SHORT_DEFAULTS.minimum_target_1_rr) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [
        'breakdown_retest_short:insufficient_downside_room',
        ...reasons,
      ]),
    };
  }
  if (
    target2Source !== undefined
    && computeShortRr(target2Source, entryMid, riskPts) <= BREAKDOWN_RETEST_SHORT_DEFAULTS.minimum_target_2_rr
  ) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [
        'breakdown_retest_short:targets_invalid',
        ...reasons,
      ]),
    };
  }

  const targets = buildShortTargets(
    entryMid,
    riskPts,
    target1Source,
    target2Source,
    snapshot.instrument.tick_size,
  );
  if (
    targets[0] === undefined
    || targets[1] === undefined
    || computeShortRr(targets[0].price, entryMid, riskPts) < BREAKDOWN_RETEST_SHORT_DEFAULTS.minimum_target_1_rr
    || computeShortRr(targets[1].price, entryMid, riskPts) <= BREAKDOWN_RETEST_SHORT_DEFAULTS.minimum_target_2_rr
  ) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [
        'breakdown_retest_short:targets_invalid',
        ...reasons,
      ]),
    };
  }

  const confidence = round4(BREAKDOWN_RETEST_SHORT_DEFAULTS.confidence_score / 10);
  const candidate: Candidate = {
    candidate_id: makeCandidateId(`candidate-${snapshot.feature_snapshot_id}-breakdown_retest_short`),
    strategy_id: 'breakdown_retest_short',
    setup_type: 'breakdown_retest_short',
    setup_family: 'breakout_retest',
    instrument: snapshot.instrument,
    feature_snapshot_id: snapshot.feature_snapshot_id,
    direction: 'short',
    status: 'proposed',
    proposed_ts_ns: snapshot.created_ts_ns,
    entry_price: roundToTick(entryMid, snapshot.instrument.tick_size),
    stop_price: stopPrice,
    risk_points: round4(riskPts),
    targets,
    reward_risk: targets.map((target) => ({
      label: target.label,
      reward_risk: round4(computeShortRr(target.price, entryMid, riskPts)),
    })),
    confidence,
    config: snapshot.config,
    reasons: [
      'breakdown_retest_short:armed',
      'breakdown_retest_short:ema_stack_bearish',
      'breakdown_retest_short:breakdown_confirmed',
      'breakdown_retest_short:retest_reject',
      'breakdown_retest_short:flow_negative',
      ...reasons,
    ],
  };

  return {
    evaluation: makeEvaluation(snapshot, 'armed', confidence, [
      'breakdown_retest_short:armed',
      ...candidate.reasons,
    ]),
    candidate,
  };
}

function firstBreakdownRetestShortRejection(
  snapshot: StrategyFeatureSnapshot,
  reasons: string[],
): string | undefined {
  if (!snapshot.session.is_rth) {
    return 'breakdown_retest_short:session_not_rth';
  }
  if (snapshot.session.is_halt) {
    return 'breakdown_retest_short:session_halted';
  }
  if (snapshot.session.is_roll_block) {
    return 'breakdown_retest_short:roll_block_active';
  }
  if (snapshot.structure.trend !== 'down') {
    return 'breakdown_retest_short:structure_trend_not_down';
  }

  const supertrendDirection = snapshot.indicators.supertrend_direction;
  if (supertrendDirection !== 'down') {
    return 'breakdown_retest_short:supertrend_not_down';
  }

  const ema9 = getRequiredNumber(snapshot.indicators, 'ema_9');
  const ema21 = getRequiredNumber(snapshot.indicators, 'ema_21');
  const ema50 = getRequiredNumber(snapshot.indicators, 'ema_50');
  const price = snapshot.quote.mid_px;
  if (!(price < ema9 && ema9 < ema21 && ema21 < ema50)) {
    return 'breakdown_retest_short:ema_stack_not_bearish';
  }
  reasons.push('ema_stack_bearish');

  const sigmaPts = getRequiredNumber(snapshot.indicators, 'sigma_pts');
  if (!(sigmaPts > 0)) {
    return 'breakdown_retest_short:sigma_pts_invalid';
  }

  const brokenSupport = getOptionalNumber(snapshot.structure.values, 'broken_support');
  if (brokenSupport === undefined) {
    return 'breakdown_retest_short:broken_support_missing';
  }
  if (price >= brokenSupport) {
    return 'breakdown_retest_short:not_below_broken_support';
  }
  reasons.push('breakdown_confirmed');

  if (snapshot.structure.values.retest_reject !== true) {
    return 'breakdown_retest_short:retest_not_rejected';
  }

  const distanceFromBrokenSupport = brokenSupport - price;
  if (distanceFromBrokenSupport > sigmaPts * BREAKDOWN_RETEST_SHORT_DEFAULTS.max_retest_distance_sigma) {
    return 'breakdown_retest_short:retest_distance_out_of_band';
  }
  const ema9Distance = ema9 - price;
  if (ema9Distance < 0 || ema9Distance > sigmaPts * BREAKDOWN_RETEST_SHORT_DEFAULTS.max_retest_distance_sigma) {
    return 'breakdown_retest_short:not_near_ema9';
  }
  reasons.push('retest_reject');

  const downsideFlow = getDownsideFlowConfirmation(snapshot);
  if (
    downsideFlow !== undefined
    && downsideFlow < BREAKDOWN_RETEST_SHORT_DEFAULTS.flow_confirmation_min
  ) {
    return 'breakdown_retest_short:flow_confirmation_below_threshold';
  }
  reasons.push('flow_negative');

  return undefined;
}

function makeEvaluation(
  snapshot: StrategyFeatureSnapshot,
  gateState: StrategyEvaluation['gate_state'],
  score: number | undefined,
  reasons: readonly string[],
): StrategyEvaluation {
  return {
    strategy_evaluation_id: makeStrategyEvaluationId(
      `eval-${snapshot.feature_snapshot_id}-breakdown_retest_short`,
    ),
    strategy_id: 'breakdown_retest_short',
    instrument: snapshot.instrument,
    feature_snapshot_id: snapshot.feature_snapshot_id,
    evaluated_ts_ns: snapshot.created_ts_ns,
    gate_state: gateState,
    ...(score === undefined ? {} : { score }),
    reasons,
    config: snapshot.config,
  };
}

function buildShortTargets(
  entryPrice: number,
  riskPts: number,
  target1Source: number,
  target2Source: number | undefined,
  tickSize: number,
): readonly PriceTarget[] {
  const pt1 = clampShortTarget(
    target1Source,
    entryPrice,
    riskPts,
    BREAKDOWN_RETEST_SHORT_DEFAULTS.default_target_1_rr,
    tickSize,
  );
  const pt2 = clampShortTarget(
    target2Source,
    entryPrice,
    riskPts,
    BREAKDOWN_RETEST_SHORT_DEFAULTS.default_target_2_rr,
    tickSize,
  );

  return [
    {
      label: 'pt1',
      price: pt1,
      quantity_fraction: 0.5,
    },
    {
      label: 'pt2',
      price: pt2,
      quantity_fraction: 0.5,
    },
  ];
}

function clampShortTarget(
  rawTarget: number | undefined,
  entryPrice: number,
  riskPts: number,
  fallbackRr: number,
  tickSize: number,
): number {
  const fallback = entryPrice - riskPts * fallbackRr;
  if (rawTarget === undefined || rawTarget >= entryPrice) {
    return roundToTick(fallback, tickSize);
  }
  return roundToTick(Math.min(rawTarget, fallback), tickSize);
}

function getDownsideFlowConfirmation(snapshot: StrategyFeatureSnapshot): number | undefined {
  const blended = getOptionalNumber(snapshot.indicators, 'z_ofi_blend');
  if (blended !== undefined) {
    return blended;
  }

  const microOfi = getOptionalNumber(snapshot.microstructure.values, 'ofi_z');
  return microOfi === undefined ? undefined : -microOfi;
}

function computeShortRr(targetPrice: number, entryPrice: number, riskPts: number): number {
  if (!(riskPts > 0)) {
    return 0;
  }
  return (entryPrice - targetPrice) / riskPts;
}

function getRequiredNumber(values: StrategyScalarMap, key: string): number {
  const value = values[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`breakdown_retest_short requires numeric ${key}`);
  }
  return value;
}

function getOptionalNumber(values: StrategyScalarMap, key: string): number | undefined {
  const value = values[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function roundToTick(value: number, tickSize: number): number {
  return round4(Math.round(value / tickSize) * tickSize);
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
