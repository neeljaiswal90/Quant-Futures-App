import { describe, expect, it, vi } from 'vitest';
import {
  createJournalEventEnvelope,
  makeCausationId,
  makeCandidateId,
  makeEventId,
  makeOrderIntentId,
  makeRunId,
  makeSessionId,
  makeSizingDecisionId,
  ns,
  type JournalEventPayloadFor,
} from '../../src/contracts/index.js';
import type { BrokerAckEnvelope } from '../../src/execution/brokers/broker-adapter.js';
import type { OrderIntentEventEnvelope } from '../../src/execution/brokers/broker-adapter.js';
import { MockOrderPlantAdapter } from '../../src/execution/brokers/mock-order-plant-adapter.js';

const RUN_ID = makeRunId('run-qfa-612-paper-01a');
const SESSION_ID = makeSessionId('session-qfa-612-paper-01a');
const BASE_TS_NS = ns(1_800_000_000_000_000_000n);

describe('MockOrderPlantAdapter', () => {
  it('uses seeded deterministic IDs and ACK payloads', async () => {
    vi.useFakeTimers();
    try {
      const left = new MockOrderPlantAdapter({ seed: 'same-seed' });
      const right = new MockOrderPlantAdapter({ seed: 'same-seed' });
      const leftEvents: BrokerAckEnvelope[] = [];
      const rightEvents: BrokerAckEnvelope[] = [];
      left.subscribeAckEvents((event) => leftEvents.push(event));
      right.subscribeAckEvents((event) => rightEvents.push(event));

      await left.start();
      await right.start();
      await left.submitIntent(orderIntent('intent-seeded'));
      await right.submitIntent(orderIntent('intent-seeded'));
      await vi.advanceTimersByTimeAsync(0);

      expect(leftEvents).toEqual(rightEvents);
      expect(leftEvents.map((event) => event.type)).toEqual([
        'ORDER_ACK_SUBMISSION',
        'ORDER_ACK_FILL',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors configurable ACK latencies', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new MockOrderPlantAdapter({
        ack_latencies: { submission_ack_ms: 10, fill_ack_ms: 25 },
      });
      const events: BrokerAckEnvelope[] = [];
      adapter.subscribeAckEvents((event) => events.push(event));

      await adapter.start();
      await adapter.submitIntent(orderIntent('intent-latency'));
      await vi.advanceTimersByTimeAsync(9);
      expect(events).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(events.map((event) => event.type)).toEqual(['ORDER_ACK_SUBMISSION']);

      await vi.advanceTimersByTimeAsync(15);
      expect(events.map((event) => event.type)).toEqual([
        'ORDER_ACK_SUBMISSION',
        'ORDER_ACK_FILL',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('schedules partial fills in configured order', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new MockOrderPlantAdapter({
        fill_behavior: {
          kind: 'partial_fills',
          fills: [
            { quantity: 1, price: 19_750.25, latency_ms: 0, fill_kind: 'PARTIAL' },
            { quantity: 2, price: 19_750.5, latency_ms: 5, fill_kind: 'FULL' },
          ],
        },
      });
      const events: BrokerAckEnvelope[] = [];
      adapter.subscribeAckEvents((event) => events.push(event));

      await adapter.start();
      await adapter.submitIntent(orderIntent('intent-partial'));
      await vi.advanceTimersByTimeAsync(0);
      expect(events.map((event) => event.type)).toEqual([
        'ORDER_ACK_SUBMISSION',
        'ORDER_ACK_FILL',
      ]);
      expect((events[1]?.payload as JournalEventPayloadFor<'ORDER_ACK_FILL'>).fill_kind).toBe(
        'PARTIAL',
      );

      await vi.advanceTimersByTimeAsync(5);
      expect((events[2]?.payload as JournalEventPayloadFor<'ORDER_ACK_FILL'>).fill_kind).toBe(
        'FULL',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

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
    } satisfies JournalEventPayloadFor<'ORDER_INTENT'>,
  });
}
