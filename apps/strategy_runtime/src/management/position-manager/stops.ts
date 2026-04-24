import type { IndicatorConfig } from '../../contracts/config.js';
import type { Position, PositionDecision } from '../../contracts/position.js';
import type { ContractSpec } from '../../risk/contracts.js';
import { roundToTick, ticksToPrice } from '../../risk/contracts.js';

export interface RiskMutations {
  moveStopToBE: boolean;
  activatePreT1Trail: boolean;
  newTrailAnchor: number | null;
  newStopCurrent: number | null;
  emitTrailRatchetEvent: boolean;
  previousStopForEvent: number;
}

export interface RiskEvalResult {
  shouldExit: boolean;
  exitDecision: PositionDecision | null;
  proposedMutations: RiskMutations;
  hasMutations: boolean;
}

export const NO_RISK_MUTATIONS: RiskMutations = {
  moveStopToBE: false,
  activatePreT1Trail: false,
  newTrailAnchor: null,
  newStopCurrent: null,
  emitTrailRatchetEvent: false,
  previousStopForEvent: 0,
};

export function shouldAllowTimeStop(
  partialExitDone: boolean,
  unrealizedR: number,
  peakR: number,
  config: IndicatorConfig,
  timeStopThresholds?: Pick<
    Position['management_params'],
    'time_stop_max_r_pre_t1' | 'time_stop_max_r_post_t1'
  >,
): { allowed: boolean; reason: string } {
  if (!partialExitDone) {
    const threshold = timeStopThresholds?.time_stop_max_r_pre_t1 ?? config.time_stop_max_r_pre_t1;
    if (unrealizedR <= threshold) {
      return {
        allowed: true,
        reason: `pre_t1 unrealizedR=${unrealizedR.toFixed(2)} <= threshold=${threshold}`,
      };
    }
    return {
      allowed: false,
      reason: `pre_t1 protected: unrealizedR=${unrealizedR.toFixed(2)} > threshold=${threshold}`,
    };
  }

  const threshold = timeStopThresholds?.time_stop_max_r_post_t1 ?? config.time_stop_max_r_post_t1;
  if (unrealizedR <= threshold) {
    return {
      allowed: true,
      reason: `post_t1 stalled: unrealizedR=${unrealizedR.toFixed(2)} <= threshold=${threshold} (peakR=${peakR.toFixed(2)})`,
    };
  }
  return {
    allowed: false,
    reason: `post_t1 protected: unrealizedR=${unrealizedR.toFixed(2)} > threshold=${threshold} — let it run`,
  };
}

export function evaluateRiskMutations(
  position: Position,
  currentPrice: number,
  contract: ContractSpec,
): RiskEvalResult {
  const isShort = position.side === 'short';
  const management = position.management_params;
  const favorableMove = isShort
    ? position.entry_price - currentPrice
    : currentPrice - position.entry_price;

  const mutations: RiskMutations = {
    ...NO_RISK_MUTATIONS,
    previousStopForEvent: position.stop_current,
  };

  let effectiveStop = position.stop_current;
  const initialRiskPts = Math.abs(position.entry_price - position.stop_initial);
  const currentR = initialRiskPts > 0 ? favorableMove / initialRiskPts : 0;

  if (!position.partial_exit_done && !position.pre_t1_be_triggered && management.breakeven_trigger_r > 0) {
    const beStop = roundToTick(position.entry_price, contract);
    const tightens = isShort ? beStop < effectiveStop : beStop > effectiveStop;
    if (currentR >= management.breakeven_trigger_r && tightens) {
      mutations.moveStopToBE = true;
      effectiveStop = beStop;
    }
  }

  if (!position.partial_exit_done && !position.pre_t1_trailing_active && management.pre_t1_trail_trigger_r > 0) {
    if (currentR >= management.pre_t1_trail_trigger_r) {
      mutations.activatePreT1Trail = true;
    }
  }

  const trailingWillBeActive = position.trailing_active || mutations.activatePreT1Trail;
  const trailTicks = mutations.activatePreT1Trail
    ? Math.max(0, Math.floor(management.pre_t1_trail_distance_ticks))
    : position.trail_distance_ticks;

  if (trailingWillBeActive && trailTicks > 0) {
    const trailDistPts = ticksToPrice(trailTicks, contract);
    let anchor = position.trail_anchor_price ?? currentPrice;
    if (mutations.activatePreT1Trail) {
      anchor = currentPrice;
    }
    const improved = isShort ? currentPrice < anchor : currentPrice > anchor;
    if (improved || mutations.activatePreT1Trail) {
      mutations.newTrailAnchor = currentPrice;
      anchor = currentPrice;
    }
    const rawTrail = isShort ? anchor + trailDistPts : anchor - trailDistPts;
    const trailStop = roundToTick(rawTrail, contract);
    const tighten = isShort ? trailStop < effectiveStop : trailStop > effectiveStop;
    if (tighten) {
      mutations.newStopCurrent = trailStop;
      mutations.emitTrailRatchetEvent = true;
      mutations.previousStopForEvent = effectiveStop;
      effectiveStop = trailStop;
    }
  }

  const stopHit = isShort ? currentPrice >= effectiveStop : currentPrice <= effectiveStop;
  const hasMutations =
    mutations.moveStopToBE ||
    mutations.activatePreT1Trail ||
    mutations.newTrailAnchor !== null ||
    mutations.newStopCurrent !== null;

  if (stopHit) {
    return {
      shouldExit: true,
      exitDecision: {
        shouldExit: true,
        reason: 'stop_loss',
        exitPrice: currentPrice,
        plannedExitPrice: effectiveStop,
        isPartial: false,
        partialQuantity: 0,
      },
      proposedMutations: mutations,
      hasMutations,
    };
  }

  return {
    shouldExit: false,
    exitDecision: null,
    proposedMutations: mutations,
    hasMutations,
  };
}
