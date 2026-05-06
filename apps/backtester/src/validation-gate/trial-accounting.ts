import type { StrategyId } from '../../../strategy_runtime/src/contracts/strategy-ids.js';
import type {
  ValidationGatePolicy,
  ValidationTrialAccounting,
} from './types.js';
import type { ValidationGateIssue } from './validation-gate-error.js';

export function computeEffectiveTrialCount(
  trialAccounting: ValidationTrialAccounting,
): number {
  switch (trialAccounting.effective_trial_method) {
    case 'manual_declared':
      return trialAccounting.manual_declared_effective_trials;
    case 'distinct_window_fingerprint_tuples':
      return trialAccounting.distinct_window_fingerprint_tuples;
    case 'max_of_manual_and_distinct_fingerprints':
      return Math.max(
        trialAccounting.manual_declared_effective_trials,
        trialAccounting.distinct_window_fingerprint_tuples,
      );
  }
}

export function validateTrialAccounting(
  strategyId: StrategyId,
  trialAccounting: ValidationTrialAccounting,
  policy: ValidationGatePolicy,
  path: string,
): readonly ValidationGateIssue[] {
  const issues: ValidationGateIssue[] = [];
  if (trialAccounting.trial_accounting_schema_version !== 1) {
    issues.push(trialIssue(path, 'trial_accounting_schema_version must be 1'));
  }
  if (trialAccounting.strategy_id !== strategyId) {
    issues.push(trialIssue(`${path}.strategy_id`, 'trial accounting strategy_id mismatch'));
  }
  if (typeof trialAccounting.campaign_id !== 'string' || trialAccounting.campaign_id.trim() === '') {
    issues.push(trialIssue(`${path}.campaign_id`, 'campaign_id must be a non-empty string'));
  }
  assertNonNegativeInteger(
    trialAccounting.raw_research_trials,
    `${path}.raw_research_trials`,
    issues,
  );
  assertNonNegativeInteger(
    trialAccounting.excluded_determinism_reruns,
    `${path}.excluded_determinism_reruns`,
    issues,
  );
  assertNonNegativeInteger(
    trialAccounting.manual_declared_effective_trials,
    `${path}.manual_declared_effective_trials`,
    issues,
  );
  assertNonNegativeInteger(
    trialAccounting.distinct_window_fingerprint_tuples,
    `${path}.distinct_window_fingerprint_tuples`,
    issues,
  );
  assertNonNegativeInteger(
    trialAccounting.effective_trial_count,
    `${path}.effective_trial_count`,
    issues,
  );
  if (trialAccounting.effective_trial_scope !== policy.trial_accounting.effective_trial_scope) {
    issues.push(
      trialIssue(
        `${path}.effective_trial_scope`,
        `effective_trial_scope must be ${policy.trial_accounting.effective_trial_scope}`,
      ),
    );
  }
  if (trialAccounting.effective_trial_method !== policy.trial_accounting.effective_trial_method) {
    issues.push(
      trialIssue(
        `${path}.effective_trial_method`,
        `effective_trial_method must be ${policy.trial_accounting.effective_trial_method}`,
      ),
    );
  }

  const expectedEffectiveTrialCount = computeEffectiveTrialCount(trialAccounting);
  if (trialAccounting.effective_trial_count !== expectedEffectiveTrialCount) {
    issues.push(
      trialIssue(
        `${path}.effective_trial_count`,
        `effective_trial_count must equal ${expectedEffectiveTrialCount}`,
      ),
    );
  }

  return issues;
}

function trialIssue(path: string, message: string): ValidationGateIssue {
  return {
    path,
    code: 'invalid_trial_accounting',
    message,
  };
}

function assertNonNegativeInteger(
  value: number,
  path: string,
  issues: ValidationGateIssue[],
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    issues.push(trialIssue(path, 'value must be a non-negative safe integer'));
  }
}
