import type { CandidateSetup } from '../../contracts/candidate.js';
import type { MarketSnapshot } from '../../contracts/market.js';

type Direction = CandidateSetup['direction'];

export function isTargetDirectionValid(
  target: number | null,
  entryMid: number,
  direction: Direction,
): boolean {
  if (target === null) return true;
  return direction === 'short' ? target < entryMid : target > entryMid;
}

export function fallbackTarget(
  entryMid: number,
  riskPts: number,
  rMultiple: number,
  direction: Direction,
): number {
  return direction === 'short'
    ? entryMid - riskPts * rMultiple
    : entryMid + riskPts * rMultiple;
}

export function clampTarget(
  candidate: number | null,
  entryMid: number,
  riskPts: number,
  fallbackR: number,
  direction: Direction,
): number {
  if (candidate !== null && isTargetDirectionValid(candidate, entryMid, direction)) {
    return candidate;
  }
  return fallbackTarget(entryMid, riskPts, fallbackR, direction);
}

export function computeRr(
  target: number,
  entryMid: number,
  riskPts: number,
  direction: Direction,
): number {
  if (!(riskPts > 0)) return 0;
  const rr = direction === 'short'
    ? (entryMid - target) / riskPts
    : (target - entryMid) / riskPts;
  return round2(rr);
}

export function isTargetSequenceValid(
  t1: number,
  t2: number,
  t3: number | null,
  direction: Direction,
): boolean {
  if (direction === 'short') {
    if (t2 >= t1) return false;
    if (t3 !== null && t3 >= t2) return false;
    return true;
  }
  if (t2 <= t1) return false;
  if (t3 !== null && t3 <= t2) return false;
  return true;
}

export function validateSetupTargets(
  setup: Pick<
    CandidateSetup,
    'direction' | 'entry_low' | 'entry_high' | 'target_1' | 'target_2' | 'target_3' | 'risk_pts'
  >,
): {
  target_1_direction_valid: boolean;
  target_2_direction_valid: boolean;
  target_3_direction_valid: boolean;
  target_ordering_valid: boolean;
  target_repair_applied: boolean;
} {
  const entryMid = (setup.entry_low + setup.entry_high) / 2;
  const t1Valid = isTargetDirectionValid(setup.target_1, entryMid, setup.direction);
  const t2Valid = isTargetDirectionValid(setup.target_2, entryMid, setup.direction);
  const t3Valid = isTargetDirectionValid(setup.target_3, entryMid, setup.direction);
  const orderingValid =
    t1Valid &&
    t2Valid &&
    t3Valid &&
    isTargetSequenceValid(setup.target_1, setup.target_2, setup.target_3, setup.direction);

  return {
    target_1_direction_valid: t1Valid,
    target_2_direction_valid: t2Valid,
    target_3_direction_valid: t3Valid,
    target_ordering_valid: orderingValid,
    target_repair_applied: false,
  };
}

export function hasRoomToUpside(
  snap: MarketSnapshot,
  entryMid: number,
  minRoomAtr: number = 1,
): boolean {
  const atr = snap.indicators_1m.atr_14;
  if (!(atr && atr > 0)) return true;
  const resistanceLevels: number[] = [];
  const levels = snap.key_levels;
  if (levels.session_high !== null && levels.session_high > entryMid) resistanceLevels.push(levels.session_high);
  if (levels.opening_range_high !== null && levels.opening_range_high > entryMid) resistanceLevels.push(levels.opening_range_high);
  for (const price of levels.pivot_resistance) {
    if (price > entryMid) {
      resistanceLevels.push(price);
      break;
    }
  }
  if (levels.prior_rth_high !== null && levels.prior_rth_high > entryMid) resistanceLevels.push(levels.prior_rth_high);
  if (resistanceLevels.length === 0) return true;
  const nearest = Math.min(...resistanceLevels);
  return nearest - entryMid >= atr * minRoomAtr;
}

export function hasRoomToDownside(
  snap: MarketSnapshot,
  entryMid: number,
  minRoomAtr: number = 1,
): boolean {
  const atr = snap.indicators_1m.atr_14;
  if (!(atr && atr > 0)) return true;
  const supportLevels: number[] = [];
  const levels = snap.key_levels;
  if (levels.session_low !== null && levels.session_low < entryMid) supportLevels.push(levels.session_low);
  if (levels.opening_range_low !== null && levels.opening_range_low < entryMid) supportLevels.push(levels.opening_range_low);
  for (const price of levels.pivot_support) {
    if (price < entryMid) {
      supportLevels.push(price);
      break;
    }
  }
  if (levels.prior_rth_low !== null && levels.prior_rth_low < entryMid) supportLevels.push(levels.prior_rth_low);
  if (supportLevels.length === 0) return true;
  const nearest = Math.max(...supportLevels);
  return entryMid - nearest >= atr * minRoomAtr;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
