import type { OrderResult } from '../../contracts/execution.js';
import type { Position, PositionDecision } from '../../contracts/position.js';
import type { ContractSpec } from '../../risk/contracts.js';
import { roundToTick } from '../../risk/contracts.js';
import { armPostTargetTrailing } from './trailing.js';

export function evaluateTargetDecision(
  position: Position,
  currentPrice: number,
): PositionDecision {
  const isShort = position.side === 'short';
  const favorableMove = isShort
    ? position.entry_price - currentPrice
    : currentPrice - position.entry_price;

  const t1Valid = isShort ? position.target_1 < position.entry_price : position.target_1 > position.entry_price;
  const t2Valid = isShort ? position.target_2 < position.entry_price : position.target_2 > position.entry_price;
  const t3Valid =
    position.target_3 === null
      ? true
      : (isShort ? position.target_3 < position.entry_price : position.target_3 > position.entry_price);

  if (t2Valid) {
    const t2Hit = isShort ? currentPrice <= position.target_2 : currentPrice >= position.target_2;
    if (t2Hit) {
      return {
        shouldExit: true,
        reason: 'target_2',
        exitPrice: currentPrice,
        plannedExitPrice: position.target_2,
        isPartial: false,
        partialQuantity: 0,
      };
    }
  }

  if (position.target_3 !== null && t3Valid) {
    const t3Hit = isShort ? currentPrice <= position.target_3 : currentPrice >= position.target_3;
    if (t3Hit) {
      return {
        shouldExit: true,
        reason: 'target_3',
        exitPrice: currentPrice,
        plannedExitPrice: position.target_3,
        isPartial: false,
        partialQuantity: 0,
      };
    }
  }

  if (!position.pt1_done && position.management_params.pt1_offset_pts > 0) {
    const pt1Hit = favorableMove >= position.management_params.pt1_offset_pts;
    if (pt1Hit) {
      const pt1Qty = Math.max(1, Math.floor(position.quantity_original * position.management_params.pt1_exit_fraction));
      const maxQty = position.quantity_remaining - 1;
      return {
        shouldExit: true,
        reason: 'partial_profit_1',
        exitPrice: currentPrice,
        plannedExitPrice: isShort
          ? position.entry_price - position.management_params.pt1_offset_pts
          : position.entry_price + position.management_params.pt1_offset_pts,
        isPartial: maxQty > 0,
        partialQuantity: maxQty > 0 ? Math.min(pt1Qty, maxQty) : 0,
      };
    }
  }

  if (position.pt1_done && !position.pt2_done && position.management_params.pt2_offset_pts > 0) {
    const pt2Hit = favorableMove >= position.management_params.pt2_offset_pts;
    if (pt2Hit) {
      const pt2Qty = Math.max(1, Math.floor(position.quantity_original * position.management_params.pt2_exit_fraction));
      const maxQty = position.quantity_remaining - 1;
      if (maxQty > 0) {
        return {
          shouldExit: true,
          reason: 'partial_profit_2',
          exitPrice: currentPrice,
          plannedExitPrice: isShort
            ? position.entry_price - position.management_params.pt2_offset_pts
            : position.entry_price + position.management_params.pt2_offset_pts,
          isPartial: true,
          partialQuantity: Math.min(pt2Qty, maxQty),
        };
      }
    }
  }

  if (!position.partial_exit_done && t1Valid) {
    const t1Hit = isShort ? currentPrice <= position.target_1 : currentPrice >= position.target_1;
    if (t1Hit) {
      return {
        shouldExit: true,
        reason: 'target_1',
        exitPrice: currentPrice,
        plannedExitPrice: position.target_1,
        isPartial: true,
        partialQuantity: Math.max(1, Math.floor(position.quantity_remaining / 2)),
      };
    }
  }

  return {
    shouldExit: false,
    reason: null,
    exitPrice: currentPrice,
    plannedExitPrice: currentPrice,
    isPartial: false,
    partialQuantity: 0,
  };
}

export function applyTarget1Partial(
  position: Position,
  fill: OrderResult,
  quantity: number,
  contract: ContractSpec,
): void {
  recordExitLeg(position, 'target_1', quantity, fill, contract);
  position.quantity_remaining = Math.max(0, position.quantity_remaining - quantity);
  position.partial_exit_done = true;
  position.stop_current = roundToTick(position.entry_price, contract);
  position.stop_moved_to_be = true;
  position.first_partial_fill_price ??= fill.fill_price;
  position.effective_target_1 = position.target_1;
  armPostTargetTrailing(position, contract);
}

export function applyPt1Exit(
  position: Position,
  fill: OrderResult,
  quantity: number,
  contract: ContractSpec,
): void {
  recordExitLeg(position, 'partial_profit_1', quantity, fill, contract);
  const lastLeg = position.exit_legs[position.exit_legs.length - 1];
  position.quantity_remaining = Math.max(0, position.quantity_remaining - quantity);
  position.pt1_done = true;
  position.pt1_qty_exited = quantity;
  position.pt1_realized_pnl = lastLeg?.pnl_usd ?? 0;
  position.first_partial_fill_price ??= fill.fill_price;
  position.effective_target_1 = position.target_1;
  if (position.management_params.pt1_move_to_be) {
    position.stop_current = roundToTick(position.entry_price, contract);
    position.stop_moved_to_be = true;
  }
  if (position.management_params.pt1_activate_trailing) {
    armPostTargetTrailing(position, contract);
  }
}

export function applyPt2Exit(
  position: Position,
  fill: OrderResult,
  quantity: number,
  contract: ContractSpec,
): void {
  recordExitLeg(position, 'partial_profit_2', quantity, fill, contract);
  const lastLeg = position.exit_legs[position.exit_legs.length - 1];
  position.quantity_remaining = Math.max(0, position.quantity_remaining - quantity);
  position.pt2_done = true;
  position.pt2_qty_exited = quantity;
  position.pt2_realized_pnl = lastLeg?.pnl_usd ?? 0;
}

function recordExitLeg(
  position: Position,
  reason: Position['exit_legs'][number]['reason'],
  quantity: number,
  fill: OrderResult,
  contract: ContractSpec,
): void {
  const pnlPoints = position.side === 'short'
    ? position.entry_price - fill.fill_price
    : fill.fill_price - position.entry_price;
  const pnlUsd = pnlPoints * quantity * contract.point_value - fill.fee_usd;
  position.exit_legs.push({
    reason,
    quantity,
    fill_price: fill.fill_price,
    fill_time_iso: fill.fill_time_iso,
    pnl_points: pnlPoints,
    pnl_usd: pnlUsd,
    fee_usd: fill.fee_usd,
    slippage_pts: fill.slippage_pts,
  });
  position.realized_pnl_usd += pnlUsd;
  position.realized_fees_usd += fill.fee_usd;
}
