import type {
  CandidateId,
  EventId,
  FeatureSnapshotId,
  FillId,
  ManagementActionId,
  OrderIntentId,
  PositionId,
  RiskGateDecisionId,
  SessionId,
  SizingDecisionId,
  StrategyEvaluationId,
} from '../ids.js';
import type {
  BarTimeframe,
  Direction,
  L3AuthorityState,
  OrderSide,
  PositionSide,
  QuoteAuthorityState,
  SessionPhase,
  TradeAggressorSide,
} from '../market.js';
import type { ManagementActionType, PositionStatus } from '../position.js';
import type { SimulatedOrderStatus } from '../execution.js';
import type { StrategyId } from '../strategy-ids.js';
import type { UnixNs } from '../time.js';
import type { RuntimeEventType } from './event-types.js';

export interface SourceTimestampPayload {
  readonly exchange_event_ts_ns: UnixNs;
  readonly sidecar_recv_ts_ns: UnixNs;
  readonly rithmic_publish_ts_ns?: UnixNs;
}

export interface QuoteEventPayload extends SourceTimestampPayload {
  readonly bid_px: number;
  readonly bid_qty: number;
  readonly ask_px: number;
  readonly ask_qty: number;
  readonly authority?: QuoteAuthorityState;
}

export interface TradeEventPayload extends SourceTimestampPayload {
  readonly trade_id?: string;
  readonly price: number;
  readonly quantity: number;
  readonly aggressor_side: TradeAggressorSide;
}

export interface BarCloseEventPayload extends SourceTimestampPayload {
  readonly timeframe: BarTimeframe;
  readonly start_ts_ns: UnixNs;
  readonly end_ts_ns: UnixNs;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly trade_count?: number;
}

export interface MicrostructureEventPayload extends SourceTimestampPayload {
  readonly feature_snapshot_id: FeatureSnapshotId;
  readonly l3_authority: L3AuthorityState;
  readonly values: Readonly<Record<string, number | string | boolean | null>>;
}

export interface BookRebuildEventPayload extends SourceTimestampPayload {
  readonly authority: QuoteAuthorityState;
  readonly reason: string;
  readonly warmup_complete: boolean;
}

export interface ConnectionEventPayload {
  readonly state: 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'failed';
  readonly detail?: string;
}

export interface FeedEventPayload {
  readonly state: 'warming' | 'live' | 'stale' | 'gap' | 'closed';
  readonly stream?: string;
  readonly detail?: string;
}

export interface GapEventPayload {
  readonly gap_id: string;
  readonly stream: string;
  readonly start_ts_ns: UnixNs;
  readonly end_ts_ns: UnixNs;
  readonly observed_count?: number;
  readonly detail?: string;
}

export interface SessionPhaseEventPayload {
  readonly phase: SessionPhase;
  readonly trading_date: string;
  readonly previous_phase?: SessionPhase;
  readonly session_phase?: 'rth' | 'eth' | 'maintenance' | 'closed';
  readonly previous_session_phase?: 'rth' | 'eth' | 'maintenance' | 'closed';
  readonly active_contract?: string;
  readonly next_contract?: string;
  readonly roll_phase?: 'normal' | 'pre_roll' | 'roll_block' | 'post_roll';
  readonly candidate_eligible?: boolean;
  readonly block_reason?: string;
  readonly should_flatten?: boolean;
}

export interface RollAdvisoryEventPayload {
  readonly advisory: 'roll_window' | 'block_new_entries' | 'flatten_required' | 'roll_complete';
  readonly active_symbol: string;
  readonly next_symbol: string;
  readonly roll_phase?: 'normal' | 'pre_roll' | 'roll_block' | 'post_roll';
  readonly previous_roll_phase?: 'normal' | 'pre_roll' | 'roll_block' | 'post_roll';
  readonly candidate_eligible?: boolean;
  readonly block_reason?: string;
  readonly should_flatten?: boolean;
  readonly minutes_to_cutover?: number;
}

export interface HaltEventPayload {
  readonly state: 'halted' | 'resumed';
  readonly reason?: string;
}

export interface ConfigEventPayload {
  readonly config_hash: string;
  readonly config_version: number;
}

export interface FeaturesEventPayload {
  readonly feature_snapshot_id: FeatureSnapshotId;
  readonly source_event_id?: EventId;
  readonly values: Readonly<Record<string, number | string | boolean | null>>;
}

