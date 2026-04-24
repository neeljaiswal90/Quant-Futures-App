import type { EventId, FeatureSnapshotId, SessionId } from './ids.js';
import type { ConfigLineageRef, FeatureLineageRef } from './lineage.js';
import type { SourceTimestampSet, RuntimeTimestampSet, UnixNs } from './time.js';

export type OrderSide = 'buy' | 'sell';
export type TradeAggressorSide = OrderSide | 'unknown';
export type Direction = 'long' | 'short';
export type PositionSide = Direction | 'flat';
export type BarTimeframe = '1m' | '5m' | '15m' | '60m' | '1d';
export type SessionPhase = 'pre_open' | 'rth' | 'maintenance' | 'closed' | 'halted';
export type QuoteAuthorityState = 'unknown' | 'warming' | 'authoritative' | 'stale' | 'gap';
export type L3AuthorityState = 'unavailable' | 'warming' | 'authoritative' | 'stale';

export interface InstrumentIdentity {
  readonly root: 'MNQ';
  readonly symbol: string;
  readonly exchange: 'CME';
  readonly currency: 'USD';
  readonly contract_month?: string;
  readonly tick_size: number;
  readonly point_value: number;
  readonly price_decimals: number;
}

export interface L1Quote {
  readonly instrument: InstrumentIdentity;
  readonly timestamps: SourceTimestampSet;
  readonly bid_px: number;
  readonly bid_qty: number;
  readonly ask_px: number;
  readonly ask_qty: number;
  readonly authority: QuoteAuthorityState;
}

export interface TradePrint {
  readonly instrument: InstrumentIdentity;
  readonly timestamps: SourceTimestampSet;
  readonly trade_id?: string;
  readonly price: number;
  readonly quantity: number;
  readonly aggressor_side: TradeAggressorSide;
}

export interface Mbp10Level {
  readonly price: number;
  readonly size: number;
  readonly order_count?: number;
}

export interface Mbp10DepthSnapshot {
  readonly instrument: InstrumentIdentity;
  readonly timestamps: SourceTimestampSet;
  readonly bids: readonly Mbp10Level[];
  readonly asks: readonly Mbp10Level[];
  readonly depth: 10;
  readonly authority: QuoteAuthorityState;
  readonly sequence?: number;
}

export interface MboFeatureSnapshotRef {
  readonly feature_snapshot_id: FeatureSnapshotId;
  readonly source_event_id?: EventId;
  readonly l3_authority: L3AuthorityState;
  readonly feature_schema_version: number;
}

export interface Bar {
  readonly instrument: InstrumentIdentity;
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

export interface SessionState {
  readonly session_id: SessionId;
  readonly trading_date: string;
  readonly phase: SessionPhase;
  readonly is_rth: boolean;
  readonly is_halt: boolean;
  readonly is_roll_block: boolean;
  readonly opened_ts_ns?: UnixNs;
  readonly closes_ts_ns?: UnixNs;
}

export interface FeatureSnapshotRef extends FeatureLineageRef {
  readonly feature_snapshot_id: FeatureSnapshotId;
  readonly instrument: InstrumentIdentity;
  readonly source_event_id?: EventId;
  readonly created_ts_ns: UnixNs;
}

export interface MarketSnapshot {
  readonly instrument: InstrumentIdentity;
  readonly timestamps: RuntimeTimestampSet;
  readonly quote: L1Quote;
  readonly last_trade?: TradePrint;
  readonly mbp10?: Mbp10DepthSnapshot;
  readonly mbo_features?: MboFeatureSnapshotRef;
  readonly bars: readonly Bar[];
  readonly session: SessionState;
  readonly feature_snapshot: FeatureSnapshotRef;
  readonly config: ConfigLineageRef;
}
