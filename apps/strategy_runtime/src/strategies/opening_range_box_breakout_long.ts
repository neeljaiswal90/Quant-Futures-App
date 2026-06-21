import {
  DEFAULT_OPENING_RANGE_BOX_BREAKOUT_LONG_CONFIG,
  getStrategyParameters,
  type OpeningRangeBoxBreakoutLongStrategyParameters,
} from '../config/index.js';
import {
  makeCandidateId,
  makeStrategyEvaluationId,
  type Candidate,
  type PriceTarget,
  type StrategyEvaluation,
} from '../contracts/index.js';
import { unixNsToNewYorkLocalTime } from '../session/time-utils.js';
import type {
  StrategyEvaluationInput,
  StrategyFeatureSnapshot,
  StrategyGenerationResult,
  StrategyScalarMap,
} from './types.js';

export const OPENING_RANGE_BOX_BREAKOUT_LONG_STRATEGY_ID = 'opening_range_box_breakout_long' as const;
export const OPENING_RANGE_BOX_BREAKOUT_LONG_DEFAULTS = DEFAULT_OPENING_RANGE_BOX_BREAKOUT_LONG_CONFIG;
export const OPENING_RANGE_BOX_BREAKOUT_LONG_PRIOR_DOWN_NO_LATE_SHADOW_PROFILE_ID = 'orb_breakout_long_prior_down_no_late_shadow' as const;

const PRIOR_DAY_TREND_STATE_KEYS = [
  'prior_day_trend_state',
  'prior_session_trend_state',
  'previous_day_trend_state',
] as const;
const PRIOR_DOWN_STATES = new Set(['prior_down', 'prior_down_large']);
const TWO_PM_ET_MINUTE_OF_DAY = 14 * 60;

export function generateOpeningRangeBoxBreakoutLong(
  input: StrategyEvaluationInput,
): StrategyGenerationResult {
  if (input.strategy_id !== OPENING_RANGE_BOX_BREAKOUT_LONG_STRATEGY_ID) {
    throw new Error(`opening_range_box_breakout_long generator received ${input.strategy_id}`);
  }
  const parameters = getStrategyParameters(input.strategy_config, OPENING_RANGE_BOX_BREAKOUT_LONG_STRATEGY_ID);
  return buildOpeningRangeBoxBreakoutLongResult(input.snapshot, parameters, []);
}

export function generateOpeningRangeBoxBreakoutLongPriorDownNoLateShadow(
  input: StrategyEvaluationInput,
): StrategyGenerationResult {
  if (input.strategy_id !== OPENING_RANGE_BOX_BREAKOUT_LONG_STRATEGY_ID) {
    throw new Error(`opening_range_box_breakout_long shadow generator received ${input.strategy_id}`);
  }
  const parameters = getStrategyParameters(input.strategy_config, OPENING_RANGE_BOX_BREAKOUT_LONG_STRATEGY_ID);
  const reasons = [
    `shadow_profile:${OPENING_RANGE_BOX_BREAKOUT_LONG_PRIOR_DOWN_NO_LATE_SHADOW_PROFILE_ID}`,
    'shadow_only:no_order_intent_authority',
  ];
  const profileRejection = firstOpeningRangeBoxBreakoutLongPriorDownNoLateShadowRejection(input.snapshot, reasons);
  if (profileRejection !== undefined) {
    return {
      evaluation: makeEvaluation(input.snapshot, 'blocked', undefined, [profileRejection, ...reasons]),
    };
  }
  return buildOpeningRangeBoxBreakoutLongResult(input.snapshot, parameters, reasons);
}

export function firstOpeningRangeBoxBreakoutLongPriorDownNoLateShadowRejection(
  snapshot: StrategyFeatureSnapshot,
  reasons: string[] = [],
): string | undefined {
  const trendState = readPriorDayTrendState(snapshot.structure.values);
  if (trendState === undefined) {
    return 'opening_range_box_breakout_long:shadow_prior_day_trend_unavailable';
  }
  reasons.push(`prior_day_trend_state:${trendState}`);
  if (!PRIOR_DOWN_STATES.has(trendState)) {
    return 'opening_range_box_breakout_long:shadow_prior_day_not_down';
  }

  const local = unixNsToNewYorkLocalTime(snapshot.created_ts_ns);
  const minuteOfDay = local.hour * 60 + local.minute;
  reasons.push(`entry_time_et:${local.hour.toString().padStart(2, '0')}:${local.minute.toString().padStart(2, '0')}`);
  if (minuteOfDay >= TWO_PM_ET_MINUTE_OF_DAY) {
    return 'opening_range_box_breakout_long:shadow_entry_at_or_after_14_00_et';
  }
  reasons.push('entry_before_14_00_et');
  return undefined;
}

