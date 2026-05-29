import {
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
  StrategyFeatureSnapshotRegime,
  StrategyGenerationResult,
  StrategyScalarMap,
} from './types.js';

export type RegimeShockReversionShortV4StrategyId =
  | 'regime_shock_reversion_short_v4_delay'
  | 'regime_shock_reversion_short_v4_persist';

export type RegimeShockReversionShortV4Rejection = (
  snapshot: StrategyFeatureSnapshot,
  parameters: RegimeMeanReversionStrategyParameters,
  reasons: string[],
) => string | undefined;

export function generateRegimeShockReversionShortV4(
  input: StrategyEvaluationInput,
  strategyId: RegimeShockReversionShortV4StrategyId,
  parameters: RegimeMeanReversionStrategyParameters,
  reject: RegimeShockReversionShortV4Rejection,
): StrategyGenerationResult {
  if (input.strategy_id !== strategyId) {
    throw new Error(`${strategyId} generator received ${input.strategy_id}`);
  }

  const { snapshot } = input;
  const reasons: string[] = [];
  const rejection = reject(snapshot, parameters, reasons);
  if (rejection !== undefined) {
    return {
      evaluation: makeEvaluation(snapshot, strategyId, 'blocked', undefined, [rejection, ...reasons]),
    };
  }

  const sigmaPts = getRequiredNumber(snapshot.indicators, 'sigma_pts', strategyId);
  const entryPrice = roundToTick(snapshot.quote.mid_px, snapshot.instrument.tick_size);
  const stopPrice = roundToTick(
    entryPrice + sigmaPts * parameters.stop_sigma_multiple,
    snapshot.instrument.tick_size,
  );
  const riskPts = stopPrice - entryPrice;
  if (!(riskPts > 0)) {
    return {
      evaluation: makeEvaluation(snapshot, strategyId, 'blocked', undefined, [
        `${strategyId}:non_positive_risk`,
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
      evaluation: makeEvaluation(snapshot, strategyId, 'blocked', undefined, [
        `${strategyId}:targets_invalid`,
        ...reasons,
      ]),
    };
  }

  const confidence = computeConfidence(snapshot, parameters);
  const candidate: Candidate = {
    candidate_id: makeCandidateId(`candidate-${snapshot.feature_snapshot_id}-${strategyId}`),
    strategy_id: strategyId,
    setup_type: strategyId,
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
      `${strategyId}:armed`,
      `${strategyId}:regime_${snapshot.context.regime_label}`,
      ...reasons,
    ],
  };

  return {
    evaluation: makeEvaluation(snapshot, strategyId, 'armed', confidence, [
      `${strategyId}:armed`,
      ...candidate.reasons,
    ]),
    candidate,
  };
}

export function firstBaseRegimeShockReversionShortV4Rejection(
  snapshot: StrategyFeatureSnapshot,
  parameters: RegimeMeanReversionStrategyParameters,
  reasons: string[],
  strategyId: RegimeShockReversionShortV4StrategyId,
): string | undefined {
  const parameterIssues = validateRegimeMeanReversionParameters(parameters);
  if (parameterIssues[0] !== undefined) {
    return `${strategyId}:${parameterIssues[0]}`;
  }
  if (!snapshot.session.is_rth) {
    return `${strategyId}:session_not_rth`;
  }
  if (snapshot.session.is_halt) {
    return `${strategyId}:session_halted`;
  }
  if (snapshot.session.is_roll_block) {
    return `${strategyId}:roll_block_active`;
  }

  const regime = snapshot.context.regime_label;
  if (regime === 'unknown') {
    return `${strategyId}:missing_regime_label`;
  }
  if (!isTradingRegime(regime)) {
    return `${strategyId}:regime_state_non_trading`;
  }

  const shock = snapshot.context.signed_shock_vwap.value;
  if (shock === null) {
    return `${strategyId}:signed_shock_unavailable_warmup`;
  }
  reasons.push(`signed_shock_vwap:${round4(shock)}`);

  if (regime === 'high' && shock < parameters.high_shock_threshold_pos) {
    return `${strategyId}:high_regime_shock_below_pos_threshold`;
  }
  if (regime === 'low' && shock < parameters.low_shock_threshold_pos) {
    return `${strategyId}:low_regime_shock_below_strict_pos_threshold`;
  }

  return undefined;
}

export function meetsRegimeShockThreshold(
  regime: StrategyFeatureSnapshotRegime,
  shock: number,
  parameters: RegimeMeanReversionStrategyParameters,
): boolean {
  return regime === 'high'
    ? shock >= parameters.high_shock_threshold_pos
    : shock >= parameters.low_shock_threshold_pos;
}

export function roundV4DiagnosticValue(value: number): number {
  return Math.round(value * 10000) / 10000;
}

const round4 = roundV4DiagnosticValue;

function makeEvaluation(
  snapshot: StrategyFeatureSnapshot,
  strategyId: RegimeShockReversionShortV4StrategyId,
  gateState: StrategyEvaluation['gate_state'],
  score: number | undefined,
  reasons: readonly string[],
): StrategyEvaluation {
  return {
    strategy_evaluation_id: makeStrategyEvaluationId(
      `eval-${snapshot.feature_snapshot_id}-${strategyId}`,
    ),
    strategy_id: strategyId,
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

function getRequiredNumber(
  values: StrategyScalarMap,
  key: string,
  strategyId: RegimeShockReversionShortV4StrategyId,
): number {
  const value = values[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${strategyId} requires numeric ${key}`);
  }
  return value;
}

function roundToTick(value: number, tickSize: number): number {
  return round4(Math.round(value / tickSize) * tickSize);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
