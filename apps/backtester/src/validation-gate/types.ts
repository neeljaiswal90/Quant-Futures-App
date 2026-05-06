import type {
  StrategyCapabilityAssessment,
  StrategyCapabilityStatus,
} from '../capability-assessment/index.js';
import type { StrategyFingerprint } from '../strategy-fingerprint/index.js';
import type { StrategyId } from '../../../strategy_runtime/src/contracts/strategy-ids.js';

export type ValidationGateStatus =
  | 'pass'
  | 'fail'
  | 'blocked'
  | 'insufficient_evidence';

export interface ValidationGatePolicy {
  readonly policy_schema_version: 1;
  readonly eligibility: ValidationEligibilityPolicy;
  readonly windowing: ValidationWindowingPolicy;
  readonly thresholds: ValidationThresholdPolicy;
  readonly trial_accounting: ValidationTrialAccountingPolicy;
  readonly statistics: ValidationStatisticsPolicy;
}

export interface ValidationEligibilityPolicy {
  readonly allowed_passing_capability_statuses: readonly StrategyCapabilityStatus[];
  readonly allow_degraded_replay_for_diagnostics: boolean;
  readonly allow_degraded_replay_to_pass: boolean;
  readonly require_strategy_fingerprint: boolean;
  readonly require_window_fingerprints: boolean;
  readonly required_fingerprint_algorithm: 'qfa_strategy_fingerprint_sha256_v1';
  readonly require_ci_determinism_coverage: boolean;
}

export interface ValidationWindowingPolicy {
  readonly evaluation_basis: 'test_only';
  readonly require_non_overlapping_test_windows: boolean;
  readonly on_overlap: 'insufficient_evidence';
  readonly require_all_planned_test_windows: boolean;
  readonly min_test_windows: number;
  readonly min_trades_total: number;
  readonly min_trades_per_window: number;
  readonly max_zero_trade_windows: number;
}

export interface ValidationThresholdPolicy {
  readonly min_aggregate_net_pnl_cents: bigint;
  readonly min_aggregate_profit_factor_ppm: number;
  readonly min_average_trade_pnl_cents: bigint;
  readonly min_positive_window_share_ppm: number;
  readonly max_worst_window_drawdown_ppm: number;
  readonly min_win_rate_ppm: number | null;
}

export interface ValidationTrialAccountingPolicy {
  readonly required: boolean;
  readonly effective_trial_scope: 'campaign';
  readonly effective_trial_method: 'max_of_manual_and_distinct_fingerprints';
  readonly high_trial_warning_threshold: number;
  readonly max_effective_trial_count_for_pass: number | null;
}

export interface ValidationStatisticsPolicy {
  readonly dsr: {
    readonly enabled: false;
    readonly min_confidence_ppm: null;
  };
  readonly white_reality_check: {
    readonly enabled: false;
    readonly max_pvalue_ppm: null;
  };
  readonly spa: {
    readonly enabled: false;
    readonly max_pvalue_ppm: null;
  };
  readonly pbo: {
    readonly enabled: false;
    readonly max_probability_ppm: null;
  };
}

export interface ValidationTrialAccounting {
  readonly trial_accounting_schema_version: 1;
  readonly strategy_id: StrategyId;
  readonly campaign_id: string;
  readonly raw_research_trials: number;
  readonly excluded_determinism_reruns: number;
  readonly manual_declared_effective_trials: number;
  readonly distinct_window_fingerprint_tuples: number;
  readonly effective_trial_count: number;
  readonly effective_trial_scope:
    | 'campaign'
    | 'strategy_family'
    | 'strategy_only';
  readonly effective_trial_method:
    | 'manual_declared'
    | 'distinct_window_fingerprint_tuples'
    | 'max_of_manual_and_distinct_fingerprints';
}

export type ValidationWindowRole = 'train' | 'validation' | 'test';

