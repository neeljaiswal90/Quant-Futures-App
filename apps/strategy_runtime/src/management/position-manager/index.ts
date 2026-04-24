import type { IndicatorConfig } from '../../contracts/config.js';
import type { OrderResult } from '../../contracts/execution.js';
import type {
  ExitReason,
  Position,
  PositionBuildRequest,
  PositionDecision,
  TradeRecord,
} from '../../contracts/position.js';
import type { ContractSpec } from '../../risk/contracts.js';
import { roundToTick } from '../../risk/contracts.js';
import type { FailureExitCurves } from './failure-exit/curves.js';
import { evaluateFailureExitDecision } from './fail-safe.js';
import { computeExitReasonDetailed } from './exit-labeling.js';
import { evaluateRiskMutations } from './stops.js';
import { applyTarget1Partial, applyPt1Exit, applyPt2Exit, evaluateTargetDecision } from './targets.js';
import { evaluateTimeStop } from './time-stops.js';
import { applyRiskMutations } from './trailing.js';

export { computeExitReasonDetailed, isStoppedOut } from './exit-labeling.js';
export * from './stops.js';
export * from './targets.js';
export * from './trailing.js';
export * from './time-stops.js';
export * from './fail-safe.js';
export * from './failure-exit/state.js';
export * from './failure-exit/curves.js';
export * from './failure-exit/evaluator.js';

export class PositionManager {
  private position: Position | null = null;
  private failureCurves: Map<string, FailureExitCurves> | null = null;

  constructor(private readonly contract: ContractSpec) {}

  setFailureCurves(curves: Map<string, FailureExitCurves> | null): void {
    this.failureCurves = curves;
  }

  hasOpenPosition(): boolean {
    return this.position !== null;
  }

  getPosition(): Position | null {
    return this.position;
  }

  openPosition(position: Position): void {
    if (this.position) {
      throw new Error('PositionManager: a position is already open');
    }
    this.position = position;
  }

  clearPosition(): void {
    this.position = null;
  }

  evaluate(
    currentPrice: number,
    config: IndicatorConfig,
    nowUnixMs: number = Date.now(),
  ): PositionDecision {
    const position = this.position;
    if (!position) {
      return noDecision(currentPrice);
    }

    updateExcursions(position, currentPrice, nowUnixMs);

    const riskEval = evaluateRiskMutations(position, currentPrice, this.contract);
    if (riskEval.hasMutations) {
      applyRiskMutations(position, riskEval.proposedMutations, currentPrice);
    }
    if (riskEval.shouldExit && riskEval.exitDecision) {
      return riskEval.exitDecision;
    }

    const targetDecision = evaluateTargetDecision(position, currentPrice);
    if (targetDecision.shouldExit) {
      return targetDecision;
    }

    const curveKey = position.management_params.pre_t1_failure_curves_key || position.management_params.family;
    const failureCurve = this.failureCurves?.get(curveKey) ?? null;
    const failSafeDecision = evaluateFailureExitDecision(position, currentPrice, nowUnixMs, failureCurve);
    if (failSafeDecision.shouldExit) {
      return failSafeDecision;
    }

    const timeStopDecision = evaluateTimeStop(position, currentPrice, config, nowUnixMs);
    if (timeStopDecision.shouldExit) {
      return timeStopDecision;
    }

    return noDecision(currentPrice);
  }

  applyPartialExit(fill: OrderResult, quantity: number): void {
    if (!this.position) return;
    applyTarget1Partial(this.position, fill, quantity, this.contract);
  }

  applyPt1Exit(fill: OrderResult, quantity: number): void {
    if (!this.position) return;
    applyPt1Exit(this.position, fill, quantity, this.contract);
  }

  applyPt2Exit(fill: OrderResult, quantity: number): void {
    if (!this.position) return;
    applyPt2Exit(this.position, fill, quantity, this.contract);
  }

