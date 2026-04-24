import type { TargetPosition } from '../target-position.js';
import type {
  PositionManagerActionDraft,
  PositionManagerMarketInput,
  PositionManagerStepResult,
} from './index.js';
import { moveStopTowardProfit } from './stops.js';
import { computeUnrealizedR } from './targets.js';

export function applyTrailingStop(
  position: TargetPosition,
  market: PositionManagerMarketInput,
): PositionManagerStepResult {
  if (
    position.lifecycle_state === 'closed' ||
    position.remaining_quantity <= 0 ||
    !position.trailing_stop.enabled ||
    position.trailing_stop.mode === 'disabled'
  ) {
    return { position, actions: [], reasons: [] };
  }

  if (!position.trailing_stop.active && !isTrailingActivationMet(position, market)) {
    return { position, actions: [], reasons: [] };
  }

  const proposedStop = computeTrailingStop(position, market);
  const nextStop = moveStopTowardProfit(position, proposedStop);
  const activatedNow = !position.trailing_stop.active;
  const moved = nextStop !== position.active_stop_price;
  if (!activatedNow && !moved) {
    return { position, actions: [], reasons: ['trailing:no_stop_improvement'] };
  }

  const action: PositionManagerActionDraft = {
    action_type: activatedNow ? 'ACTIVATE_TRAIL' : 'MOVE_STOP',
    reason: activatedNow ? 'trailing:activated' : 'trailing:stop_moved',
    new_stop_price: nextStop,
  };

  return {
    position: {
      ...position,
      active_stop_price: nextStop,
      trailing_stop: {
        ...position.trailing_stop,
        active: true,
      },
      updated_ts_ns: market.event_ts_ns,
      reasons: [
        ...position.reasons,
        action.reason,
      ],
    },
    actions: [action],
    reasons: [action.reason],
  };
}

function isTrailingActivationMet(
  position: TargetPosition,
  market: PositionManagerMarketInput,
): boolean {
  if (position.trailing_stop.activation === 'after_pt1') {
    return position.targets.some((target) => target.label === 'pt1' && target.status === 'filled');
  }
  return computeUnrealizedR(position, market.mark_price) >= (position.trailing_stop.activation_r ?? 0);
}

function computeTrailingStop(
  position: TargetPosition,
  market: PositionManagerMarketInput,
): number {
  const distance = position.trailing_stop.distance_ticks * position.instrument.tick_size;
  if (position.side === 'long') {
    return round6((market.high_price ?? market.mark_price) - distance);
  }
  return round6((market.low_price ?? market.mark_price) + distance);
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
