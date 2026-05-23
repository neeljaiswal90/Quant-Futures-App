import type { TargetPosition, TargetPositionTarget } from '../target-position.js';
import type {
  PositionManagerActionDraft,
  PositionManagerMarketInput,
  PositionManagerStepResult,
} from './index.js';

export function applyTargetHits(
  position: TargetPosition,
  market: PositionManagerMarketInput,
): PositionManagerStepResult {
  if (position.lifecycle_state === 'closed' || position.remaining_quantity <= 0) {
    return { position, actions: [], reasons: ['targets:position_not_open'] };
  }

  let current = position;
  const actions: PositionManagerActionDraft[] = [];
  const reasons: string[] = [];

  for (const target of position.targets) {
    if (target.status !== 'pending' || target.quantity <= 0) {
      continue;
    }
    if (!isTargetHit(position, target, market)) {
      continue;
    }

    const fillQuantity = Math.min(target.quantity, current.remaining_quantity);
    if (fillQuantity <= 0) {
      continue;
    }

    const realizedPnlUsd = computeRealizedPnlUsd(current, target.price, fillQuantity);
    const realizedR = round6(target.reward_risk * fillQuantity);
    const nextRemaining = current.remaining_quantity - fillQuantity;
    const isFlat = nextRemaining === 0;
    const updatedTargets = current.targets.map((item) => {
      if (item.label !== target.label) return item;
      return {
        ...item,
        filled_quantity: item.quantity,
        status: 'filled',
      } satisfies TargetPositionTarget;
    });

    current = {
      ...current,
      lifecycle_state: isFlat ? 'closed' : 'open',
      remaining_quantity: nextRemaining,
      targets: updatedTargets,
      pt1_touched: current.pt1_touched || target.label === 'pt1',
      realized_pnl_usd: round6(current.realized_pnl_usd + realizedPnlUsd),
      updated_ts_ns: market.event_ts_ns,
      reasons: [
        ...current.reasons,
        `target:${target.label}:filled`,
      ],
    };
    actions.push({
      action_type: target.label === 'pt2' || isFlat ? 'TAKE_PROFIT' : 'TAKE_PARTIAL',
      reason: `target:${target.label}:hit`,
      exit_quantity: fillQuantity,
      exit_price: target.price,
      target_label: target.label,
      realized_pnl_usd: round6(realizedPnlUsd),
      realized_r: realizedR,
    });
    reasons.push(`target:${target.label}:hit`);

    if (isFlat) {
      return {
        position: current,
        actions,
        reasons,
        terminal_reason: 'target_exit',
      };
    }
  }

  return { position: current, actions, reasons };
}

export function markPt1Touched(
  position: TargetPosition,
  market: PositionManagerMarketInput,
): PositionManagerStepResult {
  if (position.lifecycle_state === 'closed' || position.remaining_quantity <= 0 || position.pt1_touched) {
    return { position, actions: [], reasons: [] };
  }
  const pt1 = position.targets.find((target) => target.label === 'pt1');
  if (pt1 === undefined || pt1.status !== 'pending' || !isTargetHit(position, pt1, market)) {
    return { position, actions: [], reasons: [] };
  }
  return {
    position: {
      ...position,
      pt1_touched: true,
    },
    actions: [],
    reasons: [],
  };
}

export function computePositionUnrealizedPnlUsd(
  position: TargetPosition,
  markPrice: number,
): number {
  if (!Number.isFinite(markPrice) || position.remaining_quantity <= 0) {
    return 0;
  }
  const points =
    position.side === 'long'
      ? markPrice - position.entry_price
      : position.entry_price - markPrice;
  return round6(points * position.remaining_quantity * position.instrument.point_value);
}

export function computeRealizedPnlUsd(
  position: TargetPosition,
  exitPrice: number,
  quantity: number,
): number {
  const points =
    position.side === 'long'
      ? exitPrice - position.entry_price
      : position.entry_price - exitPrice;
  return round6(points * quantity * position.instrument.point_value);
}

export function computeUnrealizedR(position: TargetPosition, markPrice: number): number {
  if (!Number.isFinite(markPrice) || position.risk_points <= 0) {
    return 0;
  }
  const points =
    position.side === 'long'
      ? markPrice - position.entry_price
      : position.entry_price - markPrice;
  return round6(points / position.risk_points);
}

export function isTargetHit(
  position: TargetPosition,
  target: TargetPositionTarget,
  market: PositionManagerMarketInput,
): boolean {
  if (position.side === 'long') {
    return (market.high_price ?? market.mark_price) >= target.price;
  }
  return (market.low_price ?? market.mark_price) <= target.price;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
