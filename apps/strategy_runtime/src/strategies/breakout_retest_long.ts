import {
  DEFAULT_BREAKOUT_RETEST_LONG_CONFIG,
  getStrategyParameters,
} from '../config/index.js';
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

export const BREAKOUT_RETEST_LONG_DEFAULTS = DEFAULT_BREAKOUT_RETEST_LONG_CONFIG;

export function generateBreakoutRetestLong(
  input: StrategyEvaluationInput,
): StrategyGenerationResult {
  if (input.strategy_id !== 'breakout_retest_long') {
    throw new Error(`breakout_retest_long generator received ${input.strategy_id}`);
  }

  const { snapshot } = input;
  const parameters = getStrategyParameters(input.strategy_config, 'breakout_retest_long');
  const reasons: string[] = [];
  const rejection = firstBreakoutRetestLongRejection(snapshot, parameters, reasons);
  if (rejection !== undefined) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [rejection, ...reasons]),
    };
  }

  const sigmaPts = getRequiredNumber(snapshot.indicators, 'sigma_pts');
  const ema9 = getRequiredNumber(snapshot.indicators, 'ema_9');
  const ema21 = getRequiredNumber(snapshot.indicators, 'ema_21');
  const price = snapshot.quote.mid_px;
  const entryLow = Math.min(ema9, price - sigmaPts * parameters.entry_low_sigma_buffer);
  const entryHigh = price + sigmaPts * parameters.entry_high_sigma_buffer;
  const entryMid = (entryLow + entryHigh) / 2;
  const stopPrice = roundToTick(
    ema21 - sigmaPts * parameters.stop_ema21_sigma_buffer,
    snapshot.instrument.tick_size,
  );
  const riskPts = entryMid - stopPrice;
  if (!(riskPts > 0)) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [
        'breakout_retest_long:non_positive_risk',
        ...reasons,
      ]),
    };
  }

  const target1Source = getOptionalNumber(snapshot.structure.values, 'nearest_resistance')
    ?? getOptionalNumber(snapshot.structure.values, 'pivot_resistance_1');
  const target2Source = getOptionalNumber(snapshot.structure.values, 'pivot_resistance_1')
    ?? target1Source;
  if (target1Source === undefined) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [
        'breakout_retest_long:nearest_resistance_missing',
        ...reasons,
      ]),
    };
  }
  if (computeLongRr(target1Source, entryMid, riskPts) < parameters.minimum_target_1_rr) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [
        'breakout_retest_long:insufficient_upside_room',
        ...reasons,
      ]),
    };
  }
  if (
    target2Source !== undefined
    && computeLongRr(target2Source, entryMid, riskPts) <= parameters.minimum_target_2_rr
  ) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [
        'breakout_retest_long:targets_invalid',
        ...reasons,
      ]),
    };
  }

  const targets = buildLongTargets(
    entryMid,
    riskPts,
    target1Source,
    target2Source,
    parameters,
    snapshot.instrument.tick_size,
  );
  if (
    targets[0] === undefined
    || targets[1] === undefined
    || computeLongRr(targets[0].price, entryMid, riskPts) < parameters.minimum_target_1_rr
    || computeLongRr(targets[1].price, entryMid, riskPts) <= parameters.minimum_target_2_rr
  ) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [
        'breakout_retest_long:targets_invalid',
        ...reasons,
      ]),
    };
  }

  const confidence = round4(parameters.confidence_score / 10);
  const candidate: Candidate = {
    candidate_id: makeCandidateId(`candidate-${snapshot.feature_snapshot_id}-breakout_retest_long`),
    strategy_id: 'breakout_retest_long',
    setup_type: 'breakout_retest_long',
    setup_family: 'breakout_retest',
    instrument: snapshot.instrument,
    feature_snapshot_id: snapshot.feature_snapshot_id,
    direction: 'long',
    status: 'proposed',
    proposed_ts_ns: snapshot.created_ts_ns,
    entry_price: roundToTick(entryMid, snapshot.instrument.tick_size),
    stop_price: stopPrice,
    risk_points: round4(riskPts),
    targets,
    reward_risk: targets.map((target) => ({
      label: target.label,
      reward_risk: round4(computeLongRr(target.price, entryMid, riskPts)),
    })),
    confidence,
    config: snapshot.config,
    reasons: [
      'breakout_retest_long:armed',
      'breakout_retest_long:ema_stack_bullish',
      'breakout_retest_long:breakout_confirmed',
      'breakout_retest_long:retest_hold',
      'breakout_retest_long:flow_positive',
      ...reasons,
    ],
  };

  return {
    evaluation: makeEvaluation(snapshot, 'armed', confidence, [
      'breakout_retest_long:armed',
      ...candidate.reasons,
    ]),
    candidate,
  };
}

