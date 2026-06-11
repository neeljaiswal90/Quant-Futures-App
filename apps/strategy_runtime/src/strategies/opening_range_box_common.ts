import type { OpeningRangeBoxStrategyParameters } from '../config/index.js';
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
} from './types.js';

export type OpeningRangeBoxDirection = 'long' | 'short';

/** The breakout/fade variant a generator (or the regime dispatcher) is running. */
export type OpeningRangeBoxMode = 'breakout' | 'fade';

export function clampBox(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function round4Box(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function roundToTickBox(value: number, tickSize: number): number {
  return round4Box(Math.round(value / tickSize) * tickSize);
}

export function getBoxAtr14Pts(snapshot: StrategyFeatureSnapshot): number | null {
  const value = snapshot.indicators.atr_14_pts;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function rewardRiskBox(
  targetPrice: number,
  entryPrice: number,
  riskPts: number,
  direction: OpeningRangeBoxDirection,
): number {
  if (!(riskPts > 0)) {
    return 0;
  }
  const rewardPts = direction === 'long' ? targetPrice - entryPrice : entryPrice - targetPrice;
  return round4Box(rewardPts / riskPts);
}

/**
 * Two profit-taking legs sized 0.5/0.5 (summing to 1.0), placed by reward/risk
 * multiples off the entry. Returns null if the geometry collapses (targets do
 * not advance monotonically in the trade direction).
 */
export function buildOpeningRangeBoxTargets(input: {
  readonly direction: OpeningRangeBoxDirection;
  readonly entryPrice: number;
  readonly riskPts: number;
  readonly parameters: OpeningRangeBoxStrategyParameters;
  readonly tickSize: number;
}): readonly PriceTarget[] | null {
  if (!(input.riskPts > 0)) {
    return null;
  }
  const sign = input.direction === 'long' ? 1 : -1;
  const pt1 = roundToTickBox(
    input.entryPrice + sign * input.parameters.target_1_rr * input.riskPts,
    input.tickSize,
  );
  if (sign * (pt1 - input.entryPrice) <= 0) {
    return null;
  }
  const pt2 = roundToTickBox(
    input.entryPrice + sign * input.parameters.target_2_rr * input.riskPts,
    input.tickSize,
  );
  if (sign * (pt2 - pt1) <= 0) {
    return null;
  }
  return [
    { label: 'pt1', price: pt1, quantity_fraction: 0.5 },
    { label: 'pt2', price: pt2, quantity_fraction: 0.5 },
  ];
}

export function validateOpeningRangeBoxParameters(
  parameters: OpeningRangeBoxStrategyParameters,
): readonly string[] {
  const issues: string[] = [];
  if (!Number.isInteger(parameters.breakout_buffer_ticks) || parameters.breakout_buffer_ticks < 0) {
    issues.push('breakout_buffer_ticks_invalid');
  }
  if (!Number.isInteger(parameters.max_chase_ticks) || parameters.max_chase_ticks <= 0) {
    issues.push('max_chase_ticks_invalid');
  }
  if (parameters.max_chase_ticks <= parameters.breakout_buffer_ticks) {
    issues.push('max_chase_ticks_must_exceed_breakout_buffer_ticks');
  }
  if (!Number.isInteger(parameters.stop_buffer_ticks) || parameters.stop_buffer_ticks < 0) {
    issues.push('stop_buffer_ticks_invalid');
  }
  if (!Number.isInteger(parameters.fade_poke_ticks) || parameters.fade_poke_ticks <= 0) {
    issues.push('fade_poke_ticks_invalid');
  }
  if (!(parameters.adx_trend_min > 0)) {
    issues.push('adx_trend_min_invalid');
  }
  if (!(parameters.target_1_rr > 0)) {
    issues.push('target_1_rr_invalid');
  }
  if (parameters.target_2_rr <= parameters.target_1_rr) {
    issues.push('target_2_rr_must_exceed_target_1_rr');
  }
  if (parameters.confidence_score > 1) {
    issues.push('confidence_score_must_be_lte_one');
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Shared session/box gating used by every variant (and the regime dispatcher).
// ---------------------------------------------------------------------------

export interface OpeningRangeBoxGates {
  readonly tick: number;
  readonly boxHigh: number;
  readonly boxLow: number;
}

/**
 * Validates the parameters and the session/box preconditions common to every
 * opening-range-box variant. Returns either a rejection reason (string) or the
 * resolved gate values (tick + locked box edges) for the candidate math.
 */
export function resolveOpeningRangeBoxGates(
  strategyId: string,
  snapshot: StrategyFeatureSnapshot,
  parameters: OpeningRangeBoxStrategyParameters,
): string | OpeningRangeBoxGates {
  const parameterIssues = validateOpeningRangeBoxParameters(parameters);
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
  if (!snapshot.context.ten_am_box_ready) {
    return `${strategyId}:box_not_ready`;
  }
  const boxHigh = snapshot.context.ten_am_box_high;
  const boxLow = snapshot.context.ten_am_box_low;
  if (boxHigh === null || boxLow === null) {
    return `${strategyId}:box_unavailable`;
  }
  if (!(boxHigh > boxLow)) {
    return `${strategyId}:box_degenerate`;
  }
  if (getBoxAtr14Pts(snapshot) === null) {
    return `${strategyId}:atr_unavailable`;
  }
  return { tick: snapshot.instrument.tick_size, boxHigh, boxLow };
}

export function boxPrice(snapshot: StrategyFeatureSnapshot): number {
  return snapshot.last_trade_price ?? snapshot.quote.mid_px;
}

// ---------------------------------------------------------------------------
// BREAKOUT gate + candidate (shared by breakout_{long,short} and regime).
// ---------------------------------------------------------------------------

export function firstOpeningRangeBoxBreakoutRejection(
  strategyId: string,
  direction: OpeningRangeBoxDirection,
  snapshot: StrategyFeatureSnapshot,
  parameters: OpeningRangeBoxStrategyParameters,
  reasons: string[],
): string | undefined {
  const gates = resolveOpeningRangeBoxGates(strategyId, snapshot, parameters);
  if (typeof gates === 'string') {
    return gates;
  }
  const { tick, boxHigh, boxLow } = gates;
  const price = boxPrice(snapshot);

  if (direction === 'long') {
    const breakoutLevel = boxHigh + parameters.breakout_buffer_ticks * tick;
    if (price < breakoutLevel) {
      return `${strategyId}:no_upside_breakout`;
    }
    reasons.push(`box_breakout_distance_ticks:${round4Box((price - boxHigh) / tick)}`);
    if (price > boxHigh + parameters.max_chase_ticks * tick) {
      return `${strategyId}:breakout_beyond_chase_limit`;
    }
  } else {
    const breakoutLevel = boxLow - parameters.breakout_buffer_ticks * tick;
    if (price > breakoutLevel) {
      return `${strategyId}:no_downside_breakout`;
    }
    reasons.push(`box_breakout_distance_ticks:${round4Box((boxLow - price) / tick)}`);
    if (price < boxLow - parameters.max_chase_ticks * tick) {
      return `${strategyId}:breakout_beyond_chase_limit`;
    }
  }
  return undefined;
}

/**
 * Builds the armed breakout candidate. The caller has already cleared the
 * breakout gate. Returns either a rejection reason (geometry collapse) or the
 * full generation result.
 */
export function buildOpeningRangeBoxBreakout(
  strategyId: string,
  direction: OpeningRangeBoxDirection,
  snapshot: StrategyFeatureSnapshot,
  parameters: OpeningRangeBoxStrategyParameters,
  reasons: readonly string[],
): string | StrategyGenerationResult {
  const tick = snapshot.instrument.tick_size;
  const boxHigh = snapshot.context.ten_am_box_high as number;
  const boxLow = snapshot.context.ten_am_box_low as number;

  const entryPrice = direction === 'long'
    ? roundToTickBox(boxHigh + parameters.breakout_buffer_ticks * tick, tick)
    : roundToTickBox(boxLow - parameters.breakout_buffer_ticks * tick, tick);
  const stopPrice = direction === 'long'
    ? roundToTickBox(boxLow - parameters.stop_buffer_ticks * tick, tick)
    : roundToTickBox(boxHigh + parameters.stop_buffer_ticks * tick, tick);
  const riskPts = direction === 'long' ? entryPrice - stopPrice : stopPrice - entryPrice;
  if (!(riskPts > 0)) {
    return `${strategyId}:non_positive_risk`;
  }

  const targets = buildOpeningRangeBoxTargets({ direction, entryPrice, riskPts, parameters, tickSize: tick });
  if (targets === null) {
    return `${strategyId}:target_geometry_collapsed`;
  }

  return assembleResult({
    strategyId,
    direction,
    mode: 'breakout',
    snapshot,
    parameters,
    entryPrice,
    stopPrice,
    riskPts,
    targets,
    extraReasons: [`${strategyId}:box_${round4Box(boxLow)}_${round4Box(boxHigh)}`, ...reasons],
  });
}

// ---------------------------------------------------------------------------
// FADE gate + candidate (shared by fade_{long,short} and regime).
// ---------------------------------------------------------------------------

/** The poke extreme of any post-box bar that breached the relevant edge. */
function postBoxPokeExtreme(
  direction: OpeningRangeBoxDirection,
  snapshot: StrategyFeatureSnapshot,
  pokeLevel: number,
): number | null {
  let extreme: number | null = null;
  for (const bar of snapshot.bars) {
    if (direction === 'long') {
      // false breakdown: a bar poked its LOW below the level.
      if (bar.low < pokeLevel) {
        extreme = extreme === null ? bar.low : Math.min(extreme, bar.low);
      }
    } else {
      // false breakout: a bar poked its HIGH above the level.
      if (bar.high > pokeLevel) {
        extreme = extreme === null ? bar.high : Math.max(extreme, bar.high);
      }
    }
  }
  return extreme;
}

export function firstOpeningRangeBoxFadeRejection(
  strategyId: string,
  direction: OpeningRangeBoxDirection,
  snapshot: StrategyFeatureSnapshot,
  parameters: OpeningRangeBoxStrategyParameters,
  reasons: string[],
): string | undefined {
  const gates = resolveOpeningRangeBoxGates(strategyId, snapshot, parameters);
  if (typeof gates === 'string') {
    return gates;
  }
  const { tick, boxHigh, boxLow } = gates;
  const price = boxPrice(snapshot);

  if (direction === 'long') {
    // false breakdown: a post-box bar poked below box_low - fade_poke; price closed back inside.
    const pokeLevel = boxLow - parameters.fade_poke_ticks * tick;
    const pokeLow = postBoxPokeExtreme('long', snapshot, pokeLevel);
    if (pokeLow === null) {
      return `${strategyId}:no_false_breakdown_poke`;
    }
    reasons.push(`box_fade_poke_ticks:${round4Box((boxLow - pokeLow) / tick)}`);
    if (price < boxLow) {
      return `${strategyId}:price_not_back_inside_box`;
    }
    if (price > boxHigh) {
      return `${strategyId}:price_beyond_far_edge`;
    }
  } else {
    // false breakout: a post-box bar poked above box_high + fade_poke; price closed back inside.
    const pokeLevel = boxHigh + parameters.fade_poke_ticks * tick;
    const pokeHigh = postBoxPokeExtreme('short', snapshot, pokeLevel);
    if (pokeHigh === null) {
      return `${strategyId}:no_false_breakout_poke`;
    }
    reasons.push(`box_fade_poke_ticks:${round4Box((pokeHigh - boxHigh) / tick)}`);
    if (price > boxHigh) {
      return `${strategyId}:price_not_back_inside_box`;
    }
    if (price < boxLow) {
      return `${strategyId}:price_beyond_far_edge`;
    }
  }
  return undefined;
}

export function buildOpeningRangeBoxFade(
  strategyId: string,
  direction: OpeningRangeBoxDirection,
  snapshot: StrategyFeatureSnapshot,
  parameters: OpeningRangeBoxStrategyParameters,
  reasons: readonly string[],
): string | StrategyGenerationResult {
  const tick = snapshot.instrument.tick_size;
  const boxHigh = snapshot.context.ten_am_box_high as number;
  const boxLow = snapshot.context.ten_am_box_low as number;
  const price = boxPrice(snapshot);

  // Enter back inside the box at current price; stop beyond the poke extreme.
  const entryPrice = roundToTickBox(price, tick);
  if (direction === 'long') {
    const pokeLevel = boxLow - parameters.fade_poke_ticks * tick;
    const pokeLow = postBoxPokeExtreme('long', snapshot, pokeLevel) as number;
    const stopPrice = roundToTickBox(pokeLow - parameters.stop_buffer_ticks * tick, tick);
    const riskPts = entryPrice - stopPrice;
    if (!(riskPts > 0)) {
      return `${strategyId}:non_positive_risk`;
    }
    const targets = buildOpeningRangeBoxTargets({ direction, entryPrice, riskPts, parameters, tickSize: tick });
    if (targets === null) {
      return `${strategyId}:target_geometry_collapsed`;
    }
    return assembleResult({
      strategyId,
      direction,
      mode: 'fade',
      snapshot,
      parameters,
      entryPrice,
      stopPrice,
      riskPts,
      targets,
      extraReasons: [`${strategyId}:box_${round4Box(boxLow)}_${round4Box(boxHigh)}`, ...reasons],
    });
  }

  const pokeLevel = boxHigh + parameters.fade_poke_ticks * tick;
  const pokeHigh = postBoxPokeExtreme('short', snapshot, pokeLevel) as number;
  const stopPrice = roundToTickBox(pokeHigh + parameters.stop_buffer_ticks * tick, tick);
  const riskPts = stopPrice - entryPrice;
  if (!(riskPts > 0)) {
    return `${strategyId}:non_positive_risk`;
  }
  const targets = buildOpeningRangeBoxTargets({ direction, entryPrice, riskPts, parameters, tickSize: tick });
  if (targets === null) {
    return `${strategyId}:target_geometry_collapsed`;
  }
  return assembleResult({
    strategyId,
    direction,
    mode: 'fade',
    snapshot,
    parameters,
    entryPrice,
    stopPrice,
    riskPts,
    targets,
    extraReasons: [`${strategyId}:box_${round4Box(boxLow)}_${round4Box(boxHigh)}`, ...reasons],
  });
}

// ---------------------------------------------------------------------------
// REGIME dispatch helpers.
// ---------------------------------------------------------------------------

/**
 * Trending when structure trend is directional AND adx_14 >= adx_trend_min.
 * Otherwise range. Trending → breakout logic; range → fade logic.
 */
export function isOpeningRangeBoxTrending(
  snapshot: StrategyFeatureSnapshot,
  parameters: OpeningRangeBoxStrategyParameters,
): boolean {
  const adx = snapshot.indicators.adx_14;
  const adxOk = typeof adx === 'number' && Number.isFinite(adx) && adx >= parameters.adx_trend_min;
  const trend = snapshot.structure.trend;
  const trendDirectional = trend === 'up' || trend === 'down';
  return adxOk && trendDirectional;
}

export function selectOpeningRangeBoxMode(
  snapshot: StrategyFeatureSnapshot,
  parameters: OpeningRangeBoxStrategyParameters,
): OpeningRangeBoxMode {
  return isOpeningRangeBoxTrending(snapshot, parameters) ? 'breakout' : 'fade';
}

// ---------------------------------------------------------------------------
// Generic generator runners (used by the concrete files + the dispatcher).
// ---------------------------------------------------------------------------

export function runOpeningRangeBoxBreakout(
  strategyId: string,
  direction: OpeningRangeBoxDirection,
  input: StrategyEvaluationInput,
  parameters: OpeningRangeBoxStrategyParameters,
): StrategyGenerationResult {
  const { snapshot } = input;
  const reasons: string[] = [];
  const rejection = firstOpeningRangeBoxBreakoutRejection(strategyId, direction, snapshot, parameters, reasons);
  if (rejection !== undefined) {
    return { evaluation: makeBoxEvaluation(strategyId, snapshot, 'blocked', undefined, [rejection, ...reasons]) };
  }
  const built = buildOpeningRangeBoxBreakout(strategyId, direction, snapshot, parameters, reasons);
  if (typeof built === 'string') {
    return { evaluation: makeBoxEvaluation(strategyId, snapshot, 'blocked', undefined, [built, ...reasons]) };
  }
  return built;
}

export function runOpeningRangeBoxFade(
  strategyId: string,
  direction: OpeningRangeBoxDirection,
  input: StrategyEvaluationInput,
  parameters: OpeningRangeBoxStrategyParameters,
): StrategyGenerationResult {
  const { snapshot } = input;
  const reasons: string[] = [];
  const rejection = firstOpeningRangeBoxFadeRejection(strategyId, direction, snapshot, parameters, reasons);
  if (rejection !== undefined) {
    return { evaluation: makeBoxEvaluation(strategyId, snapshot, 'blocked', undefined, [rejection, ...reasons]) };
  }
  const built = buildOpeningRangeBoxFade(strategyId, direction, snapshot, parameters, reasons);
  if (typeof built === 'string') {
    return { evaluation: makeBoxEvaluation(strategyId, snapshot, 'blocked', undefined, [built, ...reasons]) };
  }
  return built;
}

// ---------------------------------------------------------------------------
// Shared assembly.
// ---------------------------------------------------------------------------

function assembleResult(input: {
  readonly strategyId: string;
  readonly direction: OpeningRangeBoxDirection;
  readonly mode: OpeningRangeBoxMode;
  readonly snapshot: StrategyFeatureSnapshot;
  readonly parameters: OpeningRangeBoxStrategyParameters;
  readonly entryPrice: number;
  readonly stopPrice: number;
  readonly riskPts: number;
  readonly targets: readonly PriceTarget[];
  readonly extraReasons: readonly string[];
}): StrategyGenerationResult {
  const { strategyId, direction, mode, snapshot, parameters, entryPrice, stopPrice, riskPts, targets } = input;
  const confidence = clampBox(round4Box(parameters.confidence_score), 0, 1);
  const candidateReasons = [
    `${strategyId}:armed`,
    `${strategyId}:mode_${mode}`,
    ...input.extraReasons,
  ];
  const candidate: Candidate = {
    candidate_id: makeCandidateId(`candidate-${snapshot.feature_snapshot_id}-${strategyId}`),
    strategy_id: strategyId as Candidate['strategy_id'],
    setup_type: strategyId as Candidate['setup_type'],
    setup_family: 'opening_range_box',
    instrument: snapshot.instrument,
    feature_snapshot_id: snapshot.feature_snapshot_id,
    direction,
    status: 'proposed',
    proposed_ts_ns: snapshot.created_ts_ns,
    entry_price: entryPrice,
    stop_price: stopPrice,
    risk_points: round4Box(riskPts),
    targets,
    reward_risk: targets.map((target) => ({
      label: target.label,
      reward_risk: rewardRiskBox(target.price, entryPrice, riskPts, direction),
    })),
    confidence,
    config: snapshot.config,
    reasons: candidateReasons,
  };

  return {
    evaluation: makeBoxEvaluation(strategyId, snapshot, 'armed', confidence, [
      `${strategyId}:armed`,
      ...candidate.reasons,
    ]),
    candidate,
  };
}

export function makeBoxEvaluation(
  strategyId: string,
  snapshot: StrategyFeatureSnapshot,
  gateState: StrategyEvaluation['gate_state'],
  score: number | undefined,
  reasons: readonly string[],
): StrategyEvaluation {
  return {
    strategy_evaluation_id: makeStrategyEvaluationId(`eval-${snapshot.feature_snapshot_id}-${strategyId}`),
    strategy_id: strategyId as StrategyEvaluation['strategy_id'],
    instrument: snapshot.instrument,
    feature_snapshot_id: snapshot.feature_snapshot_id,
    evaluated_ts_ns: snapshot.created_ts_ns,
    gate_state: gateState,
    ...(score === undefined ? {} : { score }),
    reasons,
    config: snapshot.config,
  };
}
