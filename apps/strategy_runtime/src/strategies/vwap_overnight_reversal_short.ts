import {
  DEFAULT_VWAP_OVERNIGHT_REVERSAL_SHORT_CONFIG,
  getStrategyParameters,
  type VwapOvernightReversalStrategyParameters,
} from '../config/index.js';
import {
  makeCandidateId,
  makeStrategyEvaluationId,
  type Candidate,
  type StrategyEvaluation,
} from '../contracts/index.js';
import {
  buildVwapOvernightReversalTargets,
  clamp,
  getAtr14Pts,
  isVwapOvernightTradingRegime,
  rewardRiskVwapOvernight,
  round4VwapOvernight,
  roundToTickVwapOvernight,
  selectVwapSignedShockValue,
  thresholdForRegime,
  validateVwapOvernightReversalParameters,
} from './vwap_overnight_reversal_common.js';
import type {
  StrategyEvaluationInput,
  StrategyFeatureSnapshot,
  StrategyGenerationResult,
} from './types.js';

export const VWAP_OVERNIGHT_REVERSAL_SHORT_DEFAULTS = DEFAULT_VWAP_OVERNIGHT_REVERSAL_SHORT_CONFIG;

export function generateVwapOvernightReversalShort(
  input: StrategyEvaluationInput,
): StrategyGenerationResult {
  if (input.strategy_id !== 'vwap_overnight_reversal_short') {
    throw new Error(`vwap_overnight_reversal_short generator received ${input.strategy_id}`);
  }

  const { snapshot } = input;
  const parameters = getStrategyParameters(input.strategy_config, 'vwap_overnight_reversal_short');
  const reasons: string[] = [];
  const rejection = firstVwapOvernightReversalShortRejection(snapshot, parameters, reasons);
  if (rejection !== undefined) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [rejection, ...reasons]),
    };
  }

  const atr14 = getAtr14Pts(snapshot);
  if (atr14 === null) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [
        'vwap_overnight_reversal_short:atr_unavailable',
        ...reasons,
      ]),
    };
  }

  const entryPrice = roundToTickVwapOvernight(snapshot.quote.mid_px, snapshot.instrument.tick_size);
  const stopPrice = roundToTickVwapOvernight(
    entryPrice + atr14 * parameters.stop_atr_multiple,
    snapshot.instrument.tick_size,
  );
  const riskPts = stopPrice - entryPrice;
  if (!(riskPts > 0)) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [
        'vwap_overnight_reversal_short:non_positive_risk',
        ...reasons,
      ]),
    };
  }

  const targets = buildVwapOvernightReversalTargets({
    direction: 'short',
    entryPrice,
    riskPts,
    sessionVwap: snapshot.context.session_vwap,
    parameters,
    tickSize: snapshot.instrument.tick_size,
  });
  if (targets === null) {
    return {
      evaluation: makeEvaluation(snapshot, 'blocked', undefined, [
        'vwap_overnight_reversal_short:vwap_target_unavailable',
        ...reasons,
      ]),
    };
  }

  const confidence = clamp(round4VwapOvernight(parameters.confidence_score), 0, 1);
  const candidate: Candidate = {
    candidate_id: makeCandidateId(`candidate-${snapshot.feature_snapshot_id}-vwap_overnight_reversal_short`),
    strategy_id: 'vwap_overnight_reversal_short',
    setup_type: 'vwap_overnight_reversal_short',
    setup_family: 'vwap_overnight_reversal',
    instrument: snapshot.instrument,
    feature_snapshot_id: snapshot.feature_snapshot_id,
    direction: 'short',
    status: 'proposed',
    proposed_ts_ns: snapshot.created_ts_ns,
    entry_price: entryPrice,
    stop_price: stopPrice,
    risk_points: round4VwapOvernight(riskPts),
    targets,
    reward_risk: targets.map((target) => ({
      label: target.label,
      reward_risk: rewardRiskVwapOvernight(target.price, entryPrice, riskPts, 'short'),
    })),
    confidence,
    config: snapshot.config,
    reasons: [
      'vwap_overnight_reversal_short:armed',
      `vwap_overnight_reversal_short:regime_${snapshot.context.regime_label}`,
      'vwap_overnight_reversal_short:target_1_vwap_touch',
      ...reasons,
    ],
  };

  return {
    evaluation: makeEvaluation(snapshot, 'armed', confidence, [
      'vwap_overnight_reversal_short:armed',
      ...candidate.reasons,
    ]),
    candidate,
  };
}

export function firstVwapOvernightReversalShortRejection(
  snapshot: StrategyFeatureSnapshot,
  parameters: VwapOvernightReversalStrategyParameters,
  reasons: string[] = [],
): string | undefined {
  const parameterIssues = validateVwapOvernightReversalParameters(parameters);
  if (parameterIssues[0] !== undefined) {
    return `vwap_overnight_reversal_short:${parameterIssues[0]}`;
  }
  if (!snapshot.session.is_rth) {
    return 'vwap_overnight_reversal_short:session_not_rth';
  }
  if (snapshot.session.is_halt) {
    return 'vwap_overnight_reversal_short:session_halted';
  }
  if (snapshot.session.is_roll_block) {
    return 'vwap_overnight_reversal_short:roll_block_active';
  }

  const regime = snapshot.context.regime_label;
  if (regime === 'unknown') {
    return 'vwap_overnight_reversal_short:missing_regime_label';
  }
  if (!isVwapOvernightTradingRegime(regime)) {
    return 'vwap_overnight_reversal_short:regime_state_non_trading';
  }

  if (snapshot.context.opening_range_minutes_elapsed < parameters.exclude_first_minutes) {
    return 'vwap_overnight_reversal_short:warmup_period_not_complete';
  }

  const overnightBps = snapshot.context.overnight_return_bps;
  if (overnightBps === null) {
    return 'vwap_overnight_reversal_short:missing_overnight_data';
  }
  reasons.push(`overnight_return_bps:${round4VwapOvernight(overnightBps)}`);
  if (overnightBps < parameters.min_abs_overnight_return_bps) {
    return 'vwap_overnight_reversal_short:overnight_magnitude_below_threshold';
  }

  const signedShock = selectVwapSignedShockValue(snapshot);
  if (signedShock === null) {
    return 'vwap_overnight_reversal_short:signed_shock_unavailable_warmup';
  }
  reasons.push(`signed_shock_vwap:${round4VwapOvernight(signedShock)}`);
  if (signedShock < thresholdForRegime(regime, parameters)) {
    return 'vwap_overnight_reversal_short:signed_shock_below_threshold';
  }

  const adx = snapshot.indicators.adx_14;
  if (typeof adx === 'number' && Number.isFinite(adx) && adx > parameters.adx_max) {
    return 'vwap_overnight_reversal_short:adx_indicates_trend_environment';
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
      `eval-${snapshot.feature_snapshot_id}-vwap_overnight_reversal_short`,
    ),
    strategy_id: 'vwap_overnight_reversal_short',
    instrument: snapshot.instrument,
    feature_snapshot_id: snapshot.feature_snapshot_id,
    evaluated_ts_ns: snapshot.created_ts_ns,
    gate_state: gateState,
    ...(score === undefined ? {} : { score }),
    reasons,
    config: snapshot.config,
  };
}
