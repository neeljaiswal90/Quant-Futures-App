import type { TargetPosition } from '../target-position.js';
import type {
  PositionManagerActionDraft,
  PositionManagerMarketInput,
  PositionManagerStepResult,
} from './index.js';
import {
  computeRealizedPnlUsd,
  computeUnrealizedR,
} from './targets.js';

export function evaluateStopHit(
  position: TargetPosition,
  market: PositionManagerMarketInput,
): PositionManagerStepResult {
  if (position.lifecycle_state === 'closed' || position.remaining_quantity <= 0) {
    return { position, actions: [], reasons: ['stop:position_not_open'] };
  }
  if (!isStopHit(position, market)) {
    return { position, actions: [], reasons: [] };
  }

  const exitQuantity = position.remaining_quantity;
  const realizedPnlUsd = computeRealizedPnlUsd(position, position.active_stop_price, exitQuantity);
  const realizedR = round6(
    (position.side === 'long'
      ? position.active_stop_price - position.entry_price
      : position.entry_price - position.active_stop_price) /
      position.risk_points *
      exitQuantity,
  );
  const updated = closePosition(position, {
    market,
    realized_pnl_usd: realizedPnlUsd,
    reason: 'stop:hit',
  });

  return {
    position: updated,
    actions: [{
      action_type: 'EXIT_FULL',
      reason: 'stop:hit',
      exit_quantity: exitQuantity,
      exit_price: position.active_stop_price,
      realized_pnl_usd: realizedPnlUsd,
      realized_r: realizedR,
    }],
    reasons: ['stop:hit'],
    terminal_reason: 'stop_hit',
  };
}

export function maybeMoveStopToBreakEven(
  position: TargetPosition,
  market: PositionManagerMarketInput,
): PositionManagerStepResult {
  if (
    position.lifecycle_state === 'closed' ||
    position.remaining_quantity <= 0 ||
    !position.break_even.enabled ||
    position.break_even.moved
  ) {
    return { position, actions: [], reasons: [] };
  }
  if (!isBreakEvenTriggerMet(position, market)) {
    return { position, actions: [], reasons: [] };
  }

  const proposedStop = computeBreakEvenStop(position);
  const nextStop = moveStopTowardProfit(position, proposedStop);
  if (nextStop === position.active_stop_price) {
    return {
      position: {
        ...position,
        break_even: {
          ...position.break_even,
          moved: true,
        },
        updated_ts_ns: market.event_ts_ns,
        reasons: [...position.reasons, 'break_even:armed_without_stop_move'],
      },
      actions: [{
        action_type: 'MARK_BREAKEVEN',
        reason: 'break_even:armed_without_stop_move',
        new_stop_price: nextStop,
      }],
      reasons: ['break_even:armed_without_stop_move'],
    };
  }

  return {
    position: {
      ...position,
      active_stop_price: nextStop,
      break_even: {
        ...position.break_even,
        moved: true,
      },
      updated_ts_ns: market.event_ts_ns,
      reasons: [...position.reasons, 'break_even:stop_moved'],
    },
    actions: [{
      action_type: 'MARK_BREAKEVEN',
      reason: 'break_even:stop_moved',
      new_stop_price: nextStop,
    }],
    reasons: ['break_even:stop_moved'],
  };
}

export function moveStopTowardProfit(position: TargetPosition, proposedStop: number): number {
  if (!Number.isFinite(proposedStop)) {
    return position.active_stop_price;
  }
  if (position.side === 'long') {
    return proposedStop > position.active_stop_price ? proposedStop : position.active_stop_price;
  }
  return proposedStop < position.active_stop_price ? proposedStop : position.active_stop_price;
}

export function closePosition(
  position: TargetPosition,
  input: {
    readonly market: PositionManagerMarketInput;
    readonly realized_pnl_usd: number;
    readonly reason: string;
  },
): TargetPosition {
  return {
    ...position,
    lifecycle_state: 'closed',
    remaining_quantity: 0,
    targets: position.targets.map((target) => (
      target.status === 'pending'
        ? { ...target, status: 'cancelled' }
        : target
    )),
    realized_pnl_usd: round6(position.realized_pnl_usd + input.realized_pnl_usd),
    unrealized_pnl_usd: 0,
    updated_ts_ns: input.market.event_ts_ns,
    reasons: [...position.reasons, input.reason],
  };
}

export function isStopHit(position: TargetPosition, market: PositionManagerMarketInput): boolean {
  if (position.side === 'long') {
    return (market.low_price ?? market.mark_price) <= position.active_stop_price;
  }
  return (market.high_price ?? market.mark_price) >= position.active_stop_price;
}

export function isBreakEvenTriggerMet(
  position: TargetPosition,
  market: PositionManagerMarketInput,
): boolean {
  if (position.break_even.trigger === 'after_pt1') {
    return position.pt1_touched;
  }
  return computeUnrealizedR(position, market.mark_price) >= (position.break_even.trigger_r ?? 0);
}

function computeBreakEvenStop(position: TargetPosition): number {
  const offset = position.break_even.offset_ticks * position.instrument.tick_size;
  return position.side === 'long'
    ? round6(position.entry_price + offset)
    : round6(position.entry_price - offset);
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
