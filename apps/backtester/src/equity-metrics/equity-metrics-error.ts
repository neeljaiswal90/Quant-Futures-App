export type EquityMetricsErrorCode =
  | 'invalid_valuation_spec'
  | 'invalid_initial_equity'
  | 'invalid_price'
  | 'price_not_tick_aligned'
  | 'invalid_quantity'
  | 'invalid_fee'
  | 'missing_closed_trade_price'
  | 'unsupported_trade_side';

export interface EquityMetricsIssue {
  readonly path: string;
  readonly code: EquityMetricsErrorCode;
  readonly message: string;
}

export class EquityMetricsInputError extends Error {
  readonly issues: readonly EquityMetricsIssue[];

  constructor(issues: readonly EquityMetricsIssue[]) {
    super(formatEquityMetricsIssues(issues));
    this.name = 'EquityMetricsInputError';
    this.issues = issues;
  }
}

export function formatEquityMetricsIssues(issues: readonly EquityMetricsIssue[]): string {
  if (issues.length === 0) {
    return 'Equity metrics input is invalid';
  }

  return `Equity metrics input is invalid: ${issues
    .map((issue) => `${issue.path} ${issue.code}: ${issue.message}`)
    .join('; ')}`;
}

export function throwEquityMetricsIssue(issue: EquityMetricsIssue): never {
  throw new EquityMetricsInputError([issue]);
}