  moveStopTo(newStop: number): boolean {
    if (!this.position) return false;
    const isShort = this.position.side === 'short';
    const rounded = roundToTick(newStop, this.contract);
    const tightens = isShort ? rounded < this.position.stop_current : rounded > this.position.stop_current;
    if (!tightens) return false;
    this.position.stop_current = rounded;
    return true;
  }

  moveStopToBreakeven(): boolean {
    if (!this.position || this.position.stop_moved_to_be) return false;
    const be = roundToTick(this.position.entry_price, this.contract);
    const isShort = this.position.side === 'short';
    const tightens = isShort ? be < this.position.stop_current : be > this.position.stop_current;
    if (!tightens) return false;
    this.position.stop_current = be;
    this.position.stop_moved_to_be = true;
    return true;
  }

  closePosition(
    exitResult: OrderResult,
    reason: ExitReason,
    plannedExitPrice: number,
  ): TradeRecord {
    if (!this.position) {
      throw new Error('PositionManager: no open position to close');
    }

    const position = this.position;
    const pnlPoints = position.side === 'short'
      ? position.entry_price - exitResult.fill_price
      : exitResult.fill_price - position.entry_price;
    const pnlUsd = pnlPoints * position.quantity_remaining * this.contract.point_value - exitResult.fee_usd;
    position.exit_legs.push({
      reason,
      quantity: position.quantity_remaining,
      fill_price: exitResult.fill_price,
      fill_time_iso: exitResult.fill_time_iso,
      pnl_points: pnlPoints,
      pnl_usd: pnlUsd,
      fee_usd: exitResult.fee_usd,
      slippage_pts: exitResult.slippage_pts,
    });
    position.realized_pnl_usd += pnlUsd;
    position.realized_fees_usd += exitResult.fee_usd;

    const record: TradeRecord = {
      trade_id: position.trade_id,
      signal_id: position.signal_id,
      symbol: position.symbol,
      venue: position.venue,
      side: position.side,
      setup_type: position.setup_type,
      quantity: position.quantity_original,
      entry_price_planned: position.entry_price,
      entry_price_filled: position.entry_price,
      exit_price_planned: plannedExitPrice,
      exit_price_actual: exitResult.fill_price,
      stop_price_initial: position.stop_initial,
      pnl_realized: round2(position.realized_pnl_usd),
      exit_reason: computeExitReasonDetailed(reason, position.partial_exit_done, position.trailing_active),
      regime_at_entry: position.regime_at_entry,
      session_id: position.session_id,
      strategy_version: position.strategy_version,
      entry_state_vector: position.entry_state_vector,
      target_1_direction_valid: position.target_1_direction_valid,
      target_2_direction_valid: position.target_2_direction_valid,
      target_3_direction_valid: position.target_3_direction_valid,
      target_ordering_valid: position.target_ordering_valid,
      target_repair_applied: position.target_repair_applied,
      total_cost_usd: round2(position.realized_fees_usd),
      pnl_gross_usd: round2(position.realized_pnl_usd + position.realized_fees_usd),
      pnl_net_usd: round2(position.realized_pnl_usd),
      r_net: position.risk_pts_initial > 0
        ? round2(position.realized_pnl_usd / (position.risk_pts_initial * position.quantity_original * this.contract.point_value))
        : null,
      exit_legs: [...position.exit_legs],
    };

    this.position = null;
    return record;
  }