function firstBreakoutRetestLongRejection(
  snapshot: StrategyFeatureSnapshot,
  parameters: typeof BREAKOUT_RETEST_LONG_DEFAULTS,
  reasons: string[],
): string | undefined {
  if (!snapshot.session.is_rth) {
    return 'breakout_retest_long:session_not_rth';
  }
  if (snapshot.session.is_halt) {
    return 'breakout_retest_long:session_halted';
  }
  if (snapshot.session.is_roll_block) {
    return 'breakout_retest_long:roll_block_active';
  }
  if (snapshot.structure.trend !== 'up') {
    return 'breakout_retest_long:structure_trend_not_up';
  }

  const supertrendDirection = snapshot.indicators.supertrend_direction;
  if (supertrendDirection !== 'up') {
    return 'breakout_retest_long:supertrend_not_up';
  }

  const ema9 = getRequiredNumber(snapshot.indicators, 'ema_9');
  const ema21 = getRequiredNumber(snapshot.indicators, 'ema_21');
  const ema50 = getRequiredNumber(snapshot.indicators, 'ema_50');
  const price = snapshot.quote.mid_px;
  if (!(price > ema9 && ema9 > ema21 && ema21 > ema50)) {
    return 'breakout_retest_long:ema_stack_not_bullish';
  }
  reasons.push('ema_stack_bullish');

  const sigmaPts = getRequiredNumber(snapshot.indicators, 'sigma_pts');
  if (!(sigmaPts > 0)) {
    return 'breakout_retest_long:sigma_pts_invalid';
  }

  const breakoutLevel = getOptionalNumber(snapshot.structure.values, 'breakout_level');
  if (breakoutLevel === undefined) {
    return 'breakout_retest_long:breakout_level_missing';
  }
  if (price <= breakoutLevel) {
    return 'breakout_retest_long:not_above_breakout_level';
  }
  reasons.push('breakout_confirmed');

  if (snapshot.structure.values.retest_hold !== true) {
    return 'breakout_retest_long:retest_not_confirmed';
  }

  const distanceFromBreakout = price - breakoutLevel;
  if (distanceFromBreakout > sigmaPts * parameters.max_retest_distance_sigma) {
    return 'breakout_retest_long:retest_distance_out_of_band';
  }
  const ema9Distance = price - ema9;
  if (ema9Distance < 0 || ema9Distance > sigmaPts * parameters.max_retest_distance_sigma) {
    return 'breakout_retest_long:not_near_ema9';
  }
  reasons.push('retest_hold');

  const upsideFlow = getOptionalNumber(snapshot.indicators, 'z_ofi_blend')
    ?? getOptionalNumber(snapshot.microstructure.values, 'ofi_z');
  if (upsideFlow !== undefined && upsideFlow < parameters.flow_confirmation_min) {
    return 'breakout_retest_long:flow_confirmation_below_threshold';
  }
  reasons.push('flow_positive');

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
      `eval-${snapshot.feature_snapshot_id}-breakout_retest_long`,
    ),
    strategy_id: 'breakout_retest_long',
    instrument: snapshot.instrument,
    feature_snapshot_id: snapshot.feature_snapshot_id,
    evaluated_ts_ns: snapshot.created_ts_ns,
    gate_state: gateState,
    ...(score === undefined ? {} : { score }),
    reasons,
    config: snapshot.config,
  };
}

function buildLongTargets(
  entryPrice: number,
  riskPts: number,
  target1Source: number,
  target2Source: number | undefined,
  parameters: typeof BREAKOUT_RETEST_LONG_DEFAULTS,
  tickSize: number,
): readonly PriceTarget[] {
  const pt1 = clampLongTarget(
    target1Source,
    entryPrice,
    riskPts,
    parameters.default_target_1_rr,
    tickSize,
  );
  const pt2 = clampLongTarget(
    target2Source,
    entryPrice,
    riskPts,
    parameters.default_target_2_rr,
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

function clampLongTarget(
  rawTarget: number | undefined,
  entryPrice: number,
  riskPts: number,
  fallbackRr: number,
  tickSize: number,
): number {
  const fallback = entryPrice + riskPts * fallbackRr;
  if (rawTarget === undefined || rawTarget <= entryPrice) {
    return roundToTick(fallback, tickSize);
  }
  return roundToTick(Math.max(rawTarget, fallback), tickSize);
}

function computeLongRr(targetPrice: number, entryPrice: number, riskPts: number): number {
  if (!(riskPts > 0)) {
    return 0;
  }
  return (targetPrice - entryPrice) / riskPts;
}

function getRequiredNumber(values: StrategyScalarMap, key: string): number {
  const value = values[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`breakout_retest_long requires numeric ${key}`);
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
