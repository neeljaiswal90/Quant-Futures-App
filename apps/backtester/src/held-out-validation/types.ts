import type {
  CapabilityAssessmentSet,
  StrategyCapabilityStatus,
} from '../capability-assessment/index.js';
import type {
  OosReplayFrameworkResult,
  StrategyOosWindowReason,
  StrategyOosWindowStatus,
  TierBOosInputSpec,
} from '../oos-replay/index.js';
import type { StrategyFingerprintSet } from '../strategy-fingerprint/index.js';
import type { StrategyReplayEvaluation } from '../strategy-replay/index.js';
import type {
  StrategyValidationWindowInput,
  ValidationGatePolicy,
  ValidationGateResultSet,
  ValidationGateStatus,
  ValidationTrialAccounting,
} from '../validation-gate/index.js';
import type { WalkForwardPlan } from '../walk-forward/index.js';
import type { StrategyId } from '../../../strategy_runtime/src/contracts/strategy-ids.js';

export type HeldOutValidationWindowReplayStatus = StrategyOosWindowStatus;

export type HeldOutValidationWindowReason =
  | StrategyOosWindowReason
  | 'validation_gate_insufficient_evidence'
  | 'validation_gate_failed';

export interface HeldOutValidationRunOptions {
  readonly run_id: string;
  readonly input_spec: TierBOosInputSpec;
  readonly walk_forward_plan: WalkForwardPlan;
  readonly strategy_order: readonly StrategyId[];
  readonly validation_policy?: ValidationGatePolicy;

  /**
   * QFA-410 v1 is intentionally unit-testable without real archive access.
   * Callers may provide replay evaluations or precomputed artifact sets. When
   * omitted, the runner builds deterministic empty replay artifacts and the
   * downstream validation gate fails closed.
   */
  readonly replay_evaluations?: readonly StrategyReplayEvaluation[];
  readonly strategy_fingerprint_set?: StrategyFingerprintSet;
  readonly capability_assessment_set?: CapabilityAssessmentSet;
  readonly validation_windows?: readonly StrategyValidationWindowInput[];
  readonly trial_accounting?: readonly ValidationTrialAccounting[];
}

export interface HeldOutValidationWindowResult {
  readonly result_schema_version: 1;
  readonly strategy_id: StrategyId;
  readonly window_id: string;
  readonly window_sequence: number;
  readonly replay_status: HeldOutValidationWindowReplayStatus;
  readonly fingerprint_sha256: string | null;
  readonly capability_status: StrategyCapabilityStatus | null;
  readonly validation_status: ValidationGateStatus | null;
  readonly reasons: readonly HeldOutValidationWindowReason[];
}

export interface HeldOutValidationRunResult {
  readonly result_schema_version: 1;
  readonly run_id: string;
  readonly input_spec: TierBOosInputSpec;
  readonly oos_framework_result: OosReplayFrameworkResult;
  readonly validation_gate_result_set: ValidationGateResultSet;
  readonly window_results: readonly HeldOutValidationWindowResult[];
}
