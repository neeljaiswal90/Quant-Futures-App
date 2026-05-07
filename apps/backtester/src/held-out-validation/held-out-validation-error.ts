export type HeldOutValidationErrorCode =
  | 'missing_run_id'
  | 'missing_input_spec'
  | 'missing_walk_forward_plan'
  | 'invalid_strategy_order'
  | 'duplicate_strategy_id'
  | 'invalid_validation_artifact';

export interface HeldOutValidationIssue {
  readonly path: string;
  readonly code: HeldOutValidationErrorCode;
  readonly message: string;
}

export class HeldOutValidationInputError extends Error {
  readonly issues: readonly HeldOutValidationIssue[];

  constructor(issues: readonly HeldOutValidationIssue[]) {
    super(formatHeldOutValidationIssues(issues));
    this.name = 'HeldOutValidationInputError';
    this.issues = issues;
  }
}

export function formatHeldOutValidationIssues(
  issues: readonly HeldOutValidationIssue[],
): string {
  return issues
    .map((issue) => `${issue.path}: ${issue.code}: ${issue.message}`)
    .join('\n');
}

export function throwHeldOutValidationIssues(
  issues: readonly HeldOutValidationIssue[],
): never {
  throw new HeldOutValidationInputError(issues);
}
