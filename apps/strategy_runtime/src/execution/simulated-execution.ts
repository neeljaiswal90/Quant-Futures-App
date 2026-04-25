import type {
  Candidate,
  SizingDecision,
} from '../contracts/candidate.js';
import type {
  OrderIntentEventPayload,
  SimFillEventPayload,
} from '../contracts/events/payloads.js';
import {
  makeFillId,
  makeOrderIntentId,
  makeSizingDecisionId,
  type CandidateId,
  type ManagementActionId,
  type OrderIntentId,
  type PositionId,
} from '../contracts/ids.js';
import type { ConfigLineageRef } from '../contracts/lineage.js';
import type { InstrumentIdentity, PositionSide } from '../contracts/market.js';
import type {
  SimulatedFill,
  SimulatedOrderIntent,
  SimulatedOrderResult,
} from '../contracts/execution.js';
import type { UnixNs } from '../contracts/time.js';
import {
  getContractSpec,
  roundCurrency,
  roundToTick,
  type ContractSpec,
} from '../risk/contracts.js';
import type {
  VenueCostConfig,
} from '../risk/costs.js';
import {
  getVenueCostConfig,
  type VenueCostTable,
} from '../risk/venue-cost-config.js';

export const SIMULATED_EXECUTION_VERSION = 'simulated_execution_v1' as const;

export interface SimulatedExecutionConfig {
  readonly marketable_slippage_points: number;
}

export const DEFAULT_SIMULATED_EXECUTION_CONFIG: SimulatedExecutionConfig = {
  marketable_slippage_points: 0.25,
};

export interface SimulatedExecutionMarketState {
  readonly instrument: InstrumentIdentity;
  readonly ts_ns: UnixNs;
  readonly bid_px: number;
  readonly ask_px: number;
  readonly last_trade_price?: number;
}

export interface SubmitSimulatedOrderInput {
  readonly intent: SimulatedOrderIntent;
  readonly market: SimulatedExecutionMarketState;
  readonly fill_ts_ns?: UnixNs;
}

export interface CancelSimulatedOrderInput {
  readonly order_intent_id: OrderIntentId;
  readonly submitted_ts_ns: UnixNs;
  readonly reason: string;
}

export interface SimulatedExecutionAdapter {
  readonly adapter: 'simulated';
  readonly version: typeof SIMULATED_EXECUTION_VERSION;
  submit(input: SubmitSimulatedOrderInput): Promise<SimulatedOrderResult>;
  cancel(input: CancelSimulatedOrderInput): Promise<SimulatedOrderResult>;
}

export interface CreateSimulatedExecutionAdapterOptions {
  readonly venue_costs: VenueCostTable;
  readonly config?: Partial<SimulatedExecutionConfig>;
}

export class DeterministicSimulatedExecutionAdapter implements SimulatedExecutionAdapter {
  readonly adapter = 'simulated' as const;
  readonly version = SIMULATED_EXECUTION_VERSION;
  private readonly config: SimulatedExecutionConfig;

  constructor(private readonly options: CreateSimulatedExecutionAdapterOptions) {
    this.config = {
      ...DEFAULT_SIMULATED_EXECUTION_CONFIG,
      ...options.config,
    };
    validateExecutionConfig(this.config);
  }

  async submit(input: SubmitSimulatedOrderInput): Promise<SimulatedOrderResult> {
    const rejection = validateSubmitInput(input);
    if (rejection !== undefined) {
      return rejectOrder(input.intent, rejection);
    }

    const fillPlan = computeFillPlan(input.intent, input.market, this.config);
    if (fillPlan.kind === 'no_fill') {
      return {
        order_intent_id: input.intent.order_intent_id,
        status: input.intent.time_in_force === 'ioc' ? 'cancelled' : 'accepted',
        submitted_ts_ns: input.intent.submitted_ts_ns,
        fills: [],
        reject_reason:
          input.intent.time_in_force === 'ioc' ? `${fillPlan.reason}:ioc_cancelled` : undefined,
      };
    }

    const contract = getContractSpec(input.intent.instrument.root);
    const venueCost = getVenueCostConfig(this.options.venue_costs, contract.root);
    const fill = buildFill({
      intent: input.intent,
      contract,
      venue_cost: venueCost,
      fill_price: fillPlan.price,
      slippage_points: fillPlan.slippage_points,
      liquidity: fillPlan.liquidity,
      filled_ts_ns: input.fill_ts_ns ?? input.market.ts_ns,
    });

    return {
      order_intent_id: input.intent.order_intent_id,
      status: 'filled',
      submitted_ts_ns: input.intent.submitted_ts_ns,
      fills: [fill],
    };
  }

  async cancel(input: CancelSimulatedOrderInput): Promise<SimulatedOrderResult> {
    return {
      order_intent_id: input.order_intent_id,
      status: 'cancelled',
      submitted_ts_ns: input.submitted_ts_ns,
      fills: [],
      reject_reason: input.reason,
    };
  }
}

