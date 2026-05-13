import type {
  CandidateId,
  FeatureSnapshotId,
  RiskGateDecisionId,
  SizingDecisionId,
  StrategyEvaluationId,
} from './ids.js';
import type { ConfigLineageRef } from './lineage.js';
import type { Direction, InstrumentIdentity } from './market.js';
import type { StrategyId } from './strategy-ids.js';
import type { UnixNs } from './time.js';

export type StrategyGateState = 'armed' | 'waiting' | 'blocked';
export type CandidateStatus = 'proposed' | 'risk_rejected' | 'sized' | 'expired';
export type RiskGateStatus = 'pass' | 'reject';
export type CandidateSetupFamily =
  | 'trend_pullback'
  | 'breakout_retest'
  | 'regime_mean_reversion'
  | 'liquidity_sweep_reversal'
  | 'vwap_overnight_reversal';

export interface PriceTarget {
  readonly label: 'pt1' | 'pt2' | 'runner';
  readonly price: number;
  readonly quantity_fraction: number;
}

export interface RewardRiskTarget {
  readonly label: PriceTarget['label'];
  readonly reward_risk: number;
}

export interface StrategyEvaluation {
  readonly strategy_evaluation_id: StrategyEvaluationId;
  readonly strategy_id: StrategyId;
  readonly instrument: InstrumentIdentity;
  readonly feature_snapshot_id: FeatureSnapshotId;
  readonly evaluated_ts_ns: UnixNs;
  readonly gate_state: StrategyGateState;
  readonly score?: number;
  readonly reasons: readonly string[];
  readonly config: ConfigLineageRef;
}

export interface Candidate {
  readonly candidate_id: CandidateId;
  readonly strategy_id: StrategyId;
  readonly setup_type: StrategyId;
  readonly setup_family: CandidateSetupFamily;
  readonly instrument: InstrumentIdentity;
  readonly feature_snapshot_id: FeatureSnapshotId;
  readonly direction: Direction;
  readonly status: CandidateStatus;
  readonly proposed_ts_ns: UnixNs;
  readonly entry_price: number;
  readonly stop_price: number;
  readonly risk_points: number;
  readonly targets: readonly PriceTarget[];
  readonly reward_risk: readonly RewardRiskTarget[];
  readonly confidence: number;
  readonly config: ConfigLineageRef;
  readonly reasons: readonly string[];
}

export interface RiskGateDecision {
  readonly risk_gate_decision_id: RiskGateDecisionId;
  readonly candidate_id: CandidateId;
  readonly decided_ts_ns: UnixNs;
  readonly status: RiskGateStatus;
  readonly reasons: readonly string[];
  readonly max_loss_usd?: number;
  readonly config: ConfigLineageRef;
}

export interface SizingDecision {
  readonly sizing_decision_id: SizingDecisionId;
  readonly candidate_id: CandidateId;
  readonly decided_ts_ns: UnixNs;
  readonly quantity: number;
  readonly risk_usd: number;
  readonly risk_points: number;
  readonly rejected_reason?: string;
  readonly config: ConfigLineageRef;
}
