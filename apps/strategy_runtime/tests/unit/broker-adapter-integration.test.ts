import { describe, expect, it, vi } from 'vitest';
import {
  createJournalEventEnvelope,
  journalEventFromJsonLine,
  journalEventToJsonLine,
  makeCausationId,
  makeCandidateId,
  makeEventId,
  makeOrderIntentId,
  makeRunId,
  makeSessionId,
  makeSizingDecisionId,
  ns,
  validateJournalEventEnvelope,
  type AnyJournalEventEnvelope,
  type EventId,
  type JournalEventPayloadFor,
  type UnixNs,
} from '../../src/contracts/index.js';
import { BoundedAckLatencyObserver, LatencySliRegistry } from '../../src/observability/latency-sli.js';
import {
  buildExecutionCapabilityMask,
  type ExecutionCapabilityMask,
} from '../../src/execution/execution-capability-mask.js';
import {
  DEFAULT_BROKER_RECONNECT_POLICY_CONFIG,
  type BrokerAckEnvelope,
  type BrokerAdapter,
  type BrokerSessionEvent,
  type OrderIntentEventEnvelope,
  type PlantScope,
  type RuntimeMode,
  type Unsubscribe,
} from '../../src/execution/brokers/broker-adapter.js';
import { BrokerAdapterRuntimeIntegration } from '../../src/execution/brokers/broker-adapter-runtime.js';
import { MockOrderPlantAdapter } from '../../src/execution/brokers/mock-order-plant-adapter.js';
import { SubmissionGate } from '../../src/execution/order-lifecycle-state-machine.js';
import { AckLineageValidator } from '../../src/execution/validators/ack-lineage.js';
import { SessionManifestValidator } from '../../src/execution/validators/session-manifest.js';

const RUN_ID = makeRunId('run-qfa-612-paper-01a');
const SESSION_ID = makeSessionId('session-qfa-612-paper-01a');
const BASE_TS_NS = ns(1_800_000_000_000_000_000n);
const LOCAL_TS_VALUES = [
  ns(1_800_000_000_040_000_000n),
  ns(1_800_000_000_080_000_000n),
  ns(1_800_000_000_120_000_000n),
  ns(1_800_000_000_160_000_000n),
];

describe('BrokerAdapterRuntimeIntegration', () => {
  it('dispatches ORDER_INTENT into submission ACK lineage, dual timestamps, JSONL, and SLI observations', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new MockOrderPlantAdapter();
      const events: AnyJournalEventEnvelope[] = [];
      const registry = new LatencySliRegistry();
      const observer = new BoundedAckLatencyObserver({ registry });
      const runtime = runtimeFor(adapter, events, {
        ack_latency_observer: observer,
        capture_local_timestamp_ns: localTimestampSource(),
      });

      await runtime.start();
      const intent = orderIntent('intent-submission');
      const result = await runtime.handleOrderIntent(intent);
      await vi.advanceTimersByTimeAsync(0);

      expect(result.accepted).toBe(true);
      const brokerEvents = events.filter((event) => event.type.startsWith('ORDER_ACK'));
      expect(brokerEvents.map((event) => event.type)).toEqual([
        'ORDER_ACK_SUBMISSION',
        'ORDER_ACK_FILL',
      ]);
      expect(brokerEvents[0]).toMatchObject({
        type: 'ORDER_ACK_SUBMISSION',
        payload: {
          intent_id: intent.event_id,
          instrument_symbol: 'MNQM6',
        },
      });
      expect(typeof brokerEvents[0]?.ts_ns).toBe('bigint');
      expect(typeof brokerEvents[0]?.ts_ns_local).toBe('bigint');

      const lineage = new AckLineageValidator();
      expect(brokerEvents.flatMap((event) => lineage.runOnEvent(event))).toEqual([]);
      const roundTripped = journalEventFromJsonLine(journalEventToJsonLine(brokerEvents[0]!));
      expect(validateJournalEventEnvelope(roundTripped)).toMatchObject({ ok: true, issues: [] });
      expect(registry.histogramSnapshot('qfa_order_ack_submission_ms')?.count).toBe(1);
      expect(registry.histogramSnapshot('qfa_order_ack_fill_ms')?.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits partial and full fill ACKs with submission lineage', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new MockOrderPlantAdapter({
        fill_behavior: {
          kind: 'partial_fills',
          fills: [
            { quantity: 1, fill_kind: 'PARTIAL', latency_ms: 0 },
            { quantity: 2, fill_kind: 'FULL', latency_ms: 0 },
          ],
        },
      });
      const events: AnyJournalEventEnvelope[] = [];
      const runtime = runtimeFor(adapter, events);

      await runtime.start();
      await runtime.handleOrderIntent(orderIntent('intent-partial-full'));
      await vi.advanceTimersByTimeAsync(0);

      const submission = events.find((event) => event.type === 'ORDER_ACK_SUBMISSION')!
        .payload as JournalEventPayloadFor<'ORDER_ACK_SUBMISSION'>;
      const fills = events.filter((event) => event.type === 'ORDER_ACK_FILL');
      expect(
        fills.map((event) => (event.payload as JournalEventPayloadFor<'ORDER_ACK_FILL'>).fill_kind),
      ).toEqual(['PARTIAL', 'FULL']);
      expect(
        fills.every(
          (event) =>
            (event.payload as JournalEventPayloadFor<'ORDER_ACK_FILL'>).submission_ack_id ===
            submission.submission_ack_id,
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes cancel requests into ORDER_ACK_CANCEL', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new MockOrderPlantAdapter({
        fill_behavior: { kind: 'no_fill_cancel_required' },
      });
      const events: AnyJournalEventEnvelope[] = [];
      const runtime = runtimeFor(adapter, events);

      await runtime.start();
      const intent = orderIntent('intent-cancel');
      await runtime.handleOrderIntent(intent);
      await vi.advanceTimersByTimeAsync(0);
      const submission = events.find((event) => event.type === 'ORDER_ACK_SUBMISSION')!
        .payload as JournalEventPayloadFor<'ORDER_ACK_SUBMISSION'>;

      expect(await runtime.requestCancel({
        intent_id: intent.event_id,
        submission_ack_id: submission.submission_ack_id,
      })).toEqual({ accepted: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(events.find((event) => event.type === 'ORDER_ACK_CANCEL')).toMatchObject({
        payload: {
          intent_id: intent.event_id,
          submission_ack_id: submission.submission_ack_id,
          cancel_reason: 'CLIENT_REQUESTED',
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves broker reject subreason taxonomy', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new MockOrderPlantAdapter({
        fill_behavior: {
          kind: 'broker_reject',
          reject_reason_code: 'MOCK_AUTH_REJECT',
          reject_subreason: 'auth.invalid_credentials',
          reject_message_redacted: '[redacted]',
        },
      });
      const events: AnyJournalEventEnvelope[] = [];
      const runtime = runtimeFor(adapter, events);

      await runtime.start();
      await runtime.handleOrderIntent(orderIntent('intent-reject'));
      await vi.advanceTimersByTimeAsync(0);

      expect(events.find((event) => event.type === 'ORDER_BROKER_REJECT')).toMatchObject({
        payload: {
          reject_reason_code: 'MOCK_AUTH_REJECT',
          reject_subreason: 'auth.invalid_credentials',
          reject_message_redacted: '[redacted]',
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not submit when SubmissionGate blocks', async () => {
    const adapter = new MockOrderPlantAdapter();
    const gate = new SubmissionGate();
    gate.requestBlock('slo_halt');
    const events: AnyJournalEventEnvelope[] = [];
    const runtime = runtimeFor(adapter, events, { submission_gate: gate });

    await runtime.start();
    const result = await runtime.handleOrderIntent(orderIntent('intent-gated'));

    expect(result).toMatchObject({ accepted: false, reason: 'submission_gate_blocked' });
    expect(adapter.submitted_intent_count).toBe(0);
  });

  it('does not submit when QFA-622 capability mask denies paper submit', async () => {
    const adapter = new MockOrderPlantAdapter();
    const events: AnyJournalEventEnvelope[] = [];
    const runtime = runtimeFor(adapter, events, {
      execution_mask: denySubmitMask(),
    });

    await runtime.start();
    const result = await runtime.handleOrderIntent(orderIntent('intent-capability-deny'));

    expect(result).toMatchObject({ accepted: false, reason: 'capability_denied' });
    expect(adapter.submitted_intent_count).toBe(0);
  });

  it('emits a SESSION_MANIFEST event accepted by EXEC-VALIDATOR-06', async () => {
    const adapter = new MockOrderPlantAdapter({ seed: 'manifest-seed' });
    const events: AnyJournalEventEnvelope[] = [];
    const runtime = runtimeFor(adapter, events);

    await runtime.start();

    const manifest = events.find((event) => event.type === 'SESSION_MANIFEST');
    expect(manifest).toMatchObject({
      payload: {
        plant_scope: 'ORDER_PLANT',
        mode: 'paper',
        adapter_kind: 'MOCK_ORDER_PLANT',
        broker_session_id: 'mock-order-plant-session-manifest-seed',
      },
    });
    expect(validateJournalEventEnvelope(manifest)).toMatchObject({ ok: true, issues: [] });
    expect(
      new SessionManifestValidator().runOnSessionStart({
        session_manifest: manifest?.payload as unknown as Readonly<Record<string, unknown>>,
      }),
    ).toEqual([]);
  });

  it('quarantines pending ACK timeouts through QFA-628 state machine when enabled', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new SilentAcceptingAdapter();
      const gate = new SubmissionGate();
      const events: AnyJournalEventEnvelope[] = [];
      const runtime = runtimeFor(adapter, events, {
        submission_gate: gate,
        ack_timeout_policy: { enabled: true, submission_ack_timeout_ms: 5 },
      });

      await runtime.start();
      await runtime.handleOrderIntent(orderIntent('intent-timeout'));
      await vi.advanceTimersByTimeAsync(5);

      expect(events.find((event) => event.type === 'ORDER_QUARANTINE_ENTERED')).toMatchObject({
        payload: {
          quarantine_reason: 'submission_ack_timeout',
          open_quarantine_count: 1,
          timeout_ms: 5,
        },
      });
      expect(gate.acquire()).toMatchObject({
        allowed: false,
        reason: 'quarantine_active',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function runtimeFor(
  adapter: BrokerAdapter,
  events: AnyJournalEventEnvelope[],
  overrides: Partial<ConstructorParameters<typeof BrokerAdapterRuntimeIntegration>[0]> = {},
): BrokerAdapterRuntimeIntegration {
  return new BrokerAdapterRuntimeIntegration({
    adapter,
    run_id: RUN_ID,
    session_id: SESSION_ID,
    submission_gate: new SubmissionGate(),
    event_sink: (event) => events.push(event),
    capture_local_timestamp_ns: localTimestampSource(),
    ...overrides,
  });
}

function orderIntent(eventId: string): OrderIntentEventEnvelope {
  return createJournalEventEnvelope({
    event_id: makeEventId(eventId),
    type: 'ORDER_INTENT',
    ts_ns: BASE_TS_NS,
    run_id: RUN_ID,
    session_id: SESSION_ID,
    causation_id: makeCausationId('sizing-1'),
    payload: {
      order_intent_id: makeOrderIntentId(`order-${eventId}`),
      candidate_id: makeCandidateId('candidate-1'),
      sizing_decision_id: makeSizingDecisionId('sizing-1'),
      side: 'buy',
      order_type: 'limit',
      quantity: 3,
      limit_price: 19_750.25,
      time_in_force: 'day',
    },
  });
}

function localTimestampSource(): () => UnixNs {
  let index = 0;
  return () => LOCAL_TS_VALUES[index++] ?? ns(1_800_000_000_200_000_000n + BigInt(index) * 1_000_000n);
}

function denySubmitMask(): ExecutionCapabilityMask {
  const mask = buildExecutionCapabilityMask();
  return {
    ...mask,
    binding_table: {
      ...mask.binding_table,
      submit: {
        ...mask.binding_table.submit,
        paper: 'blocked',
      },
    },
  };
}

class SilentAcceptingAdapter implements BrokerAdapter {
  readonly plant_scope: PlantScope = 'ORDER_PLANT';
  readonly mode: RuntimeMode = 'paper';
  private readonly sessionHandlers = new Set<(event: BrokerSessionEvent) => void>();

  async start(): Promise<void> {
    const mask = buildExecutionCapabilityMask();
    this.sessionHandlers.forEach((handler) => handler({
      type: 'SESSION_MANIFEST',
      ts_ns: BASE_TS_NS,
      payload: {
        mask_id: mask.mask_id,
        mask_version: mask.mask_version,
        mask_hash: mask.mask_hash,
        reconnect_policy_config: DEFAULT_BROKER_RECONNECT_POLICY_CONFIG,
        plant_scope: 'ORDER_PLANT',
        mode: 'paper',
        timestamp_anchor: 'broker_exchange_ts_ns',
        broker_session_id: 'silent-session',
        adapter_kind: 'MOCK_ORDER_PLANT',
      },
    }));
  }

  async stop(): Promise<void> {}

  async submitIntent(
    _intent: OrderIntentEventEnvelope,
  ): Promise<{ readonly accepted: boolean; readonly broker_intent_correlation_id: string }> {
    return { accepted: true, broker_intent_correlation_id: 'silent-correlation' };
  }

  async requestCancel(_request: {
    readonly intent_id: EventId;
    readonly submission_ack_id: EventId;
  }): Promise<{ readonly accepted: boolean }> {
    return { accepted: false };
  }

  subscribeAckEvents(_handler: (event: BrokerAckEnvelope) => void): Unsubscribe {
    return () => undefined;
  }

  subscribeSessionEvents(handler: (event: BrokerSessionEvent) => void): Unsubscribe {
    this.sessionHandlers.add(handler);
    return () => {
      this.sessionHandlers.delete(handler);
    };
  }
}
