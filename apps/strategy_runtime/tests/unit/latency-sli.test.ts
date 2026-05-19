import { get } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  BoundedAckLatencyObserver,
  LATENCY_HISTOGRAM_METRIC_NAMES,
  LatencySliRegistry,
  PRIMARY_LATENCY_HISTOGRAM_METRIC_NAMES,
  PROVISIONAL_LATENCY_BUCKET_MARKER,
  PROVISIONAL_LATENCY_HISTOGRAM_BUCKETS_MS,
  resolveLatencyMetricsEndpointConfig,
  startLatencyMetricsEndpoint,
} from '../../src/observability/latency-sli.js';
import { captureLocalTimestampNs } from '../../src/observability/local-timestamp.js';
import {
  createBrokerJournalEventEnvelope,
  createJournalEventEnvelope,
  makeCausationId,
  makeCandidateId,
  makeEventId,
  makeOrderIntentId,
  makeRunId,
  makeSessionId,
  makeSizingDecisionId,
  ns,
  type JournalEventEnvelope,
  type JournalEventPayloadFor,
} from '../../src/contracts/index.js';

const RUN_ID = makeRunId('run-latency-sli');
const SESSION_ID = makeSessionId('2026-05-19-rth');
const BASE_TS_NS = ns(1_800_000_000_000_000_000n);

