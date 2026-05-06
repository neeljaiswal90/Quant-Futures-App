import { STRATEGY_FINGERPRINT_ALGORITHM } from '../strategy-fingerprint/index.js';
import {
  throwValidationGateIssues,
  type ValidationGateIssue,
} from './validation-gate-error.js';
import type { ValidationGatePolicy } from './types.js';

export const DEFAULT_VALIDATION_GATE_POLICY_V1 = Object.freeze({
  policy_schema_version: 1,
  eligibility: {
    allowed_passing_capability_statuses: ['ready_for_replay'] as const,
    allow_degraded_replay_for_diagnostics: true,
    allow_degraded_replay_to_pass: false,
    require_strategy_fingerprint: true,
    require_window_fingerprints: true,
    required_fingerprint_algorithm: STRATEGY_FINGERPRINT_ALGORITHM,
    require_ci_determinism_coverage: false,
  },
  windowing: {
    evaluation_basis: 'test_only',
    require_non_overlapping_test_windows: true,
    on_overlap: 'insufficient_evidence',
    require_all_planned_test_windows: true,
    min_test_windows: 8,
    min_trades_total: 80,
    min_trades_per_window: 5,
    max_zero_trade_windows: 1,
  },
  thresholds: {
    min_aggregate_net_pnl_cents: 1n,
    min_aggregate_profit_factor_ppm: 1_100_000,
    min_average_trade_pnl_cents: 1n,
    min_positive_window_share_ppm: 550_000,
    max_worst_window_drawdown_ppm: 50_000,
    min_win_rate_ppm: null,
  },
  trial_accounting: {
    required: true,
    effective_trial_scope: 'campaign',
    effective_trial_method: 'max_of_manual_and_distinct_fingerprints',
    high_trial_warning_threshold: 20,
    max_effective_trial_count_for_pass: null,
  },
  statistics: {
    dsr: { enabled: false, min_confidence_ppm: null },
    white_reality_check: { enabled: false, max_pvalue_ppm: null },
    spa: { enabled: false, max_pvalue_ppm: null },
    pbo: { enabled: false, max_probability_ppm: null },
  },
} as const satisfies ValidationGatePolicy);

export function resolveValidationGatePolicy(
  policy: ValidationGatePolicy = DEFAULT_VALIDATION_GATE_POLICY_V1,
): ValidationGatePolicy {
  validateValidationGatePolicy(policy);
  return policy;
}

export function validateValidationGatePolicy(policy: ValidationGatePolicy): void {
  const issues: ValidationGateIssue[] = [];
  if (policy.policy_schema_version !== 1) {
    issues.push(policyIssue('$.policy_schema_version', 'policy_schema_version must be 1'));
  }
  if (!policy.eligibility.allowed_passing_capability_statuses.includes('ready_for_replay')) {
    issues.push(
      policyIssue(
        '$.eligibility.allowed_passing_capability_statuses',
        'ready_for_replay must be an allowed passing capability status',
      ),
    );
  }
  if (policy.eligibility.allow_degraded_replay_to_pass) {
    issues.push(
      policyIssue(
        '$.eligibility.allow_degraded_replay_to_pass',
        'degraded_replay cannot pass in validation gate policy v1',
      ),
    );
  }
  if (policy.eligibility.required_fingerprint_algorithm !== STRATEGY_FINGERPRINT_ALGORITHM) {
    issues.push(
      policyIssue(
        '$.eligibility.required_fingerprint_algorithm',
        `required fingerprint algorithm must be ${STRATEGY_FINGERPRINT_ALGORITHM}`,
      ),
    );
  }
  if (policy.windowing.evaluation_basis !== 'test_only') {
    issues.push(policyIssue('$.windowing.evaluation_basis', 'evaluation_basis must be test_only'));
  }
  if (policy.windowing.on_overlap !== 'insufficient_evidence') {
    issues.push(policyIssue('$.windowing.on_overlap', 'on_overlap must be insufficient_evidence'));
  }
  assertPositiveInteger(policy.windowing.min_test_windows, '$.windowing.min_test_windows', issues);
  assertPositiveInteger(policy.windowing.min_trades_total, '$.windowing.min_trades_total', issues);
  assertPositiveInteger(
    policy.windowing.min_trades_per_window,
    '$.windowing.min_trades_per_window',
    issues,
  );
  assertNonNegativeInteger(
    policy.windowing.max_zero_trade_windows,
    '$.windowing.max_zero_trade_windows',
    issues,
  );
  assertPositivePpm(
    policy.thresholds.min_aggregate_profit_factor_ppm,
    '$.thresholds.min_aggregate_profit_factor_ppm',
    issues,
  );
  assertPositivePpm(
    policy.thresholds.min_positive_window_share_ppm,
    '$.thresholds.min_positive_window_share_ppm',
    issues,
  );
  assertPositivePpm(
    policy.thresholds.max_worst_window_drawdown_ppm,
    '$.thresholds.max_worst_window_drawdown_ppm',
    issues,
  );
  assertPositiveInteger(
    policy.trial_accounting.high_trial_warning_threshold,
    '$.trial_accounting.high_trial_warning_threshold',
    issues,
  );
  if (policy.trial_accounting.effective_trial_scope !== 'campaign') {
    issues.push(
      policyIssue('$.trial_accounting.effective_trial_scope', 'trial scope must be campaign'),
    );
  }
  if (
    policy.trial_accounting.effective_trial_method !==
    'max_of_manual_and_distinct_fingerprints'
  ) {
    issues.push(
      policyIssue(
        '$.trial_accounting.effective_trial_method',
        'trial method must be max_of_manual_and_distinct_fingerprints',
      ),
    );
  }
  if (
    policy.statistics.dsr.enabled ||
    policy.statistics.white_reality_check.enabled ||
    policy.statistics.spa.enabled ||
    policy.statistics.pbo.enabled
  ) {
    issues.push(policyIssue('$.statistics', 'advanced statistics are disabled in policy v1'));
  }

  if (issues.length > 0) {
    throwValidationGateIssues(issues);
  }
}

function policyIssue(path: string, message: string): ValidationGateIssue {
  return {
    path,
    code: 'invalid_policy',
    message,
  };
}

function assertPositiveInteger(
  value: number,
  path: string,
  issues: ValidationGateIssue[],
): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    issues.push(policyIssue(path, 'value must be a positive safe integer'));
  }
}

function assertNonNegativeInteger(
  value: number,
  path: string,
  issues: ValidationGateIssue[],
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    issues.push(policyIssue(path, 'value must be a non-negative safe integer'));
  }
}

function assertPositivePpm(
  value: number,
  path: string,
  issues: ValidationGateIssue[],
): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    issues.push(policyIssue(path, 'ppm threshold must be a positive safe integer'));
  }
}

