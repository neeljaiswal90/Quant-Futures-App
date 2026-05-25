import type { TargetPosition } from '../target-position.js';
import type { PositionManagerMarketInput, PositionManagerStepResult } from './index.js';
import { closePosition } from './stops.js';
import { computeRealizedPnlUsd } from './targets.js';

export function evaluateTimeStop(
  position: TargetPosition,
  market: PositionManagerMarketInput,
): PositionManagerStepResult {
  if (
    position.lifecycle_state === 'closed' ||
    position.remaining_quantity <= 0 ||
    !position.time_stop.enabled ||
    position.time_stop.deadline_ts_ns === undefined ||
    market.event_ts_ns < position.time_stop.deadline_ts_ns
  ) {
    return { position, actions: [], reasons: [] };
  }

  const pt1Touched = position.pt1_touched === true;
  const unrealizedR = computeUnrealizedR(position, market);
  const mode = position.time_stop.at_deadline_extension;

  switch (mode) {
    case 'enforce_floor': {
      const threshold = pt1Touched
        ? position.time_stop.post_pt1_min_unrealized_r
        : position.time_stop.pre_pt1_min_unrealized_r;

      if (typeof threshold === 'number' && Number.isFinite(threshold) && unrealizedR >= threshold) {
        const heldReason = pt1Touched
          ? 'time_stop:held_past_deadline_post_pt1'
          : 'time_stop:held_past_deadline_pre_pt1';
        return {
          position,
          actions: [],
          reasons: [heldReason],
        };
      }
      return exitOnDeadline(position, market);
    }

    case 'move_to_be':
      return unrealizedR < 0
        ? exitOnDeadline(position, market)
        : moveStopToBreakEvenAtDeadline(position, market);

    case 'activate_trail':
      return unrealizedR < 0
        ? exitOnDeadline(position, market)
        : activateTrailAtDeadline(position, market);

    case 'unconditional_exit':
      return exitOnDeadline(position, market);
  }
}

export function stopTighter(
  currentStop: number,
  candidateStop: number,
  side: TargetPosition['side'],
): number {
  return side === 'long'
    ? Math.max(currentStop, candidateStop)
    : Math.min(currentStop, candidateStop);
}

function computeUnrealizedR(position: TargetPosition, market: PositionManagerMarketInput): number {
  const unrealizedPoints = position.side === 'long'
    ? market.mark_price - position.entry_price
    : position.entry_price - market.mark_price;
  return position.risk_points > 0 ? unrealizedPoints / position.risk_points : 0;
}

function moveStopToBreakEvenAtDeadline(
  position: TargetPosition,
  market: PositionManagerMarketInput,
): PositionManagerStepResult {
  if (position.break_even.moved === true) {
    return { position, actions: [], reasons: [] };
  }

  const nextStop = stopTighter(position.active_stop_price, position.entry_price, position.side);
  const reason = 'time_stop:moved_stop_to_be_at_deadline';
  const updatedPosition: TargetPosition = {
    ...position,
    active_stop_price: nextStop,
    break_even: {
      ...position.break_even,
      moved: true,
    },
    updated_ts_ns: market.event_ts_ns,
    reasons: [...position.reasons, reason],
  };
  return {
    position: updatedPosition,
    actions: [{
      action_type: 'BREAKEVEN_ARMED',
      reason,
      new_stop_price: nextStop,
    }],
    reasons: [reason],
  };
}

function activateTrailAtDeadline(
  position: TargetPosition,
  market: PositionManagerMarketInput,
): PositionManagerStepResult {
  if (position.trailing_stop.active === true) {
    return { position, actions: [], reasons: [] };
  }

  const tickSize = position.instrument.tick_size;
  const distance = position.trailing_stop.distance_ticks * tickSize;
  const anchor = market.mark_price;
  const rawTrailStop = position.side === 'long'
    ? anchor - distance
    : anchor + distance;
  const beFlooredStop = stopTighter(rawTrailStop, position.entry_price, position.side);
  const nextStop = stopTighter(position.active_stop_price, beFlooredStop, position.side);
  const reason = 'time_stop:activated_trail_at_deadline';
  const updatedPosition: TargetPosition = {
    ...position,
    active_stop_price: nextStop,
    trailing_stop: {
      ...position.trailing_stop,
      active: true,
    },
    updated_ts_ns: market.event_ts_ns,
    reasons: [...position.reasons, reason],
  };
  return {
    position: updatedPosition,
    actions: [{
      action_type: 'ACTIVATE_TRAIL',
      reason,
      new_stop_price: nextStop,
    }],
    reasons: [reason],
  };
}

function exitOnDeadline(
  position: TargetPosition,
  market: PositionManagerMarketInput,
): PositionManagerStepResult {
  const exitQuantity = position.remaining_quantity;
  const realizedPnlUsd = computeRealizedPnlUsd(position, market.mark_price, exitQuantity);
  return {
    position: closePosition(position, {
      market,
      realized_pnl_usd: realizedPnlUsd,
      reason: 'time_stop:deadline_reached',
    }),
    actions: [{
      action_type: 'TIME_STOP_EXIT',
      reason: 'time_stop:deadline_reached',
      exit_quantity: exitQuantity,
      exit_price: market.mark_price,
      realized_pnl_usd: realizedPnlUsd,
      realized_r: computeRealizedR(position, market.mark_price, exitQuantity),
    }],
    reasons: ['time_stop:deadline_reached'],
    terminal_reason: 'time_stop',
  };
}

function computeRealizedR(position: TargetPosition, exitPrice: number, quantity: number): number {
  const points =
    position.side === 'long'
      ? exitPrice - position.entry_price
      : position.entry_price - exitPrice;
  return round6((points / position.risk_points) * quantity);
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
