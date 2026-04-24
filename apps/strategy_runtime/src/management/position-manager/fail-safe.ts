import type { Position, PositionDecision } from '../../contracts/position.js';
import type { FailureExitCurves } from './failure-exit/curves.js';
import { evaluateFailureExit } from './failure-exit/evaluator.js';
import { computeFailureExitState } from './failure-exit/state.js';

export function evaluateFailureExitDecision(
  position: Position,
  currentPrice: number,
  nowUnixMs: number,
  curve: FailureExitCurves | null,
): PositionDecision {
  if (
    position.partial_exit_done ||
    position.pt1_done ||
    !position.management_params.pre_t1_failure_exit_enabled
  ) {
    return noDecision(currentPrice);
  }

  const favorableMove = position.side === 'short'
    ? position.entry_price - currentPrice
    : currentPrice - position.entry_price;

  const state = computeFailureExitState(position, favorableMove, nowUnixMs, position.management_params);
  position.mae_r_before_first_partial = state.maeR;

  const decision = evaluateFailureExit(state, position.management_params, curve);
  const trigger = decision.triggered[0];
  if (!trigger) return noDecision(currentPrice);

  if (trigger.lane === 'soft') {
    position.failure_review_soft_emitted = true;
    return noDecision(currentPrice);
  }

  if (trigger.lane === 'hard') {
    position.failure_exit_hard_fired = true;
    position.failure_exit_active_lane = 'hard';
    position.failure_exit_reason = trigger.reason;
    return {
      shouldExit: true,
      reason: 'failure_exit_hard',
      exitPrice: currentPrice,
      plannedExitPrice: currentPrice,
      isPartial: false,
      partialQuantity: 0,
    };
  }

  position.failure_exit_emergency_fired = true;
  position.failure_exit_active_lane = 'emergency';
  position.failure_exit_reason = trigger.reason;
  return {
    shouldExit: true,
    reason: 'failure_exit_emergency',
    exitPrice: currentPrice,
    plannedExitPrice: currentPrice,
    isPartial: false,
    partialQuantity: 0,
  };
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
