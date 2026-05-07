export type OosReplayErrorCode =
  | 'missing_mbp1_schema'
  | 'missing_trades_schema'
  | 'missing_manifest_hash'
  | 'unknown_strategy_id'
  | 'duplicate_strategy_id'
  | 'missing_walk_forward_plan'
  | 'missing_input_spec'
  | 'invalid_input_spec'
  | 'invalid_artifact_strategy_id';

export interface OosReplayIssue {
  readonly path: string;
  readonly code: OosReplayErrorCode;
  readonly message: string;
}

export class OosReplayInputError extends Error {
  readonly issues: readonly OosReplayIssue[];

  constructor(issues: readonly OosReplayIssue[]) {
    super(`Invalid OOS replay input: ${issues.map((issue) => issue.message).join('; ')}`);
    this.name = 'OosReplayInputError';
    this.issues = Object.freeze([...issues]);
  }
}
