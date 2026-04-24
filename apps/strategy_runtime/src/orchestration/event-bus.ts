import {
  categorizeRuntimeEventType,
  channelsForEventType,
  channelsForSubscriber,
  formatJournalEventSchemaValidationErrors,
  validateJournalEventEnvelope,
  type EventChannel,
  type JournalEventEnvelope,
  type OperatorSurfaceSubscriber,
  type RuntimeEventType,
  type UnixNs,
} from '../contracts/index.js';

export interface RuntimeEventBusOptions {
  readonly causation_buffer_capacity?: number;
}

export interface RuntimeEventBusSubscription {
  readonly subscription_id: number;
  readonly unsubscribe: () => void;
}

export interface RuntimeEventBusSubscribeOptions {
  readonly channels?: readonly EventChannel[];
  readonly event_types?: readonly RuntimeEventType[];
}

export interface RuntimeEventBusDelivery {
  readonly event: JournalEventEnvelope;
  readonly channels: readonly EventChannel[];
  readonly sequence: number;
  readonly bus_head_ts_ns: UnixNs;
}

export interface RuntimeEventBusPublishResult {
  readonly event: JournalEventEnvelope;
  readonly channels: readonly EventChannel[];
  readonly sequence: number;
  readonly subscriber_count: number;
  readonly bus_head_ts_ns: UnixNs;
}

export interface RuntimeEventBusSnapshot {
  readonly published_events: number;
  readonly active_subscriptions: number;
  readonly head_ts_ns?: UnixNs;
  readonly causation_buffer_size: number;
}

interface RuntimeEventSubscriber {
  readonly subscription_id: number;
  readonly channels: readonly EventChannel[];
  readonly event_types: readonly RuntimeEventType[];
  readonly handler: (delivery: RuntimeEventBusDelivery) => void | Promise<void>;
}

interface CausationEntry {
  readonly event_id: string;
  readonly ts_ns: UnixNs;
  readonly type: RuntimeEventType;
  readonly causation_id?: string;
}

const DEFAULT_CAUSATION_BUFFER_CAPACITY = 4_096;

export class RuntimeEventBus {
  private readonly causationBufferCapacity: number;
  private readonly causationBuffer: CausationEntry[] = [];
  private readonly subscribers: RuntimeEventSubscriber[] = [];
  private nextSubscriptionId = 1;
  private nextPublishSequence = 1;
  private headTsNs: UnixNs | undefined;

  constructor(options: RuntimeEventBusOptions = {}) {
    this.causationBufferCapacity =
      options.causation_buffer_capacity ?? DEFAULT_CAUSATION_BUFFER_CAPACITY;
    if (
      !Number.isSafeInteger(this.causationBufferCapacity) ||
      this.causationBufferCapacity < 1
    ) {
      throw new Error('RuntimeEventBus causation_buffer_capacity must be a positive safe integer');
    }
  }

  subscribe(
    options: RuntimeEventBusSubscribeOptions,
    handler: (delivery: RuntimeEventBusDelivery) => void | Promise<void>,
  ): RuntimeEventBusSubscription {
    const subscription: RuntimeEventSubscriber = {
      subscription_id: this.nextSubscriptionId,
      channels: [...(options.channels ?? [])],
      event_types: [...(options.event_types ?? [])],
      handler,
    };
    this.nextSubscriptionId += 1;
    this.subscribers.push(subscription);

    return {
      subscription_id: subscription.subscription_id,
      unsubscribe: () => {
        const index = this.subscribers.findIndex(
          (candidate) => candidate.subscription_id === subscription.subscription_id,
        );
        if (index >= 0) {
          this.subscribers.splice(index, 1);
        }
      },
    };
  }

  subscribeToSubscriberProfile(
    subscriber: OperatorSurfaceSubscriber,
    handler: (delivery: RuntimeEventBusDelivery) => void | Promise<void>,
  ): RuntimeEventBusSubscription {
    return this.subscribe(
      {
        channels: channelsForSubscriber(subscriber),
      },
      handler,
    );
  }

