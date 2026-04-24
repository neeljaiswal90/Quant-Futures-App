import {
  DEFAULT_TREND_PULLBACK_LONG_CONFIG,
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

export const TREND_PULLBACK_LONG_DEFAULTS = DEFAULT_TREND_PULLBACK_LONG_CONFIG;

export function generateTrendPullbackLong(
  input: StrategyEvaluationInput,
): StrategyGenerationResult {
  if (input.strategy_id !== 'trend_pullback_long') {
    throw new Error(`trend_pullback_long generator received ${input.strategy_id}`);
  }

  const { snapshot } = input;
  const parameters = getStrategyParameters(input.strategy_config, 'trend_pullback_long');
  const reasons: string[] = [];
  const rejection = firstTrendPullbackLongRejection(snapshot, parameters, reasons);
  if (rejection !== undefined) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [rejection, ...reasons]),
    };
  }

  const sigmaPts = getRequiredNumber(snapshot.indicators, 'sigma_pts');
  const entryMid = snapshot.quote.mid_px;
  const entryHalfBand = sigmaPts * parameters.entry_half_band_sigma;
  const stopPrice = roundToTick(
    entryMid - sigmaPts * parameters.stop_sigma_multiple,
    snapshot.instrument.tick_size,
  );
  const riskPts = entryMid - stopPrice;
  if (!(riskPts > 0)) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [
        'trend_pullback_long:non_positive_risk',
        ...reasons,
      ]),
    };
  }

  const target1Source = getOptionalNumber(snapshot.structure.values, 'choch_sell')
    ?? getOptionalNumber(snapshot.structure.values, 'nearest_resistance');
  const target2Source = getOptionalNumber(snapshot.structure.values, 'nearest_resistance');
  const targets = buildLongTargets(
    entryMid,
    riskPts,
    target1Source,
    target2Source,
    parameters,
    snapshot.instrument.tick_size,
  );
  if (targets[0] === undefined || computeLongRr(targets[0].price, entryMid, riskPts) < parameters.minimum_target_rr) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [
        'trend_pullback_long:targets_invalid',
        ...reasons,
      ]),
    };
  }

  const confidence = computeConfidence(snapshot, parameters);
  const candidate: Candidate = {
    candidate_id: makeCandidateId(`candidate-${snapshot.feature_snapshot_id}-trend_pullback_long`),
    strategy_id: 'trend_pullback_long',
    setup_type: 'trend_pullback_long',
    setup_family: 'trend_pullback',
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
      'trend_pullback_long:armed',
      'trend_pullback_long:ema_stack_bullish',
      'trend_pullback_long:pullback_geometry_valid',
      'trend_pullback_long:flow_positive',
      ...reasons,
    ],
  };

  return {
    evaluation: makeEvaluation(snapshot, 'armed', confidence, [
      'trend_pullback_long:armed',
      ...candidate.reasons,
    ]),
    candidate,
  };
}

function firstTrendPullbackLongRejection(
  snapshot: StrategyFeatureSnapshot,
  parameters: typeof TREND_PULLBACK_LONG_DEFAULTS,
  reasons: string[],
): string | undefined {
  if (!snapshot.session.is_rth) {
    return 'trend_pullback_long:session_not_rth';
  }
  if (snapshot.session.is_halt) {
    return 'trend_pullback_long:session_halted';
  }
  if (snapshot.session.is_roll_block) {
    return 'trend_pullback_long:roll_block_active';
  }
  if (snapshot.structure.trend !== 'up') {
    return 'trend_pullback_long:structure_trend_not_up';
  }

  const supertrendDirection = snapshot.indicators.supertrend_direction;
  if (supertrendDirection !== 'up') {
    return 'trend_pullback_long:supertrend_not_up';
  }

  const ema9 = getRequiredNumber(snapshot.indicators, 'ema_9');
  const ema21 = getRequiredNumber(snapshot.indicators, 'ema_21');
  const ema50 = getRequiredNumber(snapshot.indicators, 'ema_50');
  if (!(ema9 > ema21 && ema21 > ema50)) {
    return 'trend_pullback_long:ema_stack_not_bullish';
  }
  reasons.push('ema_stack_bullish');

  const sigmaPts = getRequiredNumber(snapshot.indicators, 'sigma_pts');
  if (!(sigmaPts > 0)) {
    return 'trend_pullback_long:sigma_pts_invalid';
  }

  const zEma9 = getRequiredNumber(snapshot.indicators, 'z_ema9');
  if (zEma9 < parameters.z_ema9_min || zEma9 > parameters.z_ema9_max) {
    return 'trend_pullback_long:z_ema9_out_of_band';
  }

  const pullbackRatio = getRequiredNumber(snapshot.indicators, 'pullback_ratio');
  if (
    pullbackRatio < parameters.pullback_ratio_min
    || pullbackRatio > parameters.pullback_ratio_max
  ) {
    return 'trend_pullback_long:pullback_ratio_out_of_band';
  }
  reasons.push('pullback_geometry_valid');

  const zFlow = getOptionalNumber(snapshot.indicators, 'z_ofi_blend')
    ?? getOptionalNumber(snapshot.microstructure.values, 'ofi_z');
  if (zFlow !== undefined && zFlow < parameters.flow_confirmation_min) {
    return 'trend_pullback_long:flow_confirmation_below_threshold';
  }
  reasons.push('flow_positive');

  const nearestResistance = getOptionalNumber(snapshot.structure.values, 'nearest_resistance');
  if (nearestResistance !== undefined) {
    const riskPts = sigmaPts * parameters.stop_sigma_multiple;
    if (computeLongRr(nearestResistance, snapshot.quote.mid_px, riskPts) < parameters.minimum_target_rr) {
      return 'trend_pullback_long:insufficient_upside_room';
    }
    reasons.push('upside_room_confirmed');
  }

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
      `eval-${snapshot.feature_snapshot_id}-trend_pullback_long`,
    ),
    strategy_id: 'trend_pullback_long',
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
  target1Source: number | undefined,
  target2Source: number | undefined,
  parameters: typeof TREND_PULLBACK_LONG_DEFAULTS,
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

function computeConfidence(
  snapshot: StrategyFeatureSnapshot,
  parameters: typeof TREND_PULLBACK_LONG_DEFAULTS,
): number {
  const zFlow = getOptionalNumber(snapshot.indicators, 'z_ofi_blend')
    ?? getOptionalNumber(snapshot.microstructure.values, 'ofi_z')
    ?? 0;
  const pullbackRatio = getOptionalNumber(snapshot.indicators, 'pullback_ratio') ?? 0.45;
  const legacyScore =
    parameters.base_confidence_score
    + zFlow * 0.15
    + (0.45 - Math.abs(pullbackRatio - 0.45)) * 0.5;
  return clamp(round4(legacyScore / 10), 0, 1);
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
    throw new Error(`trend_pullback_long requires numeric ${key}`);
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