export interface StructureEventPayload {
  readonly feature_snapshot_id: FeatureSnapshotId;
  readonly trend: 'up' | 'down' | 'range' | 'unknown';
  readonly values: Readonly<Record<string, number | string | boolean | null>>;
}

export interface StrategyEvaluationEventPayload {
  readonly strategy_evaluation_id: StrategyEvaluationId;
  readonly strategy_id: StrategyId;
  readonly feature_snapshot_id: FeatureSnapshotId;
  readonly gate_state: 'armed' | 'waiting' | 'blocked';
  readonly score?: number;
  readonly reasons: readonly string[];
  readonly strategy_config_hash?: string;
}

export interface PriceTargetEventPayload {
  readonly label: 'pt1' | 'pt2' | 'runner';
  readonly price: number;
  readonly quantity_fraction: number;
}

export interface CandidateEventPayload {
  readonly candidate_id: CandidateId;
  readonly strategy_id: StrategyId;
  readonly feature_snapshot_id: FeatureSnapshotId;
  readonly direction: Direction;
  readonly status: 'proposed' | 'risk_rejected' | 'sized' | 'expired';
  readonly entry_price: number;
  readonly stop_price: number;
  readonly targets: readonly PriceTargetEventPayload[];
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly strategy_config_hash?: string;
}

export interface MlUpliftEventPayload {
  readonly feature_snapshot_id: FeatureSnapshotId;
  readonly model_id: string;
  readonly score: number;
  readonly enabled: boolean;
}

export interface RankEventPayload {
  readonly ranked_candidate_ids: readonly CandidateId[];
  readonly method: string;
  readonly strategy_config_hash?: string;
}

export interface RiskGateEventPayload {
  readonly risk_gate_decision_id: RiskGateDecisionId;
  readonly candidate_id: CandidateId;
  readonly status: 'pass' | 'reject';
  readonly reasons: readonly string[];
  readonly risk_manager_version?: string;
  readonly strategy_config_hash?: string;
  readonly risk_policy_hash?: string;
  readonly risk_config_hash?: string;
  readonly session_risk?: {
    readonly session_id: SessionId;
    readonly account_ref: string;
    readonly symbol: string;
    readonly realized_pnl_usd: number;
    readonly open_trade_count: number;
    readonly closed_trade_count: number;
    readonly rejected_trade_count: number;
    readonly circuit_breaker_state: 'inactive' | 'active';
    readonly circuit_breaker_reason?: string;
    readonly last_transition_ts_ns: UnixNs;
  };
}

export interface SizingEventPayload {
  readonly sizing_decision_id: SizingDecisionId;
  readonly candidate_id: CandidateId;
  readonly quantity: number;
  readonly risk_usd: number;
  readonly risk_points: number;
  readonly rejected_reason?: string;
  readonly strategy_config_hash?: string;
  readonly risk_config_hash?: string;
  readonly risk_manager_version?: string;
}

export interface OrderIntentEventPayload {
  readonly order_intent_id: OrderIntentId;
  readonly candidate_id: CandidateId;
  readonly sizing_decision_id: SizingDecisionId;
  readonly side: OrderSide;
  readonly order_type: 'market' | 'limit' | 'stop_market';
  readonly quantity: number;
  readonly limit_price?: number;
  readonly stop_price?: number;
  readonly time_in_force: 'ioc' | 'day' | 'gtc';
  readonly strategy_config_hash?: string;
  readonly management_action_id?: ManagementActionId;
  readonly position_id?: PositionId;
  readonly management_profile_hash?: string;
  readonly management_profile_id?: string;
  readonly management_profile_version?: number;
  readonly position_manager_version?: string;
}

export interface SimFillEventPayload {
  readonly fill_id: FillId;
  readonly order_intent_id: OrderIntentId;
  readonly side: OrderSide;
  readonly quantity: number;
  readonly price: number;
  readonly liquidity: 'maker' | 'taker';
  readonly slippage_points?: number;
  readonly exchange_fee_usd?: number;
  readonly commission_usd?: number;
  readonly strategy_config_hash?: string;
  readonly management_action_id?: ManagementActionId;
  readonly position_id?: PositionId;
  readonly management_profile_hash?: string;
  readonly management_profile_id?: string;
  readonly management_profile_version?: number;
  readonly position_manager_version?: string;
}

