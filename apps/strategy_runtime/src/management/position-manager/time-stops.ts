import type { TargetPosition } from '../target-position.js';
import type {
  PositionManagerMarketInput,
  PositionManagerStepResult,
} from './index.js';
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
  const threshold = pt1Touched
    ? position.time_stop.post_pt1_min_unrealized_r
    : position.time_stop.pre_pt1_min_unrealized_r;
  if (typeof threshold === 'number' && Number.isFinite(threshold)) {
    const unrealizedPoints =
      position.side === 'long'
        ? market.mark_price - position.entry_price
        : position.entry_price - market.mark_price;
    const unrealizedR = position.risk_points > 0 ? unrealizedPoints / position.risk_points : 0;
    if (unrealizedR >= threshold) {
      return {
        position,
        actions: [],
        reasons: [
          pt1Touched
            ? 'time_stop:held_past_deadline_post_pt1'
            : 'time_stop:held_past_deadline_pre_pt1',
        ],
      };
    }
  }

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

function computeRealizedR(
  position: TargetPosition,
  exitPrice: number,
  quantity: number,
): number {
  const points =
    position.side === 'long'
      ? exitPrice - position.entry_price
      : position.entry_price - exitPrice;
  return round6((points / position.risk_points) * quantity);
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