describe('QFA-626 latency SLI instrumentation', () => {
  it('records configurable Prometheus histogram buckets', () => {
    const registry = new LatencySliRegistry({
      buckets_ms_by_metric: {
        qfa_strategy_decision_ms: [5, 10],
      },
    });

    registry.recordStrategyDecisionMs('regime_shock_reversion_short_v2', 7.5);
    const metrics = registry.exportPrometheusMetrics();

    expect(metrics).toContain(
      'qfa_strategy_decision_ms_bucket{strategy_id="regime_shock_reversion_short_v2",le="5"} 0',
    );
    expect(metrics).toContain(
      'qfa_strategy_decision_ms_bucket{strategy_id="regime_shock_reversion_short_v2",le="10"} 1',
    );
    expect(metrics).toContain(
      'qfa_strategy_decision_ms_bucket{strategy_id="regime_shock_reversion_short_v2",le="+Inf"} 1',
    );
    expect(metrics).toContain(
      'qfa_strategy_decision_ms_sum{strategy_id="regime_shock_reversion_short_v2"} 7.5',
    );
    expect(metrics).toContain(
      'qfa_strategy_decision_ms_count{strategy_id="regime_shock_reversion_short_v2"} 1',
    );
  });

  it('keeps provisional bucket coverage across primary latency histograms', () => {
    expect(PROVISIONAL_LATENCY_HISTOGRAM_BUCKETS_MS).toEqual([
      0.5,
      1,
      2.5,
      5,
      10,
      25,
      50,
      100,
      250,
      500,
      1_000,
      2_500,
      5_000,
    ]);
    expect(PROVISIONAL_LATENCY_HISTOGRAM_BUCKETS_MS).toContain(25);
    expect(PROVISIONAL_LATENCY_HISTOGRAM_BUCKETS_MS).toContain(1_000);
    expect(PRIMARY_LATENCY_HISTOGRAM_METRIC_NAMES).toEqual([
      'qfa_strategy_decision_ms',
      'qfa_event_loop_lag_ms',
      'qfa_snapshot_to_submit_ms',
      'qfa_order_ack_submission_ms',
      'qfa_order_ack_cancel_ms',
    ]);
  });

  it('captures monotonic local timestamps plausibly aligned to wall clock', () => {
    const beforeNs = BigInt(Date.now()) * 1_000_000n;
    const first = captureLocalTimestampNs();
    const second = captureLocalTimestampNs();
    const afterNs = BigInt(Date.now()) * 1_000_000n;

    expect(second >= first).toBe(true);
    expect(BigInt(first)).toBeGreaterThanOrEqual(beforeNs - 1_000_000_000n);
    expect(BigInt(first)).toBeLessThanOrEqual(afterNs + 1_000_000_000n);
  });

  it('matches ACK submission, cancel, and diagnostic fill latency by QFA-623 lineage', () => {
    const registry = new LatencySliRegistry();
    const observer = new BoundedAckLatencyObserver({ registry, max_cache_entries: 8 });
    const intentEvent = orderIntentEvent('order-intent-event-1', BASE_TS_NS);
    const submissionAck = submissionAckEvent({
      eventId: 'submission-ack-event-1',
      intentEventId: 'order-intent-event-1',
      submissionAckId: 'submission-ack-1',
      exchangeTsNs: addMs(BASE_TS_NS, 35),
      localTsNs: addMs(BASE_TS_NS, 40),
    });
    const fillAck = fillAckEvent({
      eventId: 'fill-ack-event-1',
      intentEventId: 'order-intent-event-1',
      submissionAckId: 'submission-ack-1',
      fillAckId: 'fill-ack-1',
      exchangeTsNs: addMs(BASE_TS_NS, 120),
      localTsNs: addMs(BASE_TS_NS, 130),
    });
    const cancelAck = cancelAckEvent({
      eventId: 'cancel-ack-event-1',
      intentEventId: 'order-intent-event-1',
      submissionAckId: 'submission-ack-1',
      cancelAckId: 'cancel-ack-1',
      exchangeTsNs: addMs(BASE_TS_NS, 150),
      localTsNs: addMs(BASE_TS_NS, 160),
    });

    observer.observe(intentEvent);
    observer.observe(submissionAck);
    observer.observe(fillAck);
    observer.observe(cancelAck);

    expect(registry.histogramSnapshot('qfa_order_ack_submission_ms')?.sum).toBe(40);
    expect(registry.histogramSnapshot('qfa_order_ack_submission_ms')?.count).toBe(1);
    expect(registry.histogramSnapshot('qfa_order_ack_fill_ms')?.sum).toBe(90);
    expect(registry.histogramSnapshot('qfa_order_ack_fill_ms')?.count).toBe(1);
    expect(registry.histogramSnapshot('qfa_order_ack_cancel_ms')?.sum).toBe(120);
    expect(registry.histogramSnapshot('qfa_order_ack_cancel_ms')?.count).toBe(1);
    expect(registry.ackIntentCacheMisses()).toBe(0);
    expect(registry.exportPrometheusMetrics()).not.toContain('sla=');
  });

  it('skips ACK observations on cache miss and increments the miss counter', () => {
    const registry = new LatencySliRegistry();
    const observer = new BoundedAckLatencyObserver({ registry, max_cache_entries: 1 });

    observer.observe(orderIntentEvent('order-intent-event-old', BASE_TS_NS));
    observer.observe(orderIntentEvent('order-intent-event-new', addMs(BASE_TS_NS, 1)));
    observer.observe(submissionAckEvent({
      eventId: 'submission-ack-missed',
      intentEventId: 'order-intent-event-old',
      submissionAckId: 'submission-ack-missed',
      exchangeTsNs: addMs(BASE_TS_NS, 10),
      localTsNs: addMs(BASE_TS_NS, 11),
    }));
    observer.observe(cancelAckEvent({
      eventId: 'cancel-ack-missed',
      intentEventId: 'order-intent-event-old',
      submissionAckId: 'missing-submission-ack',
      cancelAckId: 'cancel-ack-missed',
      exchangeTsNs: addMs(BASE_TS_NS, 20),
      localTsNs: addMs(BASE_TS_NS, 21),
    }));

    expect(registry.ackIntentCacheMisses()).toBe(2);
    expect(registry.histogramSnapshot('qfa_order_ack_submission_ms')?.count).toBe(0);
    expect(registry.histogramSnapshot('qfa_order_ack_cancel_ms')?.count).toBe(0);
    expect(registry.exportPrometheusMetrics()).toContain('qfa_ack_intent_cache_miss_total 2');
  });

  it('keeps /metrics disabled by default and enables it only by env or explicit config', async () => {
    const registry = new LatencySliRegistry();
    registry.recordOrderAckSubmissionMs(12);

    expect(resolveLatencyMetricsEndpointConfig({ env: {} })).toEqual({
      enabled: false,
      host: '127.0.0.1',
      port: 9_469,
    });
    expect(startLatencyMetricsEndpoint({ env: {}, registry })).toBeUndefined();
    expect(resolveLatencyMetricsEndpointConfig({
      env: { QFA_METRICS_ENABLED: 'true', QFA_METRICS_PORT: '0' },
    })).toEqual({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
    });

    const endpoint = startLatencyMetricsEndpoint({
      env: {},
      config: { enabled: true, port: 0 },
      registry,
    });
    expect(endpoint).toBeDefined();
    const address = await endpoint!.ready;
    try {
      const body = await httpGet(address.url);
      expect(address.host).toBe('127.0.0.1');
      expect(body).toContain('qfa_order_ack_submission_ms_count 1');
      expect(body).toContain('qfa_ack_intent_cache_miss_total 0');
    } finally {
      await endpoint!.close();
    }
  });

  it('marks all latency histogram descriptions as provisional', () => {
    const metrics = new LatencySliRegistry().exportPrometheusMetrics();

    for (const metricName of LATENCY_HISTOGRAM_METRIC_NAMES) {
      expect(metrics).toContain(`# HELP ${metricName}`);
    }
    const markerCount = metrics.split(PROVISIONAL_LATENCY_BUCKET_MARKER).length - 1;
    expect(markerCount).toBe(LATENCY_HISTOGRAM_METRIC_NAMES.length);
  });
});

function orderIntentEvent(
  eventId: string,
  tsNs: ReturnType<typeof ns>,
): JournalEventEnvelope<'ORDER_INTENT', JournalEventPayloadFor<'ORDER_INTENT'>> {
  return createJournalEventEnvelope({
    event_id: makeEventId(eventId),
    type: 'ORDER_INTENT',
    ts_ns: tsNs,
    run_id: RUN_ID,
    session_id: SESSION_ID,
    causation_id: makeCausationId('risk-gate-1'),
    payload: {
      order_intent_id: makeOrderIntentId('order-intent-1'),
      candidate_id: makeCandidateId('candidate-1'),
      sizing_decision_id: makeSizingDecisionId('sizing-1'),
      side: 'buy',
      order_type: 'market',
      quantity: 1,
      time_in_force: 'day',
    },
  });
}

function submissionAckEvent(input: {
  readonly eventId: string;
  readonly intentEventId: string;
  readonly submissionAckId: string;
  readonly exchangeTsNs: ReturnType<typeof ns>;
  readonly localTsNs: ReturnType<typeof ns>;
}) {
  return createBrokerJournalEventEnvelope({
    event_id: makeEventId(input.eventId),
    type: 'ORDER_ACK_SUBMISSION',
    ts_ns: input.exchangeTsNs,
    ts_ns_local: input.localTsNs,
    run_id: RUN_ID,
    session_id: SESSION_ID,
    payload: {
      intent_id: makeEventId(input.intentEventId),
      submission_ack_id: makeEventId(input.submissionAckId),
      broker_order_id: 'broker-order-1',
      broker_account_id: 'paper-account-1',
      instrument_symbol: 'MNQM6',
    } satisfies JournalEventPayloadFor<'ORDER_ACK_SUBMISSION'>,
  });
}

function fillAckEvent(input: {
  readonly eventId: string;
  readonly intentEventId: string;
  readonly submissionAckId: string;
  readonly fillAckId: string;
  readonly exchangeTsNs: ReturnType<typeof ns>;
  readonly localTsNs: ReturnType<typeof ns>;
}) {
  return createBrokerJournalEventEnvelope({
    event_id: makeEventId(input.eventId),
    type: 'ORDER_ACK_FILL',
    ts_ns: input.exchangeTsNs,
    ts_ns_local: input.localTsNs,
    run_id: RUN_ID,
    session_id: SESSION_ID,
    payload: {
      intent_id: makeEventId(input.intentEventId),
      submission_ack_id: makeEventId(input.submissionAckId),
      fill_ack_id: makeEventId(input.fillAckId),
      broker_order_id: 'broker-order-1',
      broker_account_id: 'paper-account-1',
      instrument_symbol: 'MNQM6',
      fill_qty: 1,
      fill_price: 18500.25,
      fill_kind: 'PARTIAL',
    } satisfies JournalEventPayloadFor<'ORDER_ACK_FILL'>,
  });
}

function cancelAckEvent(input: {
  readonly eventId: string;
  readonly intentEventId: string;
  readonly submissionAckId: string;
  readonly cancelAckId: string;
  readonly exchangeTsNs: ReturnType<typeof ns>;
  readonly localTsNs: ReturnType<typeof ns>;
}) {
  return createBrokerJournalEventEnvelope({
    event_id: makeEventId(input.eventId),
    type: 'ORDER_ACK_CANCEL',
    ts_ns: input.exchangeTsNs,
    ts_ns_local: input.localTsNs,
    run_id: RUN_ID,
    session_id: SESSION_ID,
    payload: {
      intent_id: makeEventId(input.intentEventId),
      submission_ack_id: makeEventId(input.submissionAckId),
      cancel_ack_id: makeEventId(input.cancelAckId),
      broker_order_id: 'broker-order-1',
      broker_account_id: 'paper-account-1',
      cancel_reason: 'CLIENT_REQUESTED',
    } satisfies JournalEventPayloadFor<'ORDER_ACK_CANCEL'>,
  });
}

function addMs(value: ReturnType<typeof ns>, ms: number): ReturnType<typeof ns> {
  return ns(BigInt(value) + BigInt(ms) * 1_000_000n);
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve(body);
      });
    }).on('error', reject);
  });
}
