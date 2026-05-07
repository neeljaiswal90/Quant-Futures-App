import type { StrategyCapabilityStatus } from '../capability-assessment/index.js';
import type { ValidationGateStatus } from '../validation-gate/index.js';
import type { WalkForwardPlan } from '../walk-forward/index.js';
import type {
  StrategyFingerprint,
  StrategyFingerprintSet,
} from '../strategy-fingerprint/index.js';
import type {
  CapabilityAssessmentSet,
  StrategyCapabilityAssessment,
} from '../capability-assessment/index.js';
import type {
  StrategyValidationGateResult,
  ValidationGateResultSet,
} from '../validation-gate/index.js';
import type { StrategyId } from '../../../strategy_runtime/src/contracts/strategy-ids.js';

export type OosReplayDataMode =
  | 'tier_b_corpus'
  | 'tier_b_projection_from_tier_a';

export type OosFidelityPrerequisiteStatus =
  | 'passed'
  | 'failed'
  | 'pending'
  | 'not_required';

export type StrategyOosWindowStatus =
  | 'evaluated'
  | 'blocked'
  | 'insufficient_evidence';

export type StrategyOosWindowReason =
  | 'fidelity_failed'
  | 'fidelity_pending'
  | 'fingerprint_missing'
  | 'capability_missing'
  | 'capability_blocked'
  | 'validation_gate_missing'
  | 'validation_gate_blocked'
  | 'framework_only_no_replay_execution';

export interface TierBOosInputSpec {
  readonly spec_schema_version: 1;
  readonly data_mode: OosReplayDataMode;
  readonly required_schemas: readonly ['mbp-1', 'trades'];
  readonly corpus_manifest_hashes: readonly string[];
  readonly fidelity_status: OosFidelityPrerequisiteStatus;
}

export interface StrategyOosWindowResult {
  readonly result_schema_version: 1;
  readonly strategy_id: StrategyId;
  readonly window_id: string;
  readonly window_sequence: number;
  readonly test_start_session: string;
  readonly test_end_session: string;
  readonly status: StrategyOosWindowStatus;
  readonly fingerprint_sha256: string | null;
  readonly capability_status: StrategyCapabilityStatus | null;
  readonly validation_status: ValidationGateStatus | null;
  readonly reasons: readonly StrategyOosWindowReason[];
}

export interface OosReplayFrameworkResult {
  readonly result_schema_version: 1;
  readonly input_spec: TierBOosInputSpec;
  readonly windows: readonly StrategyOosWindowResult[];
}

export interface BuildTierBOosReplayPlanArgs {
  readonly walk_forward_plan: WalkForwardPlan;
  readonly strategy_order: readonly StrategyId[];
  readonly input_spec: TierBOosInputSpec;
  readonly strategy_fingerprints?: StrategyFingerprintSet | readonly StrategyFingerprint[];
  readonly capability_assessments?: CapabilityAssessmentSet | readonly StrategyCapabilityAssessment[];
  readonly validation_gate_results?: ValidationGateResultSet | readonly StrategyValidationGateResult[];
}

export interface TierBOosManifestLike {
  readonly event_schemas: readonly string[];
}

export interface BuildTierBOosInputSpecArgs {
  readonly data_mode: OosReplayDataMode;
  readonly corpus_manifests: readonly TierBOosManifestLike[];
  readonly corpus_manifest_hashes: readonly string[];
  readonly fidelity_status?: OosFidelityPrerequisiteStatus;
}

export const TIER_B_OOS_REQUIRED_SCHEMAS = Object.freeze(['mbp-1', 'trades'] as const);
