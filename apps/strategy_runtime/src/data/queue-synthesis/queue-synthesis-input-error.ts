export type QueueSynthesisErrorCode =
  | 'unsupported_input_schema'
  | 'insufficient_queue_evidence'
  | 'ohlcv_queue_synthesis_forbidden'
  | 'bbo_only_queue_synthesis_forbidden'
  | 'missing_price_or_quantity'
  | 'invalid_passive_probe'
  | 'invalid_probability_ppm'
  | 'non_monotonic_source'
  | 'nondeterministic_merge_order'
  | 'future_leakage_forbidden';

export interface QueueSynthesisIssue {
  readonly path: string;
  readonly code: QueueSynthesisErrorCode;
  readonly message: string;
}

export class QueueSynthesisInputError extends Error {
  readonly issues: readonly QueueSynthesisIssue[];

  constructor(issues: readonly QueueSynthesisIssue[], heading = 'Invalid queue-synthesis input') {
    const details = issues
      .map((issue) => `- ${issue.path} [${issue.code}]: ${issue.message}`)
      .join('\n');
    super(`${heading}:\n${details}`);
    this.name = 'QueueSynthesisInputError';
    this.issues = issues;
  }
}
