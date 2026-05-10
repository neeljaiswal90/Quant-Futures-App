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
  RealArchiveExitReason,
  RealArchivePerTradeRecord,
  RealArchiveRegimeLabel,
  RealArchiveRuntimeMetrics,
  RealArchiveSessionSource,
  RealArchiveStrategyGenerator,
  SpreadBucket,
  QueueAheadBucket,
} from '../real-archive-execution/index.js';
import type { RatioPpm, TradeMetricsSummary } from '../equity-metrics/index.js';

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
  readonly artifact_output?: HeldOutValidationArtifactOutputOptions;
}

export type HeldOutValidationStrategyFamily =
  | 'continuation'
  | 'mean_reversion'
  | 'reversal';

export interface HeldOutValidationArtifactInputHashes {
  readonly feb: string;
  readonly mar: string;
  readonly apr: string;
}

export interface HeldOutValidationArtifactMetadata {
  readonly strategy_family: HeldOutValidationStrategyFamily;
  readonly parameter_lock_source: string;
  readonly parameter_lock_hash: string;
  readonly input_substrate_hash: string;
  readonly input_manifest_hashes: HeldOutValidationArtifactInputHashes;
}

export interface HeldOutValidationArtifactOutputOptions {
  readonly output_dir: string;
  readonly metadata_by_strategy?: Partial<Record<StrategyId, HeldOutValidationArtifactMetadata>>;
  readonly default_metadata?: HeldOutValidationArtifactMetadata;
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
  readonly artifact_paths?: readonly string[];
}

export interface HeldOutValidationArtifactWalkForwardPolicy {
  readonly train: number;
  readonly validation: number;
  readonly test: number;
  readonly step: number;
  readonly min_required_sessions: number;
  readonly policy_version: number;
}

export type HeldOutValidationArtifactRegime = Exclude<RealArchiveRegimeLabel, 'unknown'>;
export type HeldOutValidationArtifactSpreadBucket = Exclude<SpreadBucket, 'unknown'>;
export type HeldOutValidationArtifactQueueAheadBucket = Exclude<QueueAheadBucket, 'unknown'>;
export type HeldOutValidationArtifactExitReason = Exclude<RealArchiveExitReason, 'unknown' | 'strategy_exit'>;

export interface HeldOutValidationArtifactTradeV1 {
  readonly entry_ts_ns: string;
  readonly exit_ts_ns: string;
  readonly side: 'long' | 'short';
  readonly regime: HeldOutValidationArtifactRegime;
  readonly spread_bucket: HeldOutValidationArtifactSpreadBucket;
  readonly queue_ahead_bucket: HeldOutValidationArtifactQueueAheadBucket;
  readonly gross_pnl_cents: string;
  readonly net_pnl_cents: string;
  readonly exit_reason: HeldOutValidationArtifactExitReason;
  readonly exit_bar_index: number;
  readonly max_favorable_excursion_cents: string;
  readonly max_adverse_excursion_cents: string;
}

export interface HeldOutValidationArtifactWindowV1 {
  readonly strategy_id: StrategyId;
  readonly window_id: string;
  readonly sequence: number;
  readonly role: 'test';
  readonly start_session: string;
  readonly end_session: string;
  readonly start_index: number;
  readonly end_index: number;
  readonly total_trades: number;
  readonly gross_profit_cents: string;
  readonly gross_loss_cents: string;
  readonly net_pnl_cents: string;
  readonly profit_factor_ppm: RatioPpm | null;
  readonly max_drawdown_cents: string;
  readonly initial_equity_cents: string;
  readonly average_trade_pnl_cents: string | null;
  readonly win_rate_ppm: RatioPpm;
  readonly fingerprint_sha256: string;
  readonly fingerprint_algorithm: string;
}

export interface HeldOutValidationArtifactTradeMetricsSummaryV1 {
  readonly total_trades: number;
  readonly winning_trades: number;
  readonly losing_trades: number;
  readonly flat_trades: number;
  readonly gross_profit_cents: string;
  readonly gross_loss_cents: string;
  readonly net_pnl_cents: string;
  readonly average_trade_pnl_cents: string | null;
  readonly average_win_cents: string | null;
  readonly average_loss_cents: string | null;
  readonly win_rate_ppm: RatioPpm;
  readonly profit_factor_ppm: RatioPpm | null;
  readonly max_drawdown_cents: string;
  readonly final_equity_cents: string;
  readonly peak_equity_cents: string;
}

export type HeldOutValidationArtifactCapabilityStatus =
  | 'ready_for_replay'
  | 'ready_for_live';

export interface HeldOutValidationArtifactV1 {
  readonly schema_version: 1;
  readonly methodology_id: 'qfa-410-v1';
  readonly strategy_id: StrategyId;
  readonly strategy_family: HeldOutValidationStrategyFamily;
  readonly strategy_fingerprint_sha256: string;
  readonly parameter_lock_source: string;
  readonly parameter_lock_hash: string;
  readonly capability_status: HeldOutValidationArtifactCapabilityStatus;
  readonly walk_forward_policy: HeldOutValidationArtifactWalkForwardPolicy;
  readonly windows: readonly HeldOutValidationArtifactWindowV1[];
  readonly trades: readonly HeldOutValidationArtifactTradeV1[];
  readonly session_returns: readonly number[];
  readonly aggregate: HeldOutValidationArtifactTradeMetricsSummaryV1;
  readonly gating_pnl_basis: 'net';
  readonly input_substrate_hash: string;
  readonly input_manifest_hashes: HeldOutValidationArtifactInputHashes;
}
