import type {
  CandidateId,
  FillId,
  OrderIntentId,
  SizingDecisionId,
} from './ids.js';
import type { ConfigLineageRef } from './lineage.js';
import type { InstrumentIdentity, OrderSide } from './market.js';
import type { UnixNs } from './time.js';

export type SimulatedOrderType = 'market' | 'limit' | 'stop_market';
export type SimulatedTimeInForce = 'ioc' | 'day' | 'gtc';
export type SimulatedOrderStatus = 'accepted' | 'rejected' | 'filled' | 'partially_filled' | 'cancelled';
export type SimulatedFillLiquidity = 'maker' | 'taker';

export interface SimulatedOrderIntent {
  readonly order_intent_id: OrderIntentId;
  readonly candidate_id: CandidateId;
  readonly sizing_decision_id: SizingDecisionId;
  readonly instrument: InstrumentIdentity;
  readonly side: OrderSide;
  readonly type: SimulatedOrderType;
  readonly quantity: number;
  readonly limit_price?: number;
  readonly stop_price?: number;
  readonly time_in_force: SimulatedTimeInForce;
  readonly submitted_ts_ns: UnixNs;
  readonly config: ConfigLineageRef;
}

export interface SimulatedFill {
  readonly fill_id: FillId;
  readonly order_intent_id: OrderIntentId;
  readonly instrument: InstrumentIdentity;
  readonly side: OrderSide;
  readonly quantity: number;
  readonly price: number;
  readonly liquidity: SimulatedFillLiquidity;
  readonly exchange_fee_usd: number;
  readonly commission_usd: number;
  readonly slippage_points: number;
  readonly filled_ts_ns: UnixNs;
  readonly config: ConfigLineageRef;
}

export interface SimulatedOrderResult {
  readonly order_intent_id: OrderIntentId;
  readonly status: SimulatedOrderStatus;
  readonly submitted_ts_ns: UnixNs;
  readonly fills: readonly SimulatedFill[];
  readonly reject_reason?: string;
}
