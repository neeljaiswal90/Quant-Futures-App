export type CapabilityAssessmentErrorCode =
  | 'unknown_strategy_id'
  | 'duplicate_strategy_id'
  | 'missing_replay_input'
  | 'malformed_replay_input'
  | 'missing_fingerprint_set'
  | 'malformed_fingerprint_set'
  | 'fingerprint_strategy_mismatch';

export interface CapabilityAssessmentIssue {
  readonly path: string;
  readonly code: CapabilityAssessmentErrorCode;
  readonly message: string;
}

export class CapabilityAssessmentInputError extends Error {
  readonly issues: readonly CapabilityAssessmentIssue[];

  constructor(issues: readonly CapabilityAssessmentIssue[]) {
    super(formatCapabilityAssessmentMessage(issues));
    this.name = 'CapabilityAssessmentInputError';
    this.issues = [...issues];
    Object.setPrototypeOf(this, CapabilityAssessmentInputError.prototype);
  }
}

export function throwCapabilityAssessmentIssues(
  issues: readonly CapabilityAssessmentIssue[],
): never {
  throw new CapabilityAssessmentInputError(issues);
}

export function throwCapabilityAssessmentIssue(issue: CapabilityAssessmentIssue): never {
  throwCapabilityAssessmentIssues([issue]);
}

function formatCapabilityAssessmentMessage(
  issues: readonly CapabilityAssessmentIssue[],
): string {
  if (issues.length === 0) {
    return 'capability assessment input is invalid';
  }
  if (issues.length === 1) {
    const issue = issues[0]!;
    return `capability assessment input is invalid: ${issue.code} at ${issue.path}`;
  }
  return `capability assessment input has ${issues.length} issues`;
}
