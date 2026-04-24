import type { IndicatorConfig } from '../../contracts/config.js';
import type { Position, PositionDecision } from '../../contracts/position.js';
import { shouldAllowTimeStop } from './stops.js';

export function evaluateTimeStop(
  position: Position,
  currentPrice: number,
  config: IndicatorConfig,
  nowUnixMs: number,
): PositionDecision {
  const isShort = position.side === 'short';
  const favorableMove = isShort
    ? position.entry_price - currentPrice
    : currentPrice - position.entry_price;
  const holdMinutes = (nowUnixMs - position.entry_time_unix) / 60_000;
  if (holdMinutes < position.time_stop_minutes) {
    return noDecision(currentPrice);
  }

  const initialRiskPts = Math.abs(position.entry_price - position.stop_initial);
  const unrealizedR = initialRiskPts > 0 ? favorableMove / initialRiskPts : 0;
  const peakR = initialRiskPts > 0 ? position.max_favorable_excursion / initialRiskPts : 0;
  const anyPartialDone = position.partial_exit_done || position.pt1_done || position.pt2_done;
  const decision = shouldAllowTimeStop(anyPartialDone, unrealizedR, peakR, config, position.management_params);
  if (!decision.allowed) return noDecision(currentPrice);

  return {
    shouldExit: true,
    reason: 'time_stop',
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
