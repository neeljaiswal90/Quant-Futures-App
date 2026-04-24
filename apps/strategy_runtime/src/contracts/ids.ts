export type Brand<TValue, TBrand extends string> = TValue & {
  readonly __brand: TBrand;
};

export type RunId = Brand<string, 'RunId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type EventId = Brand<string, 'EventId'>;
export type FeatureSnapshotId = Brand<string, 'FeatureSnapshotId'>;
export type CandidateId = Brand<string, 'CandidateId'>;
export type PositionId = Brand<string, 'PositionId'>;
export type OrderIntentId = Brand<string, 'OrderIntentId'>;
export type FillId = Brand<string, 'FillId'>;
export type CausationId = Brand<string, 'CausationId'>;
export type CorrelationId = Brand<string, 'CorrelationId'>;
export type StrategyEvaluationId = Brand<string, 'StrategyEvaluationId'>;
export type RiskGateDecisionId = Brand<string, 'RiskGateDecisionId'>;
export type SizingDecisionId = Brand<string, 'SizingDecisionId'>;
export type ManagementActionId = Brand<string, 'ManagementActionId'>;
export type ConfigHash = Brand<string, 'ConfigHash'>;

const HEX_64 = /^[a-f0-9]{64}$/;

function brandNonEmptyString<TBrand extends string>(
  value: string,
  label: TBrand,
): Brand<string, TBrand> {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value as Brand<string, TBrand>;
}

export function makeRunId(value: string): RunId {
  return brandNonEmptyString(value, 'RunId');
}

export function makeSessionId(value: string): SessionId {
  return brandNonEmptyString(value, 'SessionId');
}

export function makeEventId(value: string): EventId {
  return brandNonEmptyString(value, 'EventId');
}

export function makeFeatureSnapshotId(value: string): FeatureSnapshotId {
  return brandNonEmptyString(value, 'FeatureSnapshotId');
}

export function makeCandidateId(value: string): CandidateId {
  return brandNonEmptyString(value, 'CandidateId');
}

export function makePositionId(value: string): PositionId {
  return brandNonEmptyString(value, 'PositionId');
}

export function makeOrderIntentId(value: string): OrderIntentId {
  return brandNonEmptyString(value, 'OrderIntentId');
}

export function makeFillId(value: string): FillId {
  return brandNonEmptyString(value, 'FillId');
}

export function makeCausationId(value: string): CausationId {
  return brandNonEmptyString(value, 'CausationId');
}

export function makeCorrelationId(value: string): CorrelationId {
  return brandNonEmptyString(value, 'CorrelationId');
}

export function makeStrategyEvaluationId(value: string): StrategyEvaluationId {
  return brandNonEmptyString(value, 'StrategyEvaluationId');
}

export function makeRiskGateDecisionId(value: string): RiskGateDecisionId {
  return brandNonEmptyString(value, 'RiskGateDecisionId');
}

export function makeSizingDecisionId(value: string): SizingDecisionId {
  return brandNonEmptyString(value, 'SizingDecisionId');
}

export function makeManagementActionId(value: string): ManagementActionId {
  return brandNonEmptyString(value, 'ManagementActionId');
}

export function makeConfigHash(value: string): ConfigHash {
  if (!HEX_64.test(value)) {
    throw new Error('ConfigHash must be a 64-character lowercase sha256 hex string');
  }
  return value as ConfigHash;
}