function buildOpeningRangeBoxBreakoutLongResult(
  snapshot: StrategyFeatureSnapshot,
  parameters: OpeningRangeBoxBreakoutLongStrategyParameters,
  extraReasons: readonly string[],
): StrategyGenerationResult {
  const reasons: string[] = [...extraReasons];
  const rejection = firstOpeningRangeBoxBreakoutLongRejection(snapshot, parameters, reasons);
  if (rejection !== undefined) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [rejection, ...reasons]),
    };
  }

  const openingRangeHigh = snapshot.context.opening_range_high!;
  const openingRangeLow = snapshot.context.opening_range_low!;
  const tickSize = snapshot.instrument.tick_size;
  const entryPrice = roundToTick(openingRangeHigh + parameters.breakout_buffer_ticks * tickSize, tickSize);
  const stopPrice = roundToTick(openingRangeLow - parameters.stop_buffer_ticks * tickSize, tickSize);
  const riskPts = entryPrice - stopPrice;
  if (!(riskPts > 0)) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [
        'opening_range_box_breakout_long:non_positive_risk',
        ...reasons,
      ]),
    };
  }

  const targets = buildLongTargets(entryPrice, riskPts, parameters, tickSize);
  const confidence = round4(parameters.confidence_score);
  const candidate: Candidate = {
    candidate_id: makeCandidateId(`candidate-${snapshot.feature_snapshot_id}-opening_range_box_breakout_long`),
    strategy_id: OPENING_RANGE_BOX_BREAKOUT_LONG_STRATEGY_ID,
    setup_type: OPENING_RANGE_BOX_BREAKOUT_LONG_STRATEGY_ID,
    setup_family: 'opening_range_box',
    instrument: snapshot.instrument,
    feature_snapshot_id: snapshot.feature_snapshot_id,
    direction: 'long',
    status: 'proposed',
    proposed_ts_ns: snapshot.created_ts_ns,
    entry_price: entryPrice,
    stop_price: stopPrice,
    risk_points: round4(riskPts),
    targets,
    reward_risk: targets.map((target) => ({
      label: target.label,
      reward_risk: round4(computeLongRr(target.price, entryPrice, riskPts)),
    })),
    confidence,
    config: snapshot.config,
    reasons: [
      'opening_range_box_breakout_long:armed',
      `opening_range_minutes:${parameters.opening_range_minutes}`,
      'opening_range_box_breakout_long:breakout_confirmed',
      ...reasons,
    ],
  };

  return {
    evaluation: makeEvaluation(snapshot, 'armed', confidence, [
      'opening_range_box_breakout_long:armed',
      ...candidate.reasons,
    ]),
    candidate,
  };
}

function firstOpeningRangeBoxBreakoutLongRejection(
  snapshot: StrategyFeatureSnapshot,
  parameters: OpeningRangeBoxBreakoutLongStrategyParameters,
  reasons: string[],
): string | undefined {
  if (!snapshot.session.is_rth) {
    return 'opening_range_box_breakout_long:session_not_rth';
  }
  if (snapshot.session.is_halt) {
    return 'opening_range_box_breakout_long:session_halted';
  }
  if (snapshot.session.is_roll_block) {
    return 'opening_range_box_breakout_long:roll_block_active';
  }

  const openingRangeHigh = snapshot.context.opening_range_high;
  const openingRangeLow = snapshot.context.opening_range_low;
  if (snapshot.context.opening_range_minutes_elapsed < parameters.opening_range_minutes) {
    return 'opening_range_box_breakout_long:opening_range_not_complete';
  }
  if (!isFiniteNumber(openingRangeHigh) || !isFiniteNumber(openingRangeLow)) {
    return 'opening_range_box_breakout_long:opening_range_box_unavailable';
  }
  if (!(openingRangeHigh > openingRangeLow)) {
    return 'opening_range_box_breakout_long:opening_range_box_invalid';
  }
  reasons.push('opening_range_box_ready');

  const price = snapshot.quote.mid_px;
  if (!isFiniteNumber(price)) {
    return 'opening_range_box_breakout_long:mid_price_unavailable';
  }
  const tickSize = snapshot.instrument.tick_size;
  const breakoutLevel = roundToTick(openingRangeHigh + parameters.breakout_buffer_ticks * tickSize, tickSize);
  if (price < breakoutLevel) {
    return 'opening_range_box_breakout_long:not_above_breakout_level';
  }
  const chaseTicks = (price - breakoutLevel) / tickSize;
  if (chaseTicks > parameters.max_chase_ticks) {
    return 'opening_range_box_breakout_long:chase_too_extended';
  }
  reasons.push('breakout_confirmed');
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
      `eval-${snapshot.feature_snapshot_id}-opening_range_box_breakout_long`,
    ),
    strategy_id: OPENING_RANGE_BOX_BREAKOUT_LONG_STRATEGY_ID,
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
  parameters: OpeningRangeBoxBreakoutLongStrategyParameters,
  tickSize: number,
): readonly PriceTarget[] {
  return [
    {
      label: 'pt1',
      price: roundToTick(entryPrice + riskPts * parameters.target_1_rr, tickSize),
      quantity_fraction: 0.5,
    },
    {
      label: 'pt2',
      price: roundToTick(entryPrice + riskPts * parameters.target_2_rr, tickSize),
      quantity_fraction: 0.5,
    },
  ];
}

function readPriorDayTrendState(values: StrategyScalarMap): string | undefined {
  for (const key of PRIOR_DAY_TREND_STATE_KEYS) {
    const value = values[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return undefined;
}

function computeLongRr(targetPrice: number, entryPrice: number, riskPts: number): number {
  if (!(riskPts > 0)) {
    return 0;
  }
  return (targetPrice - entryPrice) / riskPts;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function roundToTick(value: number, tickSize: number): number {
  return round4(Math.round(value / tickSize) * tickSize);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}