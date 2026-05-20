import {
  makeEventId,
  ns,
  type EventId,
  type JournalEventPayloadFor,
  type UnixNs,
} from '../../contracts/index.js';
import { buildExecutionCapabilityMask } from '../execution-capability-mask.js';
import {
  DEFAULT_BROKER_RECONNECT_POLICY_CONFIG,
  type BrokerAckEnvelope,
  type BrokerAdapter,
  type BrokerCancelRequest,
  type BrokerReconnectPolicyConfig,
  type BrokerRejectSubreason,
  type BrokerSessionEvent,
  type OrderIntentEventEnvelope,
  type PlantScope,
  type RuntimeMode,
  type Unsubscribe,
} from './broker-adapter.js';

const DEFAULT_MOCK_SEED = 'qfa-612-paper-01a-default-seed';
const DEFAULT_BASE_TS_NS = 1_800_000_000_000_000_000n;
const DEFAULT_TS_STEP_NS = 1_000_000n;
const NS_PER_MS = 1_000_000n;

export type MockOrderPlantFillBehavior =
  | {
      readonly kind: 'immediate_full_fill';
      readonly fill_price?: number;
    }
  | {
      readonly kind: 'partial_fills';
      readonly fills: readonly MockPartialFillSpec[];
    }
  | {
      readonly kind: 'no_fill_cancel_required';
    }
  | {
      readonly kind: 'broker_reject';
      readonly reject_reason_code: string;
      readonly reject_subreason: BrokerRejectSubreason;
      readonly reject_message_redacted: string;
      readonly include_broker_order_id?: boolean;
    };

export interface MockPartialFillSpec {
  readonly quantity: number;
  readonly price?: number;
  readonly latency_ms?: number;
  readonly fill_kind?: 'PARTIAL' | 'FULL';
}

export interface MockOrderPlantAckLatencies {
  readonly submission_ack_ms?: number;
  readonly fill_ack_ms?: number;
  readonly cancel_ack_ms?: number;
  readonly reject_ack_ms?: number;
}

export interface MockOrderPlantAdapterOptions {
  readonly seed?: string;
  readonly ack_latencies?: MockOrderPlantAckLatencies;
  readonly fill_behavior?: MockOrderPlantFillBehavior;
  readonly broker_account_id?: string;
  readonly instrument_symbol?: string;
  readonly default_fill_price?: number;
  readonly base_timestamp_ns?: UnixNs | bigint | string;
  readonly timestamp_step_ns?: bigint;
  readonly reconnect_policy_config?: BrokerReconnectPolicyConfig;
  readonly broker_session_id?: string;
}

interface AcceptedOrder {
  readonly intent_id: EventId;
  readonly submission_ack_id: EventId;
  readonly broker_order_id: string;
  readonly broker_account_id: string;
  readonly instrument_symbol: string;
  readonly broker_intent_correlation_id: string;
}

export class MockOrderPlantAdapter implements BrokerAdapter {
  readonly plant_scope: PlantScope = 'ORDER_PLANT';
  readonly mode: RuntimeMode = 'paper';

  private readonly seed: string;
  private readonly rng: SeededRng;
  private readonly ackLatencies: Required<MockOrderPlantAckLatencies>;
  private readonly fillBehavior: MockOrderPlantFillBehavior;
  private readonly brokerAccountId: string;
  private readonly instrumentSymbol: string;
  private readonly defaultFillPrice: number;
  private readonly baseTimestampNs: bigint;
  private readonly timestampStepNs: bigint;
  private readonly reconnectPolicyConfig: BrokerReconnectPolicyConfig;
  private readonly brokerSessionId: string;
  private readonly ackHandlers = new Set<(event: BrokerAckEnvelope) => void>();
  private readonly sessionHandlers = new Set<(event: BrokerSessionEvent) => void>();
  private readonly ordersByIntentId = new Map<string, AcceptedOrder>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private running = false;
  private orderSequence = 0;
  private timestampSequence = 0;
  private submittedIntentCountValue = 0;

  constructor(options: MockOrderPlantAdapterOptions = {}) {
    this.seed = options.seed ?? DEFAULT_MOCK_SEED;
    this.rng = new SeededRng(this.seed);
    this.ackLatencies = {
      submission_ack_ms: options.ack_latencies?.submission_ack_ms ?? 0,
      fill_ack_ms: options.ack_latencies?.fill_ack_ms ?? 0,
      cancel_ack_ms: options.ack_latencies?.cancel_ack_ms ?? 0,
      reject_ack_ms: options.ack_latencies?.reject_ack_ms ?? 0,
    };
    this.fillBehavior = options.fill_behavior ?? { kind: 'immediate_full_fill' };
    this.brokerAccountId = options.broker_account_id ?? 'paper-account-mock';
    this.instrumentSymbol = options.instrument_symbol ?? 'MNQM6';
    this.defaultFillPrice = options.default_fill_price ?? 19_750.25;
    this.baseTimestampNs =
      options.base_timestamp_ns === undefined
        ? DEFAULT_BASE_TS_NS
        : BigInt(options.base_timestamp_ns);
    this.timestampStepNs = options.timestamp_step_ns ?? DEFAULT_TS_STEP_NS;
    this.reconnectPolicyConfig =
      options.reconnect_policy_config ?? DEFAULT_BROKER_RECONNECT_POLICY_CONFIG;
    this.brokerSessionId =
      options.broker_session_id ?? `mock-order-plant-session-${sanitizeSeed(this.seed)}`;
  }

