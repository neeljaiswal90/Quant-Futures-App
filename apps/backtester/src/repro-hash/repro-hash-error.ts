export type ReproHashErrorCode =
  | 'invalid_run_id'
  | 'invalid_run_spec_hash'
  | 'invalid_artifact_name'
  | 'invalid_artifact_hash'
  | 'duplicate_artifact'
  | 'missing_artifact'
  | 'unsupported_value'
  | 'undefined_value'
  | 'non_finite_number'
  | 'negative_zero'
  | 'date_value_forbidden';

export interface ReproHashIssue {
  readonly path: string;
  readonly code: ReproHashErrorCode;
  readonly message: string;
}

export class ReproHashInputError extends Error {
  readonly issues: readonly ReproHashIssue[];

  constructor(issues: readonly ReproHashIssue[]) {
    super(formatReproHashIssues(issues));
    this.name = 'ReproHashInputError';
    this.issues = [...issues];
  }
}

export function formatReproHashIssues(issues: readonly ReproHashIssue[]): string {
  if (issues.length === 0) {
    return 'Invalid reproducibility hash input';
  }
  return issues
    .map((issue) => `${issue.path}: ${issue.code}: ${issue.message}`)
    .join('; ');
}

export function throwReproHashIssue(issue: ReproHashIssue): never {
  throw new ReproHashInputError([issue]);
}

export function throwReproHashIssues(issues: readonly ReproHashIssue[]): never {
  throw new ReproHashInputError(issues);
}