export interface ExecutionRejectEventPayload {
  readonly execution_reject_id: string;
  readonly order_intent_id: OrderIntentId;
  readonly candidate_id: CandidateId;
  readonly sizing_decision_id: SizingDecisionId;
  readonly status: Extract<SimulatedOrderStatus, 'rejected' | 'cancelled'>;
  readonly reason: string;
  readonly execution_adapter: 'simulated';
  readonly execution_version: string;
  readonly strategy_config_hash?: string;
  readonly management_action_id?: ManagementActionId;
  readonly position_id?: PositionId;
  readonly management_profile_hash?: string;
  readonly management_profile_id?: string;
  readonly management_profile_version?: number;
  readonly position_manager_version?: string;
}

export interface PositionEventPayload {
  readonly position_id: PositionId;
  readonly candidate_id: CandidateId;
  readonly side: PositionSide;
  readonly status: PositionStatus;
  readonly quantity_open: number;
  readonly avg_entry_price: number;
  readonly updated_ts_ns: UnixNs;
  readonly strategy_config_hash?: string;
  readonly management_profile_hash?: string;
  readonly management_profile_id?: string;
  readonly management_profile_version?: number;
}

export interface ManagementTickEventPayload {
  readonly position_id: PositionId;
  readonly mark_price: number;
  readonly unrealized_pnl_usd: number;
  readonly strategy_config_hash?: string;
  readonly management_profile_hash?: string;
  readonly management_profile_id?: string;
  readonly management_profile_version?: number;
  readonly position_manager_version?: string;
}

export interface ManagementActionEventPayload {
  readonly management_action_id: ManagementActionId;
  readonly position_id: PositionId;
  readonly action_type: ManagementActionType;
  readonly reason: string;
  readonly new_stop_price?: number;
  readonly exit_quantity?: number;
  readonly target_label?: 'pt1' | 'pt2' | 'runner';
  readonly exit_price?: number;
  readonly realized_pnl_usd?: number;
  readonly realized_r?: number;
  readonly strategy_config_hash?: string;
  readonly management_profile_hash?: string;
  readonly management_profile_id?: string;
  readonly management_profile_version?: number;
  readonly position_manager_version?: string;
  readonly active_contract?: string;
  readonly next_contract?: string;
  readonly cutover_ts_ns?: UnixNs;
  readonly roll_phase?: 'normal' | 'pre_roll' | 'roll_block' | 'post_roll';
}

export interface JournalEventPayloadByType {
  readonly CONN: ConnectionEventPayload;
  readonly FEED: FeedEventPayload;
  readonly GAP: GapEventPayload;
  readonly BOOK_REBUILD: BookRebuildEventPayload;
  readonly SESSION_PHASE: SessionPhaseEventPayload;
  readonly ROLL_ADVISORY: RollAdvisoryEventPayload;
  readonly HALT: HaltEventPayload;
  readonly QUOTE: QuoteEventPayload;
  readonly TRADE: TradeEventPayload;
  readonly BAR_CLOSE: BarCloseEventPayload;
  readonly FEATURES: FeaturesEventPayload;
  readonly STRUCTURE: StructureEventPayload;
  readonly MICROSTRUCTURE: MicrostructureEventPayload;
  readonly STRAT_EVAL: StrategyEvaluationEventPayload;
  readonly CANDIDATE: CandidateEventPayload;
  readonly ML_UPLIFT: MlUpliftEventPayload;
  readonly RANK: RankEventPayload;
  readonly RISK_GATE: RiskGateEventPayload;
  readonly SIZING: SizingEventPayload;
  readonly ORDER_INTENT: OrderIntentEventPayload;
  readonly SIM_FILL: SimFillEventPayload;
  readonly EXEC_REJECT: ExecutionRejectEventPayload;
  readonly POSITION: PositionEventPayload;
  readonly MGMT_TICK: ManagementTickEventPayload;
  readonly MGMT_ACTION: ManagementActionEventPayload;
  readonly CONFIG: ConfigEventPayload;
}

export type JournalEventPayloadFor<TType extends RuntimeEventType> =
  JournalEventPayloadByType[TType];

export type AnyJournalEventPayload = JournalEventPayloadByType[RuntimeEventType];