  async publish(event: JournalEventEnvelope): Promise<RuntimeEventBusPublishResult> {
    assertEventAcceptedByBus(event, this.causationBuffer);

    const channels = channelsForEventType(event.type, { include_raw: true });
    this.headTsNs = maxNs(this.headTsNs, event.ts_ns);
    const sequence = this.nextPublishSequence;
    this.nextPublishSequence += 1;

    const delivery: RuntimeEventBusDelivery = {
      event,
      channels,
      sequence,
      bus_head_ts_ns: this.headTsNs,
    };
    this.recordCausationEntry(event);

    const subscribers = this.subscribers.filter((subscriber) =>
      subscriberMatchesDelivery(subscriber, event, channels),
    );
    for (const subscriber of subscribers) {
      await subscriber.handler(delivery);
    }

    return {
      event,
      channels,
      sequence,
      subscriber_count: subscribers.length,
      bus_head_ts_ns: this.headTsNs,
    };
  }

  getHeadTsNs(): UnixNs | undefined {
    return this.headTsNs;
  }

  snapshot(): RuntimeEventBusSnapshot {
    return {
      published_events: this.nextPublishSequence - 1,
      active_subscriptions: this.subscribers.length,
      head_ts_ns: this.headTsNs,
      causation_buffer_size: this.causationBuffer.length,
    };
  }

  private recordCausationEntry(event: JournalEventEnvelope): void {
    const existingIndex = this.causationBuffer.findIndex(
      (entry) => entry.event_id === event.event_id,
    );
    if (existingIndex >= 0) {
      this.causationBuffer.splice(existingIndex, 1);
    }

    this.causationBuffer.push({
      event_id: event.event_id,
      ts_ns: event.ts_ns,
      type: event.type,
      ...(event.causation_id === undefined ? {} : { causation_id: event.causation_id }),
    });

    while (this.causationBuffer.length > this.causationBufferCapacity) {
      this.causationBuffer.shift();
    }
  }
}

function assertEventAcceptedByBus(
  event: JournalEventEnvelope,
  causationBuffer: readonly CausationEntry[],
): void {
  const schemaValidation = validateJournalEventEnvelope(event);
  if (!schemaValidation.ok) {
    throw new Error(formatJournalEventSchemaValidationErrors(schemaValidation.issues));
  }

  const category = categorizeRuntimeEventType(event.type);
  if (category === 'source_market_data') {
    assertSourceMarketDataTimestamp(event);
    return;
  }

  if (category === 'derived') {
    assertDerivedCausationTimestamp(event, causationBuffer);
  }
}

function assertSourceMarketDataTimestamp(event: JournalEventEnvelope): void {
  if (event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    throw new Error('source market-data event payload must be an object');
  }
  const payload = event.payload as Record<string, unknown>;
  const exchangeEventTsNs = payload.exchange_event_ts_ns;
  if (typeof exchangeEventTsNs !== 'bigint') {
    throw new Error('source market-data event payload.exchange_event_ts_ns is required');
  }
  if (BigInt(event.ts_ns) !== exchangeEventTsNs) {
    throw new Error('source market-data event ts_ns must equal payload.exchange_event_ts_ns');
  }
}

function assertDerivedCausationTimestamp(
  event: JournalEventEnvelope,
  causationBuffer: readonly CausationEntry[],
): void {
  if (event.causation_id === undefined) {
    throw new Error(`derived event ${event.type} requires causation_id`);
  }
  const cause = causationBuffer.find((entry) => entry.event_id === event.causation_id);
  if (cause === undefined) {
    throw new Error(
      `derived event ${event.type} causation_id ${event.causation_id} is not in event bus causation buffer`,
    );
  }
  if (BigInt(event.ts_ns) !== BigInt(cause.ts_ns)) {
    throw new Error(`derived event ${event.type} ts_ns must equal causation event ts_ns`);
  }
}

function subscriberMatchesDelivery(
  subscriber: RuntimeEventSubscriber,
  event: JournalEventEnvelope,
  channels: readonly EventChannel[],
): boolean {
  if (subscriber.event_types.length > 0 && !subscriber.event_types.includes(event.type)) {
    return false;
  }
  if (subscriber.channels.length === 0) {
    return true;
  }
  return channels.some((channel) => subscriber.channels.includes(channel));
}

function maxNs(left: UnixNs | undefined, right: UnixNs): UnixNs {
  return left === undefined || BigInt(right) > BigInt(left) ? right : left;
}
