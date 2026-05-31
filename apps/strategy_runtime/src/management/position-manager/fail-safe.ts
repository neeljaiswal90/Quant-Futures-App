import {
  validateTargetPosition,
  type TargetPosition,
} from '../target-position.js';
import type {
  PositionManagerMarketInput,
  PositionManagerStepResult,
} from './index.js';
import { closePosition, isStopHit } from './stops.js';
import { computeRealizedPnlUsd } from './targets.js';
import type { ManagementProfile } from '../types.js';

export function evaluateFailSafe(
  position: TargetPosition,
  profile: ManagementProfile,
  market: PositionManagerMarketInput,
): PositionManagerStepResult {
  const reason = firstFailSafeReason(position, profile, market);
  if (reason === undefined) {
    return { position, actions: [], reasons: [] };
  }

  if (
    reason === 'fail_safe:max_adverse_r_exceeded' &&
    Number.isFinite(position.active_stop_price) &&
    position.active_stop_price > 0 &&
    isStopHit(position, market)
  ) {
    return {
      position,
      actions: [],
      reasons: ['fail_safe:declined_stop_overlap'],
    };
  }

  const exitQuantity = Math.max(0, Math.floor(position.remaining_quantity));
  const exitPrice = Number.isFinite(market.mark_price) ? market.mark_price : position.entry_price;
  const realizedPnlUsd = exitQuantity > 0
    ? computeRealizedPnlUsd(position, exitPrice, exitQuantity)
    : 0;

  return {
    position: closePosition(position, {
      market: {
        ...market,
        mark_price: exitPrice,
      },
      realized_pnl_usd: realizedPnlUsd,
      reason,
    }),
    actions: [{
      action_type: 'FAIL_SAFE_EXIT',
      reason,
      exit_quantity: exitQuantity,
      exit_price: exitPrice,
      realized_pnl_usd: realizedPnlUsd,
      realized_r: computeRealizedR(position, exitPrice, exitQuantity),
    }],
    reasons: [reason],
    terminal_reason: 'fail_safe',
  };
}

function firstFailSafeReason(
  position: TargetPosition,
  profile: ManagementProfile,
  market: PositionManagerMarketInput,
): string | undefined {
  if (profile.profile_id !== position.profile_id || profile.profile_version !== position.profile_version) {
    return 'fail_safe:profile_mismatch';
  }
  if (market.is_stale === true || market.authority === 'stale' || market.authority === 'gap') {
    return 'fail_safe:stale_market';
  }
  if (!Number.isFinite(market.mark_price) || market.mark_price <= 0) {
    return 'fail_safe:invalid_market_price';
  }
  if (!Number.isFinite(position.active_stop_price) || position.active_stop_price <= 0) {
    return 'fail_safe:missing_stop';
  }
  if (!Number.isInteger(position.remaining_quantity) || position.remaining_quantity < 0) {
    return 'fail_safe:invalid_quantity';
  }
  const issues = validateTargetPosition(position);
  if (issues.length > 0) {
    return `fail_safe:invalid_target_position:${issues[0]?.path ?? 'unknown'}`;
  }
  if (position.fail_safe.enabled === true) {
    const maxAdverseR = position.fail_safe.max_adverse_r;
    if (Number.isFinite(maxAdverseR) && maxAdverseR > 0 && position.risk_points > 0) {
      const unrealizedPoints =
        position.side === 'long'
          ? market.mark_price - position.entry_price
          : position.entry_price - market.mark_price;
      const unrealizedR = unrealizedPoints / position.risk_points;
      const adverseR = -unrealizedR;
      if (adverseR >= maxAdverseR) {
        return 'fail_safe:max_adverse_r_exceeded';
      }
    }

    const maxSpreadTicks = position.fail_safe.max_spread_ticks;
    if (Number.isFinite(maxSpreadTicks) && maxSpreadTicks > 0) {
      const bidPx = market.bid_px;
      const askPx = market.ask_px;
      const hasBidAsk =
        typeof bidPx === 'number' &&
        Number.isFinite(bidPx) &&
        bidPx > 0 &&
        typeof askPx === 'number' &&
        Number.isFinite(askPx) &&
        askPx > 0 &&
        askPx >= bidPx;

      if (market.authority === 'authoritative' && !hasBidAsk) {
        return 'fail_safe:spread_unavailable_in_live_authoritative';
      }
      if (hasBidAsk) {
        const tickSize = position.instrument.tick_size;
        if (typeof tickSize === 'number' && tickSize > 0) {
          const spreadTicks = (askPx - bidPx) / tickSize;
          if (spreadTicks > maxSpreadTicks) {
            return 'fail_safe:max_spread_ticks_exceeded';
          }
        }
      }
    }
  }
  return undefined;
}

function computeRealizedR(
  position: TargetPosition,
  exitPrice: number,
  quantity: number,
): number {
  if (quantity <= 0 || position.risk_points <= 0) {
    return 0;
  }
  const points =
    position.side === 'long'
      ? exitPrice - position.entry_price
      : position.entry_price - exitPrice;
  return round6((points / position.risk_points) * quantity);
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