export function createSimulatedExecutionAdapter(
  options: CreateSimulatedExecutionAdapterOptions,
): SimulatedExecutionAdapter {
  return new DeterministicSimulatedExecutionAdapter(options);
}

export interface CreateEntryOrderIntentInput {
  readonly candidate: Candidate;
  readonly sizing: SizingDecision;
  readonly submitted_ts_ns: UnixNs;
  readonly order_type?: SimulatedOrderIntent['type'];
  readonly time_in_force?: SimulatedOrderIntent['time_in_force'];
  readonly limit_price?: number;
  readonly stop_price?: number;
}

export function createEntryOrderIntent(input: CreateEntryOrderIntentInput): SimulatedOrderIntent {
  if (!Number.isInteger(input.sizing.quantity) || input.sizing.quantity <= 0) {
    throw new Error('sizing quantity must be a positive integer before creating an order intent');
  }
  const orderType = input.order_type ?? 'market';
  return {
    order_intent_id: makeOrderIntentId(
      `order-${input.candidate.candidate_id}-${input.sizing.sizing_decision_id}`,
    ),
    candidate_id: input.candidate.candidate_id,
    sizing_decision_id: input.sizing.sizing_decision_id,
    instrument: input.candidate.instrument,
    side: input.candidate.direction === 'long' ? 'buy' : 'sell',
    type: orderType,
    quantity: input.sizing.quantity,
    limit_price: input.limit_price,
    stop_price: input.stop_price,
    time_in_force: input.time_in_force ?? (orderType === 'market' ? 'ioc' : 'day'),
    submitted_ts_ns: input.submitted_ts_ns,
    config: input.candidate.config,
  };
}

export interface CreateManagementExitOrderIntentInput {
  readonly position: {
    readonly position_id: PositionId;
    readonly candidate_id: CandidateId;
    readonly instrument: InstrumentIdentity;
    readonly side: Extract<PositionSide, 'long' | 'short'>;
  };
  readonly management_action_id: ManagementActionId;
  readonly quantity: number;
  readonly submitted_ts_ns: UnixNs;
  readonly config: ConfigLineageRef;
}

export function createManagementExitOrderIntent(
  input: CreateManagementExitOrderIntentInput,
): SimulatedOrderIntent {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new Error('management exit quantity must be a positive integer');
  }
  return {
    order_intent_id: makeOrderIntentId(
      `order-exit-${input.position.position_id}-${input.management_action_id}`,
    ),
    candidate_id: input.position.candidate_id,
    sizing_decision_id: makeSizingDecisionId(`sizing-exit-${input.management_action_id}`),
    instrument: input.position.instrument,
    side: input.position.side === 'long' ? 'sell' : 'buy',
    type: 'market',
    quantity: input.quantity,
    time_in_force: 'ioc',
    submitted_ts_ns: input.submitted_ts_ns,
    config: input.config,
  };
}

export function toOrderIntentEventPayload(
  intent: SimulatedOrderIntent,
): OrderIntentEventPayload {
  return {
    order_intent_id: intent.order_intent_id,
    candidate_id: intent.candidate_id,
    sizing_decision_id: intent.sizing_decision_id,
    side: intent.side,
    order_type: intent.type,
    quantity: intent.quantity,
    limit_price: intent.limit_price,
    stop_price: intent.stop_price,
    time_in_force: intent.time_in_force,
  };
}

export function toSimFillEventPayload(fill: SimulatedFill): SimFillEventPayload {
  return {
    fill_id: fill.fill_id,
    order_intent_id: fill.order_intent_id,
    side: fill.side,
    quantity: fill.quantity,
    price: fill.price,
    liquidity: fill.liquidity,
    slippage_points: fill.slippage_points,
    exchange_fee_usd: fill.exchange_fee_usd,
    commission_usd: fill.commission_usd,
  };
}

interface FillPlan {
  readonly kind: 'fill';
  readonly price: number;
  readonly slippage_points: number;
  readonly liquidity: SimulatedFill['liquidity'];
}

interface NoFillPlan {
  readonly kind: 'no_fill';
  readonly reason: string;
}

function computeFillPlan(
  intent: SimulatedOrderIntent,
  market: SimulatedExecutionMarketState,
  config: SimulatedExecutionConfig,
): FillPlan | NoFillPlan {
  if (intent.type === 'market') {
    return fillAgainstBbo(intent, market, config.marketable_slippage_points, undefined, 'taker');
  }

  if (intent.type === 'limit') {
    if (intent.limit_price === undefined) {
      return { kind: 'no_fill', reason: 'missing_limit_price' };
    }
    const crosses =
      intent.side === 'buy'
        ? intent.limit_price >= market.ask_px
        : intent.limit_price <= market.bid_px;
    if (!crosses) {
      return { kind: 'no_fill', reason: 'limit_not_marketable' };
    }
    return fillAgainstBbo(intent, market, config.marketable_slippage_points, intent.limit_price, 'taker');
  }

  if (intent.stop_price === undefined) {
    return { kind: 'no_fill', reason: 'missing_stop_price' };
  }
  const triggered =
    intent.side === 'buy'
      ? market.ask_px >= intent.stop_price
      : market.bid_px <= intent.stop_price;
  if (!triggered) {
    return { kind: 'no_fill', reason: 'stop_not_triggered' };
  }
  return fillAgainstBbo(intent, market, config.marketable_slippage_points, undefined, 'taker');
}

