import type { ResolvedManagementParams } from '../../types.js';
import type { FailureExitState } from './state.js';
import type { FailureExitCurves } from './curves.js';
import { queryFailureExitCurve } from './curves.js';

export type FailureExitLane = 'soft' | 'hard' | 'emergency';

export interface FailureExitLaneTrigger {
  lane: FailureExitLane;
  reason: string;
  q20_peak?: number;
  q80_mae?: number;
}

export interface FailureExitDecision {
  triggered: FailureExitLaneTrigger[];
}

const PRECEDENCE: Record<FailureExitLane, number> = {
  emergency: 0,
  hard: 1,
  soft: 2,
};

export function evaluateFailureExit(
  state: FailureExitState,
  managementParams: ResolvedManagementParams,
  curve: FailureExitCurves | null,
): FailureExitDecision {
  if (!managementParams.pre_t1_failure_exit_enabled) {
    return { triggered: [] };
  }

  const triggered: FailureExitLaneTrigger[] = [];

  if (
    state.tMin >= managementParams.pre_t1_failure_soft_min_minutes &&
    state.progressRate < managementParams.pre_t1_failure_soft_progress_rate_max &&
    state.failureRatio > managementParams.pre_t1_failure_soft_failure_ratio_min
  ) {
    triggered.push({
      lane: 'soft',
      reason:
        `lane_A_soft: progressRate=${state.progressRate.toFixed(3)}<` +
        `${managementParams.pre_t1_failure_soft_progress_rate_max} ` +
        `failureRatio=${state.failureRatio.toFixed(2)}>` +
        `${managementParams.pre_t1_failure_soft_failure_ratio_min}`,
    });
  }

  if (state.tMin >= managementParams.pre_t1_failure_hard_min_minutes && curve !== null) {
    const quantiles = queryFailureExitCurve(curve, state.tMin);
    if (quantiles !== null) {
      const currentRCap = managementParams.pre_t1_failure_hard_current_r_alpha * quantiles.q20_peak;
      if (
        state.peakR < quantiles.q20_peak &&
        state.maeR > quantiles.q80_mae &&
        state.currentR <= currentRCap
      ) {
        triggered.push({
          lane: 'hard',
          reason:
            `lane_B_hard: peakR=${state.peakR.toFixed(3)}<Q20=${quantiles.q20_peak.toFixed(3)} ` +
            `maeR=${state.maeR.toFixed(3)}>Q80=${quantiles.q80_mae.toFixed(3)} ` +
            `currentR=${state.currentR.toFixed(3)}<=α·Q20=${currentRCap.toFixed(3)}`,
          q20_peak: quantiles.q20_peak,
          q80_mae: quantiles.q80_mae,
        });
      }
    }
  }

  if (
    state.tMin >= managementParams.pre_t1_failure_emergency_min_minutes &&
    state.maeR >= managementParams.pre_t1_failure_emergency_mae_r_floor &&
    state.failureRatio >= managementParams.pre_t1_failure_emergency_failure_ratio_min &&
    state.peakR < managementParams.pre_t1_failure_emergency_peak_r_max
  ) {
    const decayGate =
      managementParams.pre_t1_failure_emergency_decay_rate_min <= 0 ||
      state.decayRate === 0 ||
      state.decayRate >= managementParams.pre_t1_failure_emergency_decay_rate_min;

    if (decayGate) {
      triggered.push({
        lane: 'emergency',
        reason:
          `lane_C_emergency: maeR=${state.maeR.toFixed(3)}>=floor=` +
          `${managementParams.pre_t1_failure_emergency_mae_r_floor} ` +
          `failureRatio=${state.failureRatio.toFixed(2)}>=` +
          `${managementParams.pre_t1_failure_emergency_failure_ratio_min} ` +
          `peakR=${state.peakR.toFixed(3)}<` +
          `${managementParams.pre_t1_failure_emergency_peak_r_max}`,
      });
    }
  }

  triggered.sort((left, right) => PRECEDENCE[left.lane] - PRECEDENCE[right.lane]);
  return { triggered };
}
