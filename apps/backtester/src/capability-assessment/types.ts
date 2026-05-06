import type { StrategyId } from '../../../strategy_runtime/src/contracts/strategy-ids.js';

export type StrategyCapabilityStatus =
  | 'ready_for_replay'
  | 'degraded_replay'
  | 'blocked';

export type StrategyFeatureCapabilityCategory =
  | 'instrument'
  | 'session'
  | 'quote'
  | 'bars'
  | 'indicators'
  | 'structure'
  | 'microstructure'
  | 'config_lineage'
  | 'fingerprint';

export type FeatureCapabilityStatus =
  | 'real'
  | 'placeholder'
  | 'unavailable'
  | 'not_required'
  | 'unverified';

export type StrategyCapabilityLimitationCode =
  | 'replay_missing'
  | 'fingerprint_missing'
  | 'placeholder_session'
  | 'placeholder_quote'
  | 'placeholder_indicators'
  | 'placeholder_structure'
  | 'placeholder_microstructure'
  | 'config_lineage_unverified'
  | 'empty_decision_sequence'
  | 'strategy_not_exercised'
  | 'unknown_strategy_id';

export interface StrategyFeatureCapability {
  readonly category: StrategyFeatureCapabilityCategory;
  readonly status: FeatureCapabilityStatus;
  readonly source: string | null;
  readonly details: string | null;
}

export interface StrategyCapabilityLimitation {
  readonly code: StrategyCapabilityLimitationCode;
  readonly message: string;
}

export interface StrategyCapabilityAssessment {
  readonly assessment_schema_version: 1;
  readonly strategy_id: StrategyId;
  readonly status: StrategyCapabilityStatus;
  readonly replay_evaluations: number;
  readonly fingerprint_sha256: string | null;
  readonly decision_count: number | null;
  readonly features: readonly StrategyFeatureCapability[];
  readonly limitations: readonly StrategyCapabilityLimitation[];
}

export interface CapabilityAssessmentSet {
  readonly assessment_set_schema_version: 1;
  readonly assessments: readonly StrategyCapabilityAssessment[];
}

export interface BuildCapabilityAssessmentOptions {
  readonly strategy_order?: readonly StrategyId[];
  readonly feature_capabilities?: readonly StrategyFeatureCapability[];
}
