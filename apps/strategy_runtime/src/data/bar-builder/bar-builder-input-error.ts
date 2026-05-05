export type BarBuilderErrorCode =
  | 'unsupported_bar_spec'
  | 'unrecognized_manifest_symbol'
  | 'incompatible_input_schema'
  | 'manifest_concrete_mismatch'
  | 'manifest_continuous_rule_mismatch'
  | 'incompatible_root'
  | 'subminute_from_ohlcv'
  | 'roll_unsplittable_aggregate';

export interface BarBuilderIssue {
  readonly path: string;
  readonly code: BarBuilderErrorCode;
  readonly message: string;
}

export class BarBuilderInputError extends Error {
  readonly issues: readonly BarBuilderIssue[];

  constructor(issues: readonly BarBuilderIssue[], heading = 'Invalid bar-builder input') {
    const details = issues
      .map((issue) => `- ${issue.path} [${issue.code}]: ${issue.message}`)
      .join('\n');
    super(`${heading}:\n${details}`);
    this.name = 'BarBuilderInputError';
    this.issues = issues;
  }
}
