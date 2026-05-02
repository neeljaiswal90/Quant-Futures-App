import type { RuntimeEventType } from '../../../strategy_runtime/src/contracts/events/index.js';
import type {
  FeatureAvailabilityMask,
  FeatureAvailabilityTier,
} from '../../../strategy_runtime/src/features/availability-mask.js';

export const CONSOLE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type DecimalString = string;
export type UnixNsString = string;
export type Availability = 'available' | 'unavailable';

export interface UnavailableValue {
  readonly status: 'unavailable';
  readonly reason: string;
}

export interface AvailableValue<T> {
  readonly status: 'available';
  readonly value: T;
}

export type MaybeAvailable<T> = AvailableValue<T> | UnavailableValue;

export interface ConsoleSnapshot {
  readonly schema_version: typeof CONSOLE_SNAPSHOT_SCHEMA_VERSION;
  readonly run_id: string;
  readonly session_id: string;
  readonly generated_from: {
    readonly journal_path: string;
    readonly journal_path_redacted: boolean;
    readonly last_event_id: string | null;
    readonly last_event_ts_ns: UnixNsString | null;
    readonly event_count: number;
  };
  readonly data_pipeline: DataPipelineState;
  readonly strategies: readonly StrategyGateState[];
  readonly trades: TradeBlotterState;
  readonly positions: readonly PositionState[];
  readonly pnl: PnlState;
  readonly risk: RiskState;
  readonly latency: LatencyState;
  readonly alerts: readonly AlertState[];
  readonly system_health: SystemHealthState;
  readonly feature_surface: FeatureSurfaceState;
  readonly mbo_shadow?: MboShadowState;
}

export interface DataPipelineState {
  readonly source_event_count: number;
  readonly by_type: Partial<Record<RuntimeEventType, number>>;
  readonly last_event_age_ms: MaybeAvailable<number>;
  readonly malformed_or_schema_invalid_count: number;
}

export interface StrategyGateState {
  readonly strategy_id: string;
  readonly status: Availability;
  readonly last_event_id: string | null;
  readonly last_event_ts_ns: UnixNsString | null;
}

export interface TradeBlotterState {
  readonly rows: readonly TradeBlotterRow[];
}

export interface TradeBlotterRow {
  readonly event_id: string;
  readonly type: Extract<RuntimeEventType, 'ORDER_INTENT' | 'SIM_FILL' | 'EXEC_REJECT' | 'MGMT_ACTION' | 'POSITION'>;
  readonly ts_ns: UnixNsString;
  readonly summary: string;
}

export interface PositionState {
  readonly position_id: string;
  readonly side: string;
  readonly status: string;
  readonly quantity_open: MaybeAvailable<number>;
  readonly avg_entry_price: MaybeAvailable<number>;
  readonly mark_price: MaybeAvailable<number>;
  readonly realized_pnl_usd: MaybeAvailable<number>;
  readonly unrealized_pnl_usd: MaybeAvailable<number>;
  readonly last_management_action: string | null;
}

export interface PnlState {
  readonly realized_pnl_usd: MaybeAvailable<number>;
  readonly unrealized_pnl_usd: MaybeAvailable<number>;
  readonly source: 'explicit_lifecycle_fact' | 'aggregate_session_risk' | 'unavailable';
}

export interface RiskState {
  readonly circuit_breaker_state: MaybeAvailable<string>;
  readonly daily_loss_usage: MaybeAvailable<number>;
  readonly open_trade_count: MaybeAvailable<number>;
  readonly rejected_trade_count: MaybeAvailable<number>;
}

export interface LatencyState {
  readonly last_event_lag_ms: MaybeAvailable<number>;
  readonly telemetry_only: true;
}

export interface AlertState {
  readonly id: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly message: string;
  readonly event_id?: string;
}

export interface SystemHealthState {
  readonly server_status: 'starting' | 'running' | 'degraded';
  readonly ws_client_count: number;
  readonly ws_backpressure: boolean;
  readonly dropped_critical_frame_count: number;
  readonly checkpoint_status: MaybeAvailable<string>;
}

export interface FeatureSurfaceState {
  readonly mask_version: number;
  readonly mask_id: string;
  readonly mask_hash: string;
  readonly mask_source: 'embedded' | 'fallback';
  readonly field_tiers: Readonly<Record<string, FeatureAvailabilityTier>>;
  readonly partition_counts: Readonly<Record<FeatureAvailabilityTier, number>>;
  readonly recent_violations: readonly AlertState[];
  readonly fallback_mask?: FeatureAvailabilityMask;
}

export interface MboShadowState {
  readonly status: 'absent' | 'diagnostic' | 'shadow';
  readonly decision_use: false;
  readonly last_event_id: string | null;
}
