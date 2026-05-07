import type {
  StrategyValidationGateResult,
  ValidationGateResultSet,
  ValidationGateStatus,
} from '../validation-gate/index.js';
import {
  VALIDATION_REPORT_SCHEMA_VERSION,
  type ValidationReport,
  type ValidationReportStrategyResult,
  type ValidationReportSummary,
} from './types.js';

export function createValidationReport(resultSet: ValidationGateResultSet): ValidationReport {
  const strategyResults = resultSet.results.map(toReportStrategyResult);

  return {
    report_schema_version: VALIDATION_REPORT_SCHEMA_VERSION,
    source_result_set_schema_version: resultSet.result_set_schema_version,
    policy_version: resultSet.policy_version,
    summary: summarizeResults(resultSet.results),
    strategy_results: strategyResults,
  };
}

function summarizeResults(
  results: readonly StrategyValidationGateResult[],
): ValidationReportSummary {
  const statusCounts: Record<ValidationGateStatus, number> = {
    pass: 0,
    fail: 0,
    blocked: 0,
    insufficient_evidence: 0,
  };

  let warningCount = 0;
  let reasonCount = 0;

  for (const result of results) {
    statusCounts[result.status] += 1;
    warningCount += result.warnings.length;
    reasonCount += result.reasons.length;
  }

  return {
    total_strategies: results.length,
    pass: statusCounts.pass,
    fail: statusCounts.fail,
    blocked: statusCounts.blocked,
    insufficient_evidence: statusCounts.insufficient_evidence,
    warning_count: warningCount,
    reason_count: reasonCount,
  };
}

function toReportStrategyResult(
  result: StrategyValidationGateResult,
): ValidationReportStrategyResult {
  return {
    strategy_id: result.strategy_id,
    status: result.status,
    capability_status: result.capability_status,
    fingerprint_lineage: {
      source: 'qfa-310-validation-gate-result',
      fingerprint_sha256: result.fingerprint_sha256,
    },
    trial_accounting: {
      effective_trial_count: result.effective_trial_count,
      scope: result.trial_accounting_scope,
      method: result.trial_accounting_method,
    },
    metrics: {
      evaluated_test_windows: result.evaluated_test_windows,
      zero_trade_windows: result.zero_trade_windows,
      aggregate_net_pnl_cents: result.aggregate_net_pnl_cents,
      aggregate_profit_factor_ppm: result.aggregate_profit_factor_ppm,
      average_trade_pnl_cents: result.average_trade_pnl_cents,
      worst_window_drawdown_ppm: result.worst_window_drawdown_ppm,
      positive_window_share_ppm: result.positive_window_share_ppm,
    },
    checks: result.checks,
    warnings: result.warnings,
    reasons: result.reasons,
  };
}
