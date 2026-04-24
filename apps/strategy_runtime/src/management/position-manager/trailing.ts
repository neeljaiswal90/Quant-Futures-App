import type { Position } from '../../contracts/position.js';
import type { ContractSpec } from '../../risk/contracts.js';
import { roundToTick } from '../../risk/contracts.js';
import type { RiskMutations } from './stops.js';

export function applyRiskMutations(
  position: Position,
  mutations: RiskMutations,
  currentPrice: number,
): void {
  if (mutations.moveStopToBE) {
    position.stop_current = position.entry_price;
    position.pre_t1_be_triggered = true;
    position.stop_moved_to_be = true;
  }

  if (mutations.activatePreT1Trail) {
    position.pre_t1_trailing_active = true;
    position.trailing_active = true;
    position.trail_distance_ticks = Math.max(0, Math.floor(position.management_params.pre_t1_trail_distance_ticks));
    position.trail_anchor_price = mutations.newTrailAnchor ?? currentPrice;
  } else if (mutations.newTrailAnchor !== null) {
    position.trail_anchor_price = mutations.newTrailAnchor;
  }

  if (mutations.newStopCurrent !== null) {
    position.stop_current = mutations.newStopCurrent;
  }
}

export function armPostTargetTrailing(
  position: Position,
  contract: ContractSpec,
): void {
  const trailTicks = Math.max(0, Math.floor(position.management_params.trail_ticks_post_t1));
  if (trailTicks <= 0) return;
  position.trailing_active = true;
  position.trail_distance_ticks = trailTicks;
  if (position.trail_anchor_price === null) {
    position.trail_anchor_price = roundToTick(position.last_checked_price, contract);
  }
}