function fillAgainstBbo(
  intent: SimulatedOrderIntent,
  market: SimulatedExecutionMarketState,
  slippagePoints: number,
  limitPrice: number | undefined,
  liquidity: SimulatedFill['liquidity'],
): FillPlan {
  const contract = getContractSpec(intent.instrument.root);
  const basePrice = intent.side === 'buy' ? market.ask_px : market.bid_px;
  const rawPrice =
    intent.side === 'buy'
      ? basePrice + slippagePoints
      : basePrice - slippagePoints;
  const adverseRoundedPrice = roundToTick(
    rawPrice,
    contract,
    intent.side === 'buy' ? 'up' : 'down',
  );
  const roundedLimit =
    limitPrice === undefined
      ? undefined
      : roundToTick(limitPrice, contract, intent.side === 'buy' ? 'down' : 'up');
  const cappedPrice =
    roundedLimit === undefined
      ? adverseRoundedPrice
      : intent.side === 'buy'
        ? Math.min(adverseRoundedPrice, roundedLimit)
        : Math.max(adverseRoundedPrice, roundedLimit);
  const roundedPrice = roundToTick(
    cappedPrice,
    contract,
    intent.side === 'buy' ? 'up' : 'down',
  );
  const adverseSlippage =
    intent.side === 'buy'
      ? Math.max(0, roundedPrice - basePrice)
      : Math.max(0, basePrice - roundedPrice);

  return {
    kind: 'fill',
    price: roundedPrice,
    slippage_points: adverseSlippage,
    liquidity,
  };
}

function buildFill(input: {
  readonly intent: SimulatedOrderIntent;
  readonly contract: ContractSpec;
  readonly venue_cost: VenueCostConfig;
  readonly fill_price: number;
  readonly slippage_points: number;
  readonly liquidity: SimulatedFill['liquidity'];
  readonly filled_ts_ns: UnixNs;
}): SimulatedFill {
  const quantity = input.intent.quantity;
  return {
    fill_id: makeFillId(`fill-${input.intent.order_intent_id}-1`),
    order_intent_id: input.intent.order_intent_id,
    instrument: input.intent.instrument,
    side: input.intent.side,
    quantity,
    price: roundToTick(input.fill_price, input.contract),
    liquidity: input.liquidity,
    exchange_fee_usd: roundCurrency(
      input.venue_cost.exchange_fees_per_side_per_contract_usd * quantity,
    ),
    commission_usd: roundCurrency(
      input.venue_cost.commission_per_side_per_contract_usd * quantity,
    ),
    slippage_points: input.slippage_points,
    filled_ts_ns: input.filled_ts_ns,
    config: input.intent.config,
  };
}

function validateSubmitInput(input: SubmitSimulatedOrderInput): string | undefined {
  if (input.intent.instrument.symbol !== input.market.instrument.symbol) {
    return 'instrument_symbol_mismatch';
  }
  if (!Number.isInteger(input.intent.quantity) || input.intent.quantity <= 0) {
    return 'quantity_must_be_positive_integer';
  }
  if (!Number.isFinite(input.market.bid_px) || !Number.isFinite(input.market.ask_px)) {
    return 'bbo_prices_must_be_finite';
  }
  if (input.market.bid_px <= 0 || input.market.ask_px <= 0) {
    return 'bbo_prices_must_be_positive';
  }
  if (input.market.bid_px > input.market.ask_px) {
    return 'bid_above_ask';
  }
  if (input.intent.type === 'limit' && input.intent.limit_price === undefined) {
    return 'limit_price_required';
  }
  if (input.intent.type === 'stop_market' && input.intent.stop_price === undefined) {
    return 'stop_price_required';
  }
  return undefined;
}

function rejectOrder(
  intent: SimulatedOrderIntent,
  reason: string,
): SimulatedOrderResult {
  return {
    order_intent_id: intent.order_intent_id,
    status: 'rejected',
    submitted_ts_ns: intent.submitted_ts_ns,
    fills: [],
    reject_reason: reason,
  };
}

function validateExecutionConfig(config: SimulatedExecutionConfig): void {
  if (!Number.isFinite(config.marketable_slippage_points) || config.marketable_slippage_points < 0) {
    throw new Error('marketable_slippage_points must be a non-negative finite number');
  }
}
