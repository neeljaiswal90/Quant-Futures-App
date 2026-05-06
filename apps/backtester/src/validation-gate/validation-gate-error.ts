export type ValidationGateErrorCode =
  | 'unknown_strategy_id'
  | 'duplicate_strategy_id'
  | 'invalid_policy'
  | 'invalid_window_input'
  | 'invalid_trial_accounting'
  | 'fingerprint_strategy_mismatch'
  | 'window_strategy_mismatch'
  | 'session_order_invalid';

export interface ValidationGateIssue {
  readonly path: string;
  readonly code: ValidationGateErrorCode;
  readonly message: string;
}

export class ValidationGateInputError extends Error {
  readonly issues: readonly ValidationGateIssue[];

  constructor(issues: readonly ValidationGateIssue[]) {
    super(formatValidationGateMessage(issues));
    this.name = 'ValidationGateInputError';
    this.issues = [...issues];
    Object.setPrototypeOf(this, ValidationGateInputError.prototype);
  }
}

export function throwValidationGateIssues(
  issues: readonly ValidationGateIssue[],
): never {
  throw new ValidationGateInputError(issues);
}

export function throwValidationGateIssue(issue: ValidationGateIssue): never {
  throwValidationGateIssues([issue]);
}

function formatValidationGateMessage(issues: readonly ValidationGateIssue[]): string {
  if (issues.length === 0) {
    return 'validation gate input is invalid';
  }
  if (issues.length === 1) {
    const issue = issues[0]!;
    return `validation gate input is invalid: ${issue.code} at ${issue.path}`;
  }
  return `validation gate input has ${issues.length} issues`;
}
