export type TradeLedgerErrorCode =
  | 'missing_instrument_identity'
  | 'instrument_identity_mismatch'
  | 'malformed_fill'
  | 'missing_price'
  | 'missing_quantity'
  | 'invalid_side'
  | 'unsupported_position_flip'
  | 'reduce_without_open_position';

export interface TradeLedgerIssue {
  readonly path: string;
  readonly code: TradeLedgerErrorCode;
  readonly message: string;
}

export class TradeLedgerInputError extends Error {
  readonly issues: readonly TradeLedgerIssue[];

  constructor(issues: readonly TradeLedgerIssue[]) {
    super(formatTradeLedgerIssues(issues));
    this.name = 'TradeLedgerInputError';
    this.issues = issues;
  }
}

export function formatTradeLedgerIssues(issues: readonly TradeLedgerIssue[]): string {
  if (issues.length === 0) {
    return 'Trade ledger input is invalid';
  }

  return `Trade ledger input is invalid: ${issues
    .map((issue) => `${issue.path} ${issue.code}: ${issue.message}`)
    .join('; ')}`;
}

export function throwTradeLedgerIssue(issue: TradeLedgerIssue): never {
  throw new TradeLedgerInputError([issue]);
}
