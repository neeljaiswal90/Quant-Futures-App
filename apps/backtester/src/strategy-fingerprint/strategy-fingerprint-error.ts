export type StrategyFingerprintErrorCode =
  | 'missing_strategy_id'
  | 'unknown_strategy_id'
  | 'strategy_mismatch'
  | 'missing_bar_id'
  | 'missing_ts_ns'
  | 'non_finite_score'
  | 'negative_zero_score'
  | 'duplicate_sequence'
  | 'invalid_reason_code'
  | 'missing_decision_field';

export interface StrategyFingerprintIssue {
  readonly path: string;
  readonly code: StrategyFingerprintErrorCode;
  readonly message: string;
}

export class StrategyFingerprintInputError extends Error {
  readonly issues: readonly StrategyFingerprintIssue[];

  constructor(issues: readonly StrategyFingerprintIssue[]) {
    super(formatStrategyFingerprintMessage(issues));
    this.name = 'StrategyFingerprintInputError';
    this.issues = [...issues];
    Object.setPrototypeOf(this, StrategyFingerprintInputError.prototype);
  }
}

export function throwStrategyFingerprintIssues(
  issues: readonly StrategyFingerprintIssue[],
): never {
  throw new StrategyFingerprintInputError(issues);
}

export function throwStrategyFingerprintIssue(issue: StrategyFingerprintIssue): never {
  throwStrategyFingerprintIssues([issue]);
}

function formatStrategyFingerprintMessage(
  issues: readonly StrategyFingerprintIssue[],
): string {
  if (issues.length === 0) {
    return 'strategy fingerprint input is invalid';
  }
  if (issues.length === 1) {
    const issue = issues[0]!;
    return `strategy fingerprint input is invalid: ${issue.code} at ${issue.path}`;
  }
  return `strategy fingerprint input has ${issues.length} issues`;
}
