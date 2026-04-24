import type { Position } from '../../../contracts/position.js';
import type { ResolvedManagementParams } from '../../types.js';

const EPSILON = 1e-6;

export interface FailureExitState {
  tMin: number;
  currentR: number;
  peakR: number;
  maeR: number;
  givebackR: number;
  progressRate: number;
  drawdownRate: number;
  failureRatio: number;
  netProgress: number;
  efficiency: number;
  recoveryGap: number;
  decayRate: number;
  tPeakMin: number | null;
}

export function computeFailureExitState(
  position: Position,
  favorableMovePts: number,
  nowUnixMs: number,
  managementParams: ResolvedManagementParams,
): FailureExitState {
  const tMin = Math.max(0, (nowUnixMs - position.entry_time_unix) / 60_000);
  const initialRiskPts = Math.abs(position.entry_price - position.stop_initial);
  const currentR = initialRiskPts > 0 ? favorableMovePts / initialRiskPts : 0;
  const peakR = position.peak_r_before_first_partial ?? 0;
  const maeR = initialRiskPts > 0 ? position.max_adverse_excursion / initialRiskPts : 0;
  const givebackR = peakR - currentR;
  const progressRate = peakR / (tMin + EPSILON);
  const drawdownRate = maeR / (tMin + EPSILON);
  const failureRatio = (maeR + EPSILON) / (peakR + EPSILON);
  const netProgress = currentR - managementParams.pre_t1_failure_lambda_net * maeR;
  const efficiency = peakR / (maeR + EPSILON);
  const recoveryGap = givebackR;
  const tPeakMin = position.t_peak_r_minutes;

  let decayRate = 0;
  if (tPeakMin !== null && peakR > 0) {
    const gap = tMin - tPeakMin;
    if (gap >= managementParams.pre_t1_failure_decay_min_gap_minutes) {
      decayRate = (peakR - currentR) / gap;
    }
  }

  return {
    tMin,
    currentR,
    peakR,
    maeR,
    givebackR,
    progressRate,
    drawdownRate,
    failureRatio,
    netProgress,
    efficiency,
    recoveryGap,
    decayRate,
    tPeakMin,
  };
}