  static buildPosition(request: PositionBuildRequest, contract: ContractSpec): Position {
    const setup = request.setup;
    return {
      trade_id: request.trade_id,
      signal_id: request.signal_id,
      session_id: request.session_id,
      symbol: contract.app_symbol,
      venue: contract.venue,
      side: setup.direction,
      setup_type: setup.setup_type,
      entry_price: request.fill_price,
      entry_time_iso: request.fill_time_iso,
      entry_time_unix: Date.parse(request.fill_time_iso),
      stop_initial: setup.stop,
      stop_current: setup.stop,
      target_1: setup.target_1,
      target_2: setup.target_2,
      target_3: setup.target_3,
      planned_target_1: setup.target_1,
      effective_target_1: null,
      first_partial_fill_price: null,
      target_1_direction_valid: setup.target_1_direction_valid ?? true,
      target_2_direction_valid: setup.target_2_direction_valid ?? true,
      target_3_direction_valid: setup.target_3_direction_valid ?? true,
      target_ordering_valid: setup.target_ordering_valid ?? true,
      target_repair_applied: setup.target_repair_applied ?? false,
      quantity_original: request.quantity,
      quantity_remaining: request.quantity,
      notional_usd: request.notional_usd,
      regime_at_entry: request.regime_at_entry,
      strategy_version: request.strategy_version,
      confidence_at_entry: request.confidence_at_entry,
      risk_pts_initial: Math.abs(request.fill_price - setup.stop),
      partial_exit_done: false,
      pt1_done: false,
      pt2_done: false,
      trailing_active: false,
      pre_t1_trailing_active: false,
      pre_t1_be_triggered: false,
      stop_moved_to_be: false,
      trail_distance_ticks: 0,
      trail_anchor_price: null,
      time_stop_minutes: request.management_params.time_stop_minutes,
      last_checked_price: request.fill_price,
      realized_pnl_usd: 0,
      realized_fees_usd: 0,
      max_favorable_excursion: 0,
      max_adverse_excursion: 0,
      pt1_qty_exited: 0,
      pt2_qty_exited: 0,
      pt1_realized_pnl: 0,
      pt2_realized_pnl: 0,
      exit_legs: [],
      peak_r_before_first_partial: 0,
      t_peak_r_minutes: null,
      time_to_first_positive_r_minutes: null,
      time_to_peak_r_before_first_partial_minutes: null,
      mae_r_before_first_partial: 0,
      atr_at_entry: request.management_params.atr_at_entry,
      failure_review_soft_emitted: false,
      failure_exit_hard_fired: false,
      failure_exit_emergency_fired: false,
      failure_exit_active_lane: 'none',
      failure_exit_reason: null,
      failure_exit_shadow_only: false,
      entry_state_vector: request.entry_state_vector ?? setup.entry_state_vector ?? null,
      management_params: request.management_params,
    };
  }
}

function updateExcursions(
  position: Position,
  currentPrice: number,
  nowUnixMs: number,
): void {
  const favorableMove = position.side === 'short'
    ? position.entry_price - currentPrice
    : currentPrice - position.entry_price;
  const adverseMove = position.side === 'short'
    ? currentPrice - position.entry_price
    : position.entry_price - currentPrice;

  if (favorableMove > position.max_favorable_excursion) {
    position.max_favorable_excursion = favorableMove;
  }
  if (adverseMove > position.max_adverse_excursion) {
    position.max_adverse_excursion = adverseMove;
  }
  position.last_checked_price = currentPrice;

  if (!position.pt1_done && !position.partial_exit_done) {
    const initialRiskPts = Math.abs(position.entry_price - position.stop_initial);
    const peakR = initialRiskPts > 0 ? favorableMove / initialRiskPts : 0;
    if (peakR > (position.peak_r_before_first_partial ?? 0)) {
      const peakMinutes = (nowUnixMs - position.entry_time_unix) / 60_000;
      position.peak_r_before_first_partial = peakR;
      position.t_peak_r_minutes = peakMinutes;
      position.time_to_peak_r_before_first_partial_minutes ??= peakMinutes;
    }
    if (position.time_to_first_positive_r_minutes === null && peakR > 0) {
      position.time_to_first_positive_r_minutes = (nowUnixMs - position.entry_time_unix) / 60_000;
    }
  }
}

function noDecision(currentPrice: number): PositionDecision {
  return {
    shouldExit: false,
    reason: null,
    exitPrice: currentPrice,
    plannedExitPrice: currentPrice,
    isPartial: false,
    partialQuantity: 0,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
