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
import {
  computeQueueAwareLimitFill,
  type QueueAwareMarketState,
} from './fill-model.js';
import {
  FixedSeedRandomSource,
  sampleMarketableAdverseSlippage,
  type DeterministicRandomSource,
  type MarketableSlippageSample,
} from './slippage-model.js';

export const SIMULATED_EXECUTION_VERSION = 'simulated_execution_v2' as const;

export interface SimulatedExecutionConfig {
  readonly marketable_slippage_points: number;
  readonly marketable_adverse_extra_tick_probability: number;
  readonly queue_default_drain_rate_contracts_per_second: number;
}

export const DEFAULT_SIMULATED_EXECUTION_CONFIG: SimulatedExecutionConfig = {
  marketable_slippage_points: 0.25,
  marketable_adverse_extra_tick_probability: 0,
  queue_default_drain_rate_contracts_per_second: 1,
};

export interface SimulatedExecutionMarketState {
  readonly instrument: InstrumentIdentity;
  readonly ts_ns: UnixNs;
  readonly bid_px: number;
  readonly ask_px: number;
  readonly last_trade_price?: number;
  readonly queue?: QueueAwareMarketState;
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
  readonly rng?: DeterministicRandomSource;
  readonly rng_seed?: number;
}

export class DeterministicSimulatedExecutionAdapter implements SimulatedExecutionAdapter {
  readonly adapter = 'simulated' as const;
  readonly version = SIMULATED_EXECUTION_VERSION;
  private readonly config: SimulatedExecutionConfig;
  private readonly rng: DeterministicRandomSource;

  constructor(private readonly options: CreateSimulatedExecutionAdapterOptions) {
    this.config = {
      ...DEFAULT_SIMULATED_EXECUTION_CONFIG,
      ...options.config,
    };
    this.rng = options.rng ?? new FixedSeedRandomSource(options.rng_seed);
    validateExecutionConfig(this.config);
  }

