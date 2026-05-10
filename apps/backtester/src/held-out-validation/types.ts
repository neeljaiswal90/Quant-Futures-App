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
import type { UnixNsInput } from '../../../strategy_runtime/src/contracts/time.js';
import type {
  RealArchiveBacktestResult,
  RealArchiveExecutionFillPolicy,
  RealArchivePerTradeRecord,
  RealArchiveRuntimeMetrics,
  RealArchiveSessionSource,
  RealArchiveStrategyGenerator,
} from '../real-archive-execution/index.js';
import type { TradeMetricsSummary } from '../equity-metrics/index.js';

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

export interface HeldOutValidationRealArchiveOptions {
  readonly run_id: string;
  readonly input_spec: TierBOosInputSpec;
  readonly walk_forward_plan: WalkForwardPlan;
  readonly strategy_order: readonly StrategyId[];
  readonly archive_sessions: readonly RealArchiveSessionSource[];
  readonly run_started_at_ns: UnixNsInput;
  readonly validation_policy?: ValidationGatePolicy;
  readonly fill_policy?: Partial<RealArchiveExecutionFillPolicy>;
  readonly initial_equity_cents?: bigint;
  readonly strategy_generators?: Partial<Record<StrategyId, RealArchiveStrategyGenerator>>;
}

export type HeldOutValidationRealArchiveWindowStatus =
  | 'executed'
  | 'skipped_no_sessions'
  | 'failed';

export interface HeldOutValidationRealArchiveWindowResult {
  readonly result_schema_version: 1;
  readonly strategy_id: StrategyId;
  readonly window_id: string;
  readonly window_sequence: number;
  readonly test_start_session: string;
  readonly test_end_session: string;
  readonly status: HeldOutValidationRealArchiveWindowStatus;
  readonly reasons: readonly string[];
  readonly per_trade_records: readonly RealArchivePerTradeRecord[];
  readonly trade_summary: TradeMetricsSummary | null;
  readonly runtime_metrics: RealArchiveRuntimeMetrics | null;
}

export interface HeldOutValidationRealArchiveStrategyResult {
  readonly result_schema_version: 1;
  readonly strategy_id: StrategyId;
  readonly fingerprint_sha256: string;
  readonly windows: readonly HeldOutValidationRealArchiveWindowResult[];
  readonly total_trades: number;
}

export interface HeldOutValidationRealArchiveResult {
  readonly result_schema_version: 1;
  readonly run_id: string;
  readonly framework_result: HeldOutValidationRunResult;
  readonly per_strategy_real_records: readonly HeldOutValidationRealArchiveStrategyResult[];
  readonly raw_execution_results: readonly RealArchiveBacktestResult[];
}
