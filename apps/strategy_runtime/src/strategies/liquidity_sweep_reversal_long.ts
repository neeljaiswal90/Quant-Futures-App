import {
  DEFAULT_LIQUIDITY_SWEEP_REVERSAL_LONG_CONFIG,
  getStrategyParameters,
} from '../config/index.js';
import {
  makeCandidateId,
  makeStrategyEvaluationId,
  type Candidate,
  type StrategyEvaluation,
} from '../contracts/index.js';
import {
  buildReversalTargets,
  detectSweep,
  getRequiredSigmaPts,
  regimeAllowed,
  rewardRisk,
  round4,
  roundToTick,
  validateLiquiditySweepParameters,
  type SweepState,
} from './liquidity_sweep_reversal_common.js';
import type {
  StrategyEvaluationInput,
  StrategyFeatureSnapshot,
  StrategyGenerationResult,
} from './types.js';

export const LIQUIDITY_SWEEP_REVERSAL_LONG_DEFAULTS =
  DEFAULT_LIQUIDITY_SWEEP_REVERSAL_LONG_CONFIG;

export function generateLiquiditySweepReversalLong(
  input: StrategyEvaluationInput,
): StrategyGenerationResult {
  if (input.strategy_id !== 'liquidity_sweep_reversal_long') {
    throw new Error(`liquidity_sweep_reversal_long generator received ${input.strategy_id}`);
  }

  const { snapshot } = input;
  const parameters = getStrategyParameters(input.strategy_config, 'liquidity_sweep_reversal_long');
  validateLiquiditySweepParameters(parameters);
  const rejection = firstLiquiditySweepReversalLongRejection(snapshot, parameters);
  if (rejection !== undefined) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [rejection]),
    };
  }

  const sweep = detectSweep(snapshot, parameters);
  if (sweep === null) {
    throw new Error('liquidity_sweep_reversal_long sweep vanished after gate pass');
  }

  const sigmaPts = getRequiredSigmaPts(snapshot);
  const entryMid = snapshot.quote.mid_px;
  const stopPrice = roundToTick(
    entryMid - sigmaPts * parameters.stop_sigma_multiple,
    snapshot.instrument.tick_size,
  );
  const riskPts = entryMid - stopPrice;
  if (!(riskPts > 0)) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [
        'liquidity_sweep_reversal_long:non_positive_risk',
      ]),
    };
  }

  const targets = buildReversalTargets({
    entryPrice: entryMid,
    riskPts,
    direction: 'long',
    parameters,
    tickSize: snapshot.instrument.tick_size,
  });
  const candidate: Candidate = {
    candidate_id: makeCandidateId(`candidate-${snapshot.feature_snapshot_id}-liquidity_sweep_reversal_long`),
    strategy_id: 'liquidity_sweep_reversal_long',
    setup_type: 'liquidity_sweep_reversal_long',
    setup_family: 'liquidity_sweep_reversal',
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
      reward_risk: rewardRisk(target.price, entryMid, riskPts, 'long'),
    })),
    confidence: parameters.confidence_score,
    config: snapshot.config,
    reasons: [
      'liquidity_sweep_reversal_long:armed',
      'liquidity_sweep_reversal_long:sweep_direction_down',
      `liquidity_sweep_reversal_long:sweep_intensity_sigma:${sweep.sweep_intensity_sigma}`,
      `liquidity_sweep_reversal_long:post_sweep_depth_ratio:${sweep.post_sweep_depth_ratio}`,
    ],
  };

  return {
    evaluation: makeEvaluation(snapshot, 'armed', parameters.confidence_score, [
      'liquidity_sweep_reversal_long:armed',
      ...candidate.reasons,
    ]),
    candidate,
  };
}

function firstLiquiditySweepReversalLongRejection(
  snapshot: StrategyFeatureSnapshot,
  parameters: typeof LIQUIDITY_SWEEP_REVERSAL_LONG_DEFAULTS,
): string | undefined {
  if (!snapshot.session.is_rth) {
    return 'liquidity_sweep_reversal_long:session_not_rth';
  }
  if (snapshot.session.is_halt) {
    return 'liquidity_sweep_reversal_long:session_halted';
  }
  if (snapshot.session.is_roll_block) {
    return 'liquidity_sweep_reversal_long:roll_block_active';
  }

  const sweep = detectSweep(snapshot, parameters);
  if (sweep === null) {
    return 'liquidity_sweep_reversal_long:no_sweep_detected';
  }
  return validateLongSweep(snapshot, parameters, sweep);
}

function validateLongSweep(
  snapshot: StrategyFeatureSnapshot,
  parameters: typeof LIQUIDITY_SWEEP_REVERSAL_LONG_DEFAULTS,
  sweep: SweepState,
): string | undefined {
  if (sweep.sweep_direction !== 'down') {
    return 'liquidity_sweep_reversal_long:wrong_sweep_direction_for_long_reversal';
  }
  if (sweep.sweep_intensity_sigma < parameters.minimum_sweep_intensity_sigma) {
    return 'liquidity_sweep_reversal_long:sweep_intensity_below_threshold';
  }
  if (sweep.post_sweep_depth_ratio === null) {
    return 'liquidity_sweep_reversal_long:depth_ratio_unavailable_warmup';
  }
  if (sweep.post_sweep_depth_ratio > parameters.maximum_post_sweep_depth_ratio) {
    return 'liquidity_sweep_reversal_long:queue_not_exhausted';
  }
  if (sweep.bars_since_sweep > parameters.snapback_window_bars) {
    return 'liquidity_sweep_reversal_long:snapback_window_expired';
  }
  if (!regimeAllowed(snapshot.context.regime_label, parameters)) {
    return 'liquidity_sweep_reversal_long:regime_co_filter_blocked';
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
      `eval-${snapshot.feature_snapshot_id}-liquidity_sweep_reversal_long`,
    ),
    strategy_id: 'liquidity_sweep_reversal_long',
    instrument: snapshot.instrument,
    feature_snapshot_id: snapshot.feature_snapshot_id,
    evaluated_ts_ns: snapshot.created_ts_ns,
    gate_state: gateState,
    ...(score === undefined ? {} : { score }),
    reasons,
    config: snapshot.config,
  };
}
