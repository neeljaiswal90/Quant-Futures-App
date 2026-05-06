export type WalkForwardErrorCode =
  | 'empty_session_list'
  | 'duplicate_session'
  | 'unsorted_sessions'
  | 'invalid_session_id'
  | 'invalid_policy'
  | 'insufficient_sessions';

export interface WalkForwardIssue {
  readonly path: string;
  readonly code: WalkForwardErrorCode;
  readonly message: string;
}

export class WalkForwardInputError extends Error {
  readonly issues: readonly WalkForwardIssue[];

  constructor(issues: readonly WalkForwardIssue[]) {
    super(formatWalkForwardIssues(issues));
    this.name = 'WalkForwardInputError';
    this.issues = issues;
  }
}

export function throwWalkForwardIssues(issues: readonly WalkForwardIssue[]): never {
  throw new WalkForwardInputError(issues);
}

function formatWalkForwardIssues(issues: readonly WalkForwardIssue[]): string {
  if (issues.length === 0) {
    return 'Walk-forward input validation failed';
  }

  return issues
    .map((issue) => `${issue.path}: ${issue.code}: ${issue.message}`)
    .join('; ');
}
