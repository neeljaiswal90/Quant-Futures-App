import type {
  StrategyValidationGateResult,
  ValidationGateCheck,
  ValidationGateReason,
  ValidationGateResultSet,
  ValidationGateStatus,
  ValidationGateWarning,
} from '../validation-gate/index.js';

export const VALIDATION_REPORT_SCHEMA_VERSION = 1;

export interface ValidationReport {
  readonly report_schema_version: typeof VALIDATION_REPORT_SCHEMA_VERSION;
  readonly source_result_set_schema_version: ValidationGateResultSet['result_set_schema_version'];
  readonly policy_version: ValidationGateResultSet['policy_version'];
  readonly summary: ValidationReportSummary;
  readonly strategy_results: readonly ValidationReportStrategyResult[];
}

export interface ValidationReportSummary {
  readonly total_strategies: number;
  readonly pass: number;
  readonly fail: number;
  readonly blocked: number;
  readonly insufficient_evidence: number;
  readonly warning_count: number;
  readonly reason_count: number;
}

export interface ValidationReportStrategyResult {
  readonly strategy_id: StrategyValidationGateResult['strategy_id'];
  readonly status: ValidationGateStatus;
  readonly capability_status: StrategyValidationGateResult['capability_status'];
  readonly fingerprint_lineage: ValidationReportFingerprintLineage;
  readonly trial_accounting: ValidationReportTrialAccountingDisplay;
  readonly metrics: ValidationReportStrategyMetrics;
  readonly checks: readonly ValidationGateCheck[];
  readonly warnings: readonly ValidationGateWarning[];
  readonly reasons: readonly ValidationGateReason[];
}

export interface ValidationReportFingerprintLineage {
  readonly source: 'qfa-310-validation-gate-result';
  readonly fingerprint_sha256: string | null;
}

export interface ValidationReportTrialAccountingDisplay {
  readonly effective_trial_count: number | null;
  readonly scope: StrategyValidationGateResult['trial_accounting_scope'];
  readonly method: StrategyValidationGateResult['trial_accounting_method'];
}

export interface ValidationReportStrategyMetrics {
  readonly evaluated_test_windows: number;
  readonly zero_trade_windows: number;
  readonly aggregate_net_pnl_cents: bigint | null;
  readonly aggregate_profit_factor_ppm: number | null;
  readonly average_trade_pnl_cents: bigint | null;
  readonly worst_window_drawdown_ppm: number | null;
  readonly positive_window_share_ppm: number | null;
}
