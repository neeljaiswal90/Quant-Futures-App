import {
  DEFAULT_REGIME_SHOCK_REVERSION_SHORT_V5_TRAIL_AT_DEADLINE_CONFIG,
  getStrategyParameters,
  type RegimeMeanReversionStrategyParameters,
} from '../config/index.js';
import {
  makeCandidateId,
  makeStrategyEvaluationId,
  type Candidate,
  type PriceTarget,
  type StrategyEvaluation,
} from '../contracts/index.js';
import {
  isTradingRegime,
  validateRegimeMeanReversionParameters,
} from './regime_mean_reversion_common.js';
import type {
  StrategyEvaluationInput,
  StrategyFeatureSnapshot,
  StrategyGenerationResult,
  StrategyScalarMap,
} from './types.js';

export const REGIME_SHOCK_REVERSION_SHORT_V5_TRAIL_AT_DEADLINE_DEFAULTS =
  DEFAULT_REGIME_SHOCK_REVERSION_SHORT_V5_TRAIL_AT_DEADLINE_CONFIG;

export function generateRegimeShockReversionShortV5TrailAtDeadline(
  input: StrategyEvaluationInput,
): StrategyGenerationResult {
  if (input.strategy_id !== 'regime_shock_reversion_short_v5_trail_at_deadline') {
    throw new Error(`regime_shock_reversion_short_v5_trail_at_deadline generator received ${input.strategy_id}`);
  }

  const { snapshot } = input;
  const parameters = getStrategyParameters(input.strategy_config, 'regime_shock_reversion_short_v5_trail_at_deadline');
  const reasons: string[] = [];
  const rejection = firstRegimeShockReversionShortV5TrailAtDeadlineRejection(snapshot, parameters, reasons);
  if (rejection !== undefined) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [rejection, ...reasons]),
    };
  }

  const sigmaPts = getRequiredNumber(snapshot.indicators, 'sigma_pts');
  const entryPrice = roundToTick(snapshot.quote.mid_px, snapshot.instrument.tick_size);
  const stopPrice = roundToTick(
    entryPrice + sigmaPts * parameters.stop_sigma_multiple,
    snapshot.instrument.tick_size,
  );
  const riskPts = stopPrice - entryPrice;
  if (!(riskPts > 0)) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [
        'regime_shock_reversion_short_v5_trail_at_deadline:non_positive_risk',
        ...reasons,
      ]),
    };
  }

  const targets = buildShortTargets(entryPrice, riskPts, parameters, snapshot.instrument.tick_size);
  if (
    targets[0] === undefined
    || computeShortRr(targets[0].price, entryPrice, riskPts) < parameters.minimum_target_rr
  ) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [
        'regime_shock_reversion_short_v5_trail_at_deadline:targets_invalid',
        ...reasons,
      ]),
    };
  }

  const confidence = computeConfidence(snapshot, parameters);
  const candidate: Candidate = {
    candidate_id: makeCandidateId(`candidate-${snapshot.feature_snapshot_id}-regime_shock_reversion_short_v5_trail_at_deadline`),
    strategy_id: 'regime_shock_reversion_short_v5_trail_at_deadline',
    setup_type: 'regime_shock_reversion_short_v5_trail_at_deadline',
    setup_family: 'regime_shock_reversion',
    instrument: snapshot.instrument,
    feature_snapshot_id: snapshot.feature_snapshot_id,
    direction: 'short',
    status: 'proposed',
    proposed_ts_ns: snapshot.created_ts_ns,
    entry_price: entryPrice,
    stop_price: stopPrice,
    risk_points: round4(riskPts),
    targets,
    reward_risk: targets.map((target) => ({
      label: target.label,
      reward_risk: round4(computeShortRr(target.price, entryPrice, riskPts)),
    })),
    confidence,
    config: snapshot.config,
    reasons: [
      'regime_shock_reversion_short_v5_trail_at_deadline:armed',
      `regime_shock_reversion_short_v5_trail_at_deadline:regime_${snapshot.context.regime_label}`,
      ...reasons,
    ],
  };

  return {
    evaluation: makeEvaluation(snapshot, 'armed', confidence, [
      'regime_shock_reversion_short_v5_trail_at_deadline:armed',
      ...candidate.reasons,
    ]),
    candidate,
  };
}

export function firstRegimeShockReversionShortV5TrailAtDeadlineRejection(
  snapshot: StrategyFeatureSnapshot,
  parameters: RegimeMeanReversionStrategyParameters,
  reasons: string[] = [],
): string | undefined {
  const parameterIssues = validateRegimeMeanReversionParameters(parameters);
  if (parameterIssues[0] !== undefined) {
    return `regime_shock_reversion_short_v5_trail_at_deadline:${parameterIssues[0]}`;
  }
  if (!snapshot.session.is_rth) {
    return 'regime_shock_reversion_short_v5_trail_at_deadline:session_not_rth';
  }
  if (snapshot.session.is_halt) {
    return 'regime_shock_reversion_short_v5_trail_at_deadline:session_halted';
  }
  if (snapshot.session.is_roll_block) {
    return 'regime_shock_reversion_short_v5_trail_at_deadline:roll_block_active';
  }

  const regime = snapshot.context.regime_label;
  if (regime === 'unknown') {
    return 'regime_shock_reversion_short_v5_trail_at_deadline:missing_regime_label';
  }
  if (!isTradingRegime(regime)) {
    return 'regime_shock_reversion_short_v5_trail_at_deadline:regime_state_non_trading';
  }

  const shock = snapshot.context.signed_shock_vwap.value;
  if (shock === null) {
    return 'regime_shock_reversion_short_v5_trail_at_deadline:signed_shock_unavailable_warmup';
  }
  reasons.push(`signed_shock_vwap:${round4(shock)}`);

  if (regime === 'high' && shock < parameters.high_shock_threshold_pos) {
    return 'regime_shock_reversion_short_v5_trail_at_deadline:high_regime_shock_below_pos_threshold';
  }
  if (regime === 'low' && shock < parameters.low_shock_threshold_pos) {
    return 'regime_shock_reversion_short_v5_trail_at_deadline:low_regime_shock_below_strict_pos_threshold';
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
      `eval-${snapshot.feature_snapshot_id}-regime_shock_reversion_short_v5_trail_at_deadline`,
    ),
    strategy_id: 'regime_shock_reversion_short_v5_trail_at_deadline',
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
  parameters: RegimeMeanReversionStrategyParameters,
  tickSize: number,
): readonly PriceTarget[] {
  return [
    {
      label: 'pt1',
      price: roundToTick(entryPrice - riskPts * parameters.target_1_rr, tickSize),
      quantity_fraction: 0.5,
    },
    {
      label: 'pt2',
      price: roundToTick(entryPrice - riskPts * parameters.target_2_rr, tickSize),
      quantity_fraction: 0.5,
    },
  ];
}

function computeConfidence(
  snapshot: StrategyFeatureSnapshot,
  parameters: RegimeMeanReversionStrategyParameters,
): number {
  return clamp(round4(
    snapshot.context.regime_label === 'high'
      ? parameters.confidence_score_high
      : parameters.confidence_score_low,
  ), 0, 1);
}

function computeShortRr(targetPrice: number, entryPrice: number, riskPts: number): number {
  return riskPts > 0 ? (entryPrice - targetPrice) / riskPts : 0;
}

function getRequiredNumber(values: StrategyScalarMap, key: string): number {
  const value = values[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`regime_shock_reversion_short_v5_trail_at_deadline requires numeric ${key}`);
  }
  return value;
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
