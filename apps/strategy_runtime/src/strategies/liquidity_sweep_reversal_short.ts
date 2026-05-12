import {
  DEFAULT_LIQUIDITY_SWEEP_REVERSAL_SHORT_CONFIG,
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

export const LIQUIDITY_SWEEP_REVERSAL_SHORT_DEFAULTS =
  DEFAULT_LIQUIDITY_SWEEP_REVERSAL_SHORT_CONFIG;

export function generateLiquiditySweepReversalShort(
  input: StrategyEvaluationInput,
): StrategyGenerationResult {
  if (input.strategy_id !== 'liquidity_sweep_reversal_short') {
    throw new Error(`liquidity_sweep_reversal_short generator received ${input.strategy_id}`);
  }

  const { snapshot } = input;
  const parameters = getStrategyParameters(input.strategy_config, 'liquidity_sweep_reversal_short');
  validateLiquiditySweepParameters(parameters);
  const rejection = firstLiquiditySweepReversalShortRejection(snapshot, parameters);
  if (rejection !== undefined) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [rejection]),
    };
  }

  const sweep = detectSweep(snapshot, parameters);
  if (sweep === null) {
    throw new Error('liquidity_sweep_reversal_short sweep vanished after gate pass');
  }

  const sigmaPts = getRequiredSigmaPts(snapshot);
  const entryMid = snapshot.quote.mid_px;
  const stopPrice = roundToTick(
    entryMid + sigmaPts * parameters.stop_sigma_multiple,
    snapshot.instrument.tick_size,
  );
  const riskPts = stopPrice - entryMid;
  if (!(riskPts > 0)) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [
        'liquidity_sweep_reversal_short:non_positive_risk',
      ]),
    };
  }

  const targets = buildReversalTargets({
    entryPrice: entryMid,
    riskPts,
    direction: 'short',
    parameters,
    tickSize: snapshot.instrument.tick_size,
  });
  const candidate: Candidate = {
    candidate_id: makeCandidateId(`candidate-${snapshot.feature_snapshot_id}-liquidity_sweep_reversal_short`),
    strategy_id: 'liquidity_sweep_reversal_short',
    setup_type: 'liquidity_sweep_reversal_short',
    setup_family: 'liquidity_sweep_reversal',
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
      reward_risk: rewardRisk(target.price, entryMid, riskPts, 'short'),
    })),
    confidence: parameters.confidence_score,
    config: snapshot.config,
    reasons: [
      'liquidity_sweep_reversal_short:armed',
      'liquidity_sweep_reversal_short:sweep_direction_up',
      `liquidity_sweep_reversal_short:sweep_intensity_sigma:${sweep.sweep_intensity_sigma}`,
      `liquidity_sweep_reversal_short:post_sweep_depth_ratio:${sweep.post_sweep_depth_ratio}`,
    ],
  };

  return {
    evaluation: makeEvaluation(snapshot, 'armed', parameters.confidence_score, [
      'liquidity_sweep_reversal_short:armed',
      ...candidate.reasons,
    ]),
    candidate,
  };
}

function firstLiquiditySweepReversalShortRejection(
  snapshot: StrategyFeatureSnapshot,
  parameters: typeof LIQUIDITY_SWEEP_REVERSAL_SHORT_DEFAULTS,
): string | undefined {
  if (!snapshot.session.is_rth) {
    return 'liquidity_sweep_reversal_short:session_not_rth';
  }
  if (snapshot.session.is_halt) {
    return 'liquidity_sweep_reversal_short:session_halted';
  }
  if (snapshot.session.is_roll_block) {
    return 'liquidity_sweep_reversal_short:roll_block_active';
  }

  const sweep = detectSweep(snapshot, parameters);
  if (sweep === null) {
    return 'liquidity_sweep_reversal_short:no_sweep_detected';
  }
  return validateShortSweep(snapshot, parameters, sweep);
}

function validateShortSweep(
  snapshot: StrategyFeatureSnapshot,
  parameters: typeof LIQUIDITY_SWEEP_REVERSAL_SHORT_DEFAULTS,
  sweep: SweepState,
): string | undefined {
  if (sweep.sweep_direction !== 'up') {
    return 'liquidity_sweep_reversal_short:wrong_sweep_direction_for_short_reversal';
  }
  if (sweep.sweep_intensity_sigma < parameters.minimum_sweep_intensity_sigma) {
    return 'liquidity_sweep_reversal_short:sweep_intensity_below_threshold';
  }
  if (sweep.post_sweep_depth_ratio === null) {
    return 'liquidity_sweep_reversal_short:depth_ratio_unavailable_warmup';
  }
  if (sweep.post_sweep_depth_ratio > parameters.maximum_post_sweep_depth_ratio) {
    return 'liquidity_sweep_reversal_short:queue_not_exhausted';
  }
  if (sweep.bars_since_sweep > parameters.snapback_window_bars) {
    return 'liquidity_sweep_reversal_short:snapback_window_expired';
  }
  if (!regimeAllowed(snapshot.context.regime_label, parameters)) {
    return 'liquidity_sweep_reversal_short:regime_co_filter_blocked';
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
      `eval-${snapshot.feature_snapshot_id}-liquidity_sweep_reversal_short`,
    ),
    strategy_id: 'liquidity_sweep_reversal_short',
    instrument: snapshot.instrument,
    feature_snapshot_id: snapshot.feature_snapshot_id,
    evaluated_ts_ns: snapshot.created_ts_ns,
    gate_state: gateState,
    ...(score === undefined ? {} : { score }),
    reasons,
    config: snapshot.config,
  };
}