  async submit(input: SubmitSimulatedOrderInput): Promise<SimulatedOrderResult> {
    const rejection = validateSubmitInput(input);
    if (rejection !== undefined) {
      return rejectOrder(input.intent, rejection);
    }

    const fillPlan = computeFillPlan(input.intent, input.market, this.config, this.rng);
    if (fillPlan.kind === 'no_fill') {
      const status =
        fillPlan.reason === 'post_only_would_cross'
          ? 'rejected'
          : input.intent.time_in_force === 'ioc'
            ? 'cancelled'
            : 'accepted';
      return {
        order_intent_id: input.intent.order_intent_id,
        status,
        submitted_ts_ns: input.intent.submitted_ts_ns,
        fills: [],
        reject_reason:
          status === 'rejected'
            ? fillPlan.reason
            : status === 'cancelled'
              ? `${fillPlan.reason}:ioc_cancelled`
              : undefined,
      };
    }

    const contract = getContractSpec(input.intent.instrument.root);
    const venueCost = getVenueCostConfig(this.options.venue_costs, contract.root);
    const fill = buildFill({
      intent: input.intent,
      contract,
      venue_cost: venueCost,
      fill_price: fillPlan.price,
      quantity: fillPlan.quantity,
      slippage_points: fillPlan.slippage_points,
      liquidity: fillPlan.liquidity,
      filled_ts_ns: input.fill_ts_ns ?? input.market.ts_ns,
      metadata: fillPlan.metadata,
    });

    return {
      order_intent_id: input.intent.order_intent_id,
      status: fillPlan.quantity < input.intent.quantity ? 'partially_filled' : 'filled',
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
    execution_model_version: fill.execution_model_version,
    fill_model: fill.fill_model,
    input_tier: fill.input_tier,
    fill_probability: fill.fill_probability,
    time_to_fill_estimate_ms: fill.time_to_fill_estimate_ms,
    queue_position_estimate: fill.queue_position_estimate,
    queue_ahead_size_estimate: fill.queue_ahead_size_estimate,
    queue_ahead_order_count_estimate: fill.queue_ahead_order_count_estimate,
    queue_consumed_size: fill.queue_consumed_size,
    partial_fill_reason: fill.partial_fill_reason,
    adverse_tick_draw: fill.adverse_tick_draw,
    adverse_ticks: fill.adverse_ticks,
    calibration_status: fill.calibration_status,
  };
}

interface FillPlan {
  readonly kind: 'fill';
  readonly quantity: number;
  readonly price: number;
  readonly slippage_points: number;
  readonly liquidity: SimulatedFill['liquidity'];
  readonly metadata?: FillPlanMetadata;
}

interface FillPlanMetadata extends Partial<MarketableSlippageSample> {
  readonly execution_model_version: typeof SIMULATED_EXECUTION_VERSION;
  readonly fill_model: 'bbo_market_taker' | 'queue_aware_limit_post_only';
  readonly input_tier: 'authoritative' | 'subscope' | 'diagnostic_only' | 'blocked';
  readonly fill_probability?: number;
  readonly time_to_fill_estimate_ms?: number;
  readonly queue_position_estimate?: number;
  readonly queue_ahead_size_estimate?: number;
  readonly queue_ahead_order_count_estimate?: number;
  readonly queue_consumed_size?: number;
  readonly partial_fill_reason?: string;
}

interface NoFillPlan {
  readonly kind: 'no_fill';
  readonly reason: string;
}

function computeFillPlan(
  intent: SimulatedOrderIntent,
  market: SimulatedExecutionMarketState,
  config: SimulatedExecutionConfig,
  rng: DeterministicRandomSource,
): FillPlan | NoFillPlan {
  if (intent.type === 'market') {
    return fillAgainstBbo(intent, market, config, rng, undefined, 'taker');
  }

  if (intent.type === 'limit' || intent.type === 'limit_post_only') {
    if (intent.limit_price === undefined) {
      return { kind: 'no_fill', reason: 'missing_limit_price' };
    }
    const crosses =
      intent.side === 'buy'
        ? intent.limit_price >= market.ask_px
        : intent.limit_price <= market.bid_px;
    if (intent.type === 'limit_post_only') {
      if (crosses) {
        return { kind: 'no_fill', reason: 'post_only_would_cross' };
      }
      return fillQueueAwarePostOnly(intent, market, config);
    }
    if (!crosses) {
      return { kind: 'no_fill', reason: 'limit_not_marketable' };
    }
    return fillAgainstBbo(intent, market, config, rng, intent.limit_price, 'taker');
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
  return fillAgainstBbo(intent, market, config, rng, undefined, 'taker');
}

function fillAgainstBbo(
  intent: SimulatedOrderIntent,
  market: SimulatedExecutionMarketState,
  config: SimulatedExecutionConfig,
  rng: DeterministicRandomSource,
  limitPrice: number | undefined,
  liquidity: SimulatedFill['liquidity'],
): FillPlan {
  const contract = getContractSpec(intent.instrument.root);
  const slippage = sampleMarketableAdverseSlippage({
    base_slippage_points: config.marketable_slippage_points,
    extra_tick_probability: config.marketable_adverse_extra_tick_probability,
    contract,
    rng,
  });
  const basePrice = intent.side === 'buy' ? market.ask_px : market.bid_px;
  const rawPrice =
    intent.side === 'buy'
      ? basePrice + slippage.slippage_points
      : basePrice - slippage.slippage_points;
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
  const actualAdverseTicks = Math.round(adverseSlippage / contract.tick_size);

  return {
    kind: 'fill',
    quantity: intent.quantity,
    price: roundedPrice,
    slippage_points: adverseSlippage,
    liquidity,
    metadata: {
      ...slippage,
      slippage_points: adverseSlippage,
      adverse_ticks: actualAdverseTicks,
      execution_model_version: SIMULATED_EXECUTION_VERSION,
      fill_model: 'bbo_market_taker',
      input_tier: 'authoritative',
    },
  };
}

function fillQueueAwarePostOnly(
  intent: SimulatedOrderIntent,
  market: SimulatedExecutionMarketState,
  config: SimulatedExecutionConfig,
): FillPlan | NoFillPlan {
  if (intent.limit_price === undefined) {
    return { kind: 'no_fill', reason: 'missing_limit_price' };
  }
  const queueDecision = computeQueueAwareLimitFill({
    side: intent.side,
    quantity: intent.quantity,
    limit_price: intent.limit_price,
    queue: market.queue,
    config: {
      default_queue_drain_rate_contracts_per_second:
        config.queue_default_drain_rate_contracts_per_second,
    },
  });
  if (queueDecision.kind === 'no_fill') {
    return { kind: 'no_fill', reason: queueDecision.reason ?? 'queue_not_reached' };
  }
  return {
    kind: 'fill',
    quantity: queueDecision.quantity,
    price: roundToTick(intent.limit_price, getContractSpec(intent.instrument.root)),
    slippage_points: 0,
    liquidity: 'maker',
    metadata: queueDecision.metadata,
  };
}

function buildFill(input: {
  readonly intent: SimulatedOrderIntent;
  readonly contract: ContractSpec;
  readonly venue_cost: VenueCostConfig;
  readonly fill_price: number;
  readonly quantity: number;
  readonly slippage_points: number;
  readonly liquidity: SimulatedFill['liquidity'];
  readonly filled_ts_ns: UnixNs;
  readonly metadata?: FillPlanMetadata;
}): SimulatedFill {
  const quantity = input.quantity;
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
    execution_model_version: input.metadata?.execution_model_version,
    fill_model: input.metadata?.fill_model,
    input_tier: input.metadata?.input_tier,
    fill_probability: input.metadata?.fill_probability,
    time_to_fill_estimate_ms: input.metadata?.time_to_fill_estimate_ms,
    queue_position_estimate: input.metadata?.queue_position_estimate,
    queue_ahead_size_estimate: input.metadata?.queue_ahead_size_estimate,
    queue_ahead_order_count_estimate: input.metadata?.queue_ahead_order_count_estimate,
    queue_consumed_size: input.metadata?.queue_consumed_size,
    partial_fill_reason: input.metadata?.partial_fill_reason,
    adverse_tick_draw: input.metadata?.adverse_tick_draw,
    adverse_ticks: input.metadata?.adverse_ticks,
    calibration_status: input.metadata?.calibration_status,
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
  if (
    (input.intent.type === 'limit' || input.intent.type === 'limit_post_only') &&
    input.intent.limit_price === undefined
  ) {
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
  if (
    !Number.isFinite(config.marketable_adverse_extra_tick_probability) ||
    config.marketable_adverse_extra_tick_probability < 0 ||
    config.marketable_adverse_extra_tick_probability > 1
  ) {
    throw new Error('marketable_adverse_extra_tick_probability must be between 0 and 1');
  }
  if (
    !Number.isFinite(config.queue_default_drain_rate_contracts_per_second) ||
    config.queue_default_drain_rate_contracts_per_second <= 0
  ) {
    throw new Error('queue_default_drain_rate_contracts_per_second must be positive');
  }
}