export interface StrategyValidationWindowInput {
  readonly strategy_id: StrategyId;
  readonly window_id: string;
  readonly sequence: number;
  readonly role: ValidationWindowRole;
  readonly start_session: string;
  readonly end_session: string;
  readonly start_index: number;
  readonly end_index: number;
  readonly total_trades: number;
  readonly gross_profit_cents: bigint;
  readonly gross_loss_cents: bigint;
  readonly net_pnl_cents: bigint;
  readonly profit_factor_ppm: number | null;
  readonly max_drawdown_cents: bigint;
  readonly initial_equity_cents: bigint;
  readonly average_trade_pnl_cents: bigint | null;
  readonly win_rate_ppm: number | null;
  readonly fingerprint_sha256: string;
  readonly fingerprint_algorithm: 'qfa_strategy_fingerprint_sha256_v1';
}

export interface StrategyValidationGateInput {
  readonly strategy_id: StrategyId;
  readonly capability_assessment: StrategyCapabilityAssessment;
  readonly fingerprint: StrategyFingerprint | null;
  readonly session_order: readonly string[];
  readonly windows: readonly StrategyValidationWindowInput[];
  readonly trial_accounting: ValidationTrialAccounting | null;
}

export type ValidationGateCheckStatus =
  | 'pass'
  | 'fail'
  | 'blocked'
  | 'not_evaluated';

export type ValidationGateCheckName =
  | 'capability_eligibility'
  | 'fingerprint_required'
  | 'determinism_required'
  | 'test_window_count'
  | 'non_overlapping_test_windows'
  | 'closed_trade_count_total'
  | 'closed_trade_count_per_window'
  | 'zero_trade_windows'
  | 'aggregate_net_pnl'
  | 'aggregate_profit_factor'
  | 'average_trade_pnl'
  | 'positive_window_share'
  | 'worst_window_drawdown'
  | 'trial_accounting_required'
  | 'trial_accounting_valid';

export interface ValidationGateCheck {
  readonly name: ValidationGateCheckName;
  readonly status: ValidationGateCheckStatus;
  readonly observed: string | number | bigint | null;
  readonly threshold: string | number | bigint | null;
  readonly message: string;
}

export type ValidationGateWarningCode =
  | 'degraded_replay_diagnostics_only'
  | 'high_effective_trial_count'
  | 'advanced_statistics_disabled'
  | 'validation_windows_excluded'
  | 'train_windows_excluded';

export interface ValidationGateWarning {
  readonly code: ValidationGateWarningCode;
  readonly message: string;
}

export type ValidationGateReason =
  | 'capability_status_blocked'
  | 'capability_status_degraded_replay'
  | 'missing_fingerprint'
  | 'missing_test_windows'
  | 'overlapping_test_windows'
  | 'insufficient_test_windows'
  | 'insufficient_closed_trades'
  | 'too_many_zero_trade_windows'
  | 'missing_trial_accounting'
  | 'invalid_trial_accounting'
  | 'threshold_failed';

export interface StrategyValidationGateResult {
  readonly result_schema_version: 1;
  readonly strategy_id: StrategyId;
  readonly status: ValidationGateStatus;
  readonly capability_status: StrategyCapabilityStatus;
  readonly fingerprint_sha256: string | null;
  readonly evaluated_test_windows: number;
  readonly zero_trade_windows: number;
  readonly aggregate_net_pnl_cents: bigint | null;
  readonly aggregate_profit_factor_ppm: number | null;
  readonly average_trade_pnl_cents: bigint | null;
  readonly worst_window_drawdown_ppm: number | null;
  readonly positive_window_share_ppm: number | null;
  readonly effective_trial_count: number | null;
  readonly trial_accounting_scope:
    | 'campaign'
    | 'strategy_family'
    | 'strategy_only'
    | null;
  readonly trial_accounting_method:
    | 'manual_declared'
    | 'distinct_window_fingerprint_tuples'
    | 'max_of_manual_and_distinct_fingerprints'
    | null;
  readonly checks: readonly ValidationGateCheck[];
  readonly warnings: readonly ValidationGateWarning[];
  readonly reasons: readonly ValidationGateReason[];
}

export interface ValidationGateResultSet {
  readonly result_set_schema_version: 1;
  readonly policy_version: 1;
  readonly results: readonly StrategyValidationGateResult[];
}
