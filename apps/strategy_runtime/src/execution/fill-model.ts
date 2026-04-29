import type { OrderSide } from '../contracts/market.js';
import type { FeatureAvailabilityTier } from '../features/availability-mask.js';

export type SimFillInputTier = Exclude<FeatureAvailabilityTier, 'shadow_only'>;

export interface QueueAwareMarketState {
  readonly queue_position_estimate?: number;
  readonly queue_ahead_size_estimate?: number;
  readonly queue_ahead_order_count_estimate?: number;
  readonly level_aggregate_size_subscope?: number;
  readonly expected_trade_through_size?: number;
  readonly recent_ofi_rate?: number;
  readonly input_tier?: SimFillInputTier;
}

export interface QueueAwareFillConfig {
  readonly default_queue_drain_rate_contracts_per_second: number;
}

export interface QueueAwareFillInput {
  readonly side: OrderSide;
  readonly quantity: number;
  readonly limit_price: number;
  readonly queue?: QueueAwareMarketState;
  readonly config: QueueAwareFillConfig;
}

export interface QueueAwareFillMetadata {
  readonly execution_model_version: 'simulated_execution_v2';
  readonly fill_model: 'queue_aware_limit_post_only';
  readonly input_tier: SimFillInputTier;
  readonly queue_position_estimate: number;
  readonly queue_ahead_size_estimate: number;
  readonly queue_ahead_order_count_estimate?: number;
  readonly queue_consumed_size: number;
  readonly fill_probability: number;
  readonly time_to_fill_estimate_ms: number;
  readonly calibration_status: 'placeholder_pending_sim03';
  readonly partial_fill_reason?: 'queue_partially_depleted';
}

export interface QueueAwareFillDecision {
  readonly kind: 'fill' | 'partial_fill' | 'no_fill';
  readonly quantity: number;
  readonly reason?: string;
  readonly metadata?: QueueAwareFillMetadata;
}

export function computeQueueAwareLimitFill(input: QueueAwareFillInput): QueueAwareFillDecision {
  const queue = input.queue;
  const queuePosition = finiteNonNegative(queue?.queue_position_estimate);
  const queueAheadSize = finiteNonNegative(queue?.queue_ahead_size_estimate);
  if (queue === undefined || queuePosition === undefined || queueAheadSize === undefined) {
    return { kind: 'no_fill', quantity: 0, reason: 'missing_queue_position_estimate' };
  }

  const consumedSize = finiteNonNegative(queue.expected_trade_through_size) ?? 0;
  if (consumedSize <= queueAheadSize) {
    return {
      kind: 'no_fill',
      quantity: 0,
      reason: 'queue_not_reached',
      metadata: queueMetadata({
        input,
        queue_position_estimate: queuePosition,
        queue_ahead_size_estimate: queueAheadSize,
        queue_consumed_size: consumedSize,
        fill_quantity: 0,
      }),
    };
  }

  const fillableQuantity = Math.min(
    input.quantity,
    Math.floor(consumedSize - queueAheadSize),
  );
  if (fillableQuantity <= 0) {
    return {
      kind: 'no_fill',
      quantity: 0,
      reason: 'queue_not_reached',
      metadata: queueMetadata({
        input,
        queue_position_estimate: queuePosition,
        queue_ahead_size_estimate: queueAheadSize,
        queue_consumed_size: consumedSize,
        fill_quantity: 0,
      }),
    };
  }

  const metadata = queueMetadata({
    input,
    queue_position_estimate: queuePosition,
    queue_ahead_size_estimate: queueAheadSize,
    queue_consumed_size: consumedSize,
    fill_quantity: fillableQuantity,
  });

  if (fillableQuantity < input.quantity) {
    return {
      kind: 'partial_fill',
      quantity: fillableQuantity,
      metadata: {
        ...metadata,
        partial_fill_reason: 'queue_partially_depleted',
      },
    };
  }

  return {
    kind: 'fill',
    quantity: fillableQuantity,
    metadata,
  };
}

export function strictestTier(
  tiers: readonly SimFillInputTier[],
): SimFillInputTier {
  const order: Record<SimFillInputTier, number> = {
    authoritative: 0,
    subscope: 1,
    diagnostic_only: 2,
    blocked: 3,
  };
  return tiers.reduce<SimFillInputTier>(
    (strictest, tier) => (order[tier] > order[strictest] ? tier : strictest),
    'authoritative',
  );
}

function queueMetadata(input: {
  readonly input: QueueAwareFillInput;
  readonly queue_position_estimate: number;
  readonly queue_ahead_size_estimate: number;
  readonly queue_consumed_size: number;
  readonly fill_quantity: number;
}): QueueAwareFillMetadata {
  const queue = input.input.queue;
  const drainRate = Math.max(
    1,
    finiteNonNegative(queue?.recent_ofi_rate) ??
      input.input.config.default_queue_drain_rate_contracts_per_second,
  );
  const contractsUntilFull = input.queue_ahead_size_estimate + input.input.quantity;
  const timeToFillEstimateMs = Math.ceil((contractsUntilFull / drainRate) * 1000);
  return {
    execution_model_version: 'simulated_execution_v2',
    fill_model: 'queue_aware_limit_post_only',
    input_tier: strictestTier([queue?.input_tier ?? 'subscope']),
    queue_position_estimate: input.queue_position_estimate,
    queue_ahead_size_estimate: input.queue_ahead_size_estimate,
    ...(queue?.queue_ahead_order_count_estimate !== undefined
      ? { queue_ahead_order_count_estimate: queue.queue_ahead_order_count_estimate }
      : {}),
    queue_consumed_size: input.queue_consumed_size,
    fill_probability: round6(Math.min(1, input.fill_quantity / input.input.quantity)),
    time_to_fill_estimate_ms: timeToFillEstimateMs,
    calibration_status: 'placeholder_pending_sim03',
  };
}

function finiteNonNegative(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