  async start(): Promise<void> {
    this.running = true;
    const mask = buildExecutionCapabilityMask();
    this.emitSession({
      type: 'SESSION_MANIFEST',
      ts_ns: this.nextBrokerTimestampNs(),
      payload: {
        mask_id: mask.mask_id,
        mask_version: mask.mask_version,
        mask_hash: mask.mask_hash,
        reconnect_policy_config: this.reconnectPolicyConfig,
        plant_scope: 'ORDER_PLANT',
        mode: 'paper',
        timestamp_anchor: 'broker_exchange_ts_ns',
        broker_session_id: this.brokerSessionId,
        adapter_kind: 'MOCK_ORDER_PLANT',
      },
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.ordersByIntentId.clear();
  }

  async submitIntent(
    intent: OrderIntentEventEnvelope,
  ): Promise<{ readonly accepted: boolean; readonly broker_intent_correlation_id: string }> {
    this.requireRunning();
    this.submittedIntentCountValue += 1;
    this.orderSequence += 1;

    const brokerOrderId = `MOCK-${this.orderSequence}-${this.rng.nextHex(8)}`;
    const brokerIntentCorrelationId = `mock-correlation-${this.orderSequence}-${this.rng.nextHex(8)}`;
    const submissionAckId = makeEventId(`mock-submission-ack-${intent.event_id}`);
    const order: AcceptedOrder = {
      intent_id: intent.event_id,
      submission_ack_id: submissionAckId,
      broker_order_id: brokerOrderId,
      broker_account_id: this.brokerAccountId,
      instrument_symbol: this.instrumentSymbol,
      broker_intent_correlation_id: brokerIntentCorrelationId,
    };
    this.ordersByIntentId.set(String(intent.event_id), order);

    if (this.fillBehavior.kind === 'broker_reject') {
      const rejectBehavior = this.fillBehavior;
      this.schedule(this.ackLatencies.reject_ack_ms, () => {
        const payload: JournalEventPayloadFor<'ORDER_BROKER_REJECT'> = {
          intent_id: intent.event_id,
          ...(rejectBehavior.include_broker_order_id === false
            ? {}
            : { broker_order_id: brokerOrderId }),
          broker_account_id: this.brokerAccountId,
          reject_reason_code: rejectBehavior.reject_reason_code,
          reject_subreason: rejectBehavior.reject_subreason,
          reject_message_redacted: rejectBehavior.reject_message_redacted,
        };
        this.emitAck({
          type: 'ORDER_BROKER_REJECT',
          ts_ns: this.nextBrokerTimestampNs(this.ackLatencies.reject_ack_ms),
          payload,
          broker_intent_correlation_id: brokerIntentCorrelationId,
        });
      });
      return { accepted: true, broker_intent_correlation_id: brokerIntentCorrelationId };
    }

    this.schedule(this.ackLatencies.submission_ack_ms, () => {
      this.emitAck({
        type: 'ORDER_ACK_SUBMISSION',
        ts_ns: this.nextBrokerTimestampNs(this.ackLatencies.submission_ack_ms),
        payload: {
          intent_id: intent.event_id,
          submission_ack_id: submissionAckId,
          broker_order_id: brokerOrderId,
          broker_account_id: this.brokerAccountId,
          instrument_symbol: this.instrumentSymbol,
        },
        broker_intent_correlation_id: brokerIntentCorrelationId,
      });
    });

    this.scheduleFillAcks(intent, order);
    return { accepted: true, broker_intent_correlation_id: brokerIntentCorrelationId };
  }

  async requestCancel(request: BrokerCancelRequest): Promise<{ readonly accepted: boolean }> {
    this.requireRunning();
    const order = this.ordersByIntentId.get(String(request.intent_id));
    if (order === undefined) {
      return { accepted: false };
    }

    this.schedule(this.ackLatencies.cancel_ack_ms, () => {
      this.emitAck({
        type: 'ORDER_ACK_CANCEL',
        ts_ns: this.nextBrokerTimestampNs(this.ackLatencies.cancel_ack_ms),
        payload: {
          intent_id: request.intent_id,
          submission_ack_id: request.submission_ack_id,
          cancel_ack_id: makeEventId(`mock-cancel-ack-${request.intent_id}`),
          broker_order_id: order.broker_order_id,
          broker_account_id: order.broker_account_id,
          cancel_reason: 'CLIENT_REQUESTED',
        },
        broker_intent_correlation_id: order.broker_intent_correlation_id,
      });
    });
    return { accepted: true };
  }

  subscribeAckEvents(handler: (event: BrokerAckEnvelope) => void): Unsubscribe {
    this.ackHandlers.add(handler);
    return () => {
      this.ackHandlers.delete(handler);
    };
  }

  subscribeSessionEvents(handler: (event: BrokerSessionEvent) => void): Unsubscribe {
    this.sessionHandlers.add(handler);
    return () => {
      this.sessionHandlers.delete(handler);
    };
  }

  get submitted_intent_count(): number {
    return this.submittedIntentCountValue;
  }

  private scheduleFillAcks(intent: OrderIntentEventEnvelope, order: AcceptedOrder): void {
    if (this.fillBehavior.kind === 'no_fill_cancel_required') {
      return;
    }

    if (this.fillBehavior.kind === 'immediate_full_fill') {
      const fullFillBehavior = this.fillBehavior;
      this.schedule(this.ackLatencies.fill_ack_ms, () => {
        this.emitAck({
          type: 'ORDER_ACK_FILL',
          ts_ns: this.nextBrokerTimestampNs(this.ackLatencies.fill_ack_ms),
          payload: {
            intent_id: intent.event_id,
            submission_ack_id: order.submission_ack_id,
            fill_ack_id: makeEventId(`mock-fill-ack-${intent.event_id}-full`),
            broker_order_id: order.broker_order_id,
            broker_account_id: order.broker_account_id,
            instrument_symbol: order.instrument_symbol,
            fill_qty: intent.payload.quantity,
            fill_price:
              fullFillBehavior.fill_price ??
              intent.payload.limit_price ??
              intent.payload.stop_price ??
              this.defaultFillPrice,
            fill_kind: 'FULL',
          },
          broker_intent_correlation_id: order.broker_intent_correlation_id,
        });
      });
      return;
    }

    if (this.fillBehavior.kind !== 'partial_fills') {
      return;
    }

    const partialFillBehavior = this.fillBehavior;
    partialFillBehavior.fills.forEach((fill: MockPartialFillSpec, index: number) => {
      const latencyMs = fill.latency_ms ?? this.ackLatencies.fill_ack_ms;
      const fillKind =
        fill.fill_kind ?? (index === partialFillBehavior.fills.length - 1 ? 'FULL' : 'PARTIAL');
      this.schedule(latencyMs, () => {
        this.emitAck({
          type: 'ORDER_ACK_FILL',
          ts_ns: this.nextBrokerTimestampNs(latencyMs),
          payload: {
            intent_id: intent.event_id,
            submission_ack_id: order.submission_ack_id,
            fill_ack_id: makeEventId(`mock-fill-ack-${intent.event_id}-${index + 1}`),
            broker_order_id: order.broker_order_id,
            broker_account_id: order.broker_account_id,
            instrument_symbol: order.instrument_symbol,
            fill_qty: fill.quantity,
            fill_price:
              fill.price ?? intent.payload.limit_price ?? intent.payload.stop_price ?? this.defaultFillPrice,
            fill_kind: fillKind,
          },
          broker_intent_correlation_id: order.broker_intent_correlation_id,
        });
      });
    });
  }

  private schedule(delayMs: number, callback: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.running) {
        callback();
      }
    }, delayMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  private emitAck(event: BrokerAckEnvelope): void {
    for (const handler of this.ackHandlers) {
      handler(event);
    }
  }

  private emitSession(event: BrokerSessionEvent): void {
    for (const handler of this.sessionHandlers) {
      handler(event);
    }
  }

  private nextBrokerTimestampNs(delayMs = 0): UnixNs {
    const timestamp =
      this.baseTimestampNs +
      BigInt(this.timestampSequence) * this.timestampStepNs +
      BigInt(delayMs) * NS_PER_MS;
    this.timestampSequence += 1;
    return ns(timestamp);
  }

  private requireRunning(): void {
    if (!this.running) {
      throw new Error('MockOrderPlantAdapter must be started before use');
    }
  }
}

class SeededRng {
  private state: number;

  constructor(seed: string) {
    this.state = hashSeed(seed);
  }

  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  nextHex(width: number): string {
    return this.nextUint32().toString(16).padStart(width, '0').slice(0, width);
  }
}

function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function sanitizeSeed(seed: string): string {
  return seed.replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 64) || 'default';
}
