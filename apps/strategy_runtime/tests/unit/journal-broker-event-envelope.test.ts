import { describe, expect, it } from 'vitest';
import {
  BROKER_ORIGINATED_EVENT_TYPES,
  JOURNAL_EVENT_SCHEMA_VERSION,
  createBrokerJournalEventEnvelope,
  createJournalEventEnvelope,
  isBrokerOriginatedEventType,
  journalEventFromJsonLine,
  journalEventToJsonLine,
  makeCausationId,
  makeEventId,
  makeRunId,
  makeSessionId,
  ns,
  validateJournalEventEnvelope,
  type BrokerOriginatedEventType,
  type JournalEventPayloadFor,
  type JsonValue,
  type RuntimeEventType,
} from '../../src/contracts/index.js';

const TS_NS = 1_800_000_000_000_000_000n;
const LOCAL_TS_NS = TS_NS + 2_500_000n;

function baseBrokerInput<TType extends BrokerOriginatedEventType>(
  type: TType,
  payload: JournalEventPayloadFor<TType>,
) {
  return {
    event_id: makeEventId(`${type.toLowerCase()}-evt-1`),
    type,
    ts_ns: ns(TS_NS),
    ts_ns_local: ns(LOCAL_TS_NS),
    run_id: makeRunId('run-broker-01'),
    session_id: makeSessionId('2026-05-19-rth'),
    payload,
  };
}

function submissionPayload(): JournalEventPayloadFor<'ORDER_ACK_SUBMISSION'> {
  return {
    intent_id: makeEventId('order-intent-1'),
    submission_ack_id: makeEventId('submission-ack-1'),
    broker_order_id: 'broker-order-1',
    broker_account_id: 'paper-account-1',
    instrument_symbol: 'MNQM6',
  };
}

function fillPayload(): JournalEventPayloadFor<'ORDER_ACK_FILL'> {
  return {
    intent_id: makeEventId('order-intent-1'),
    submission_ack_id: makeEventId('submission-ack-1'),
    fill_ack_id: makeEventId('fill-ack-1'),
    broker_order_id: 'broker-order-1',
    broker_account_id: 'paper-account-1',
    instrument_symbol: 'MNQM6',
    fill_qty: 1,
    fill_price: 18501.25,
    fill_kind: 'PARTIAL',
  };
}

function cancelPayload(): JournalEventPayloadFor<'ORDER_ACK_CANCEL'> {
  return {
    intent_id: makeEventId('order-intent-1'),
    submission_ack_id: makeEventId('submission-ack-1'),
    cancel_ack_id: makeEventId('cancel-ack-1'),
    broker_order_id: 'broker-order-1',
    broker_account_id: 'paper-account-1',
    cancel_reason: 'CLIENT_REQUESTED',
  };
}

function rejectPayload(): JournalEventPayloadFor<'ORDER_BROKER_REJECT'> {
  return {
    intent_id: makeEventId('order-intent-1'),
    broker_account_id: 'paper-account-1',
    reject_reason_code: 'INSUFFICIENT_MARGIN',
    reject_subreason: 'paper_margin_check',
    reject_message_redacted: '[REDACTED]',
  };
}

const BROKER_PAYLOAD_BY_TYPE = {
  ORDER_ACK_SUBMISSION: submissionPayload,
  ORDER_ACK_FILL: fillPayload,
  ORDER_ACK_CANCEL: cancelPayload,
  ORDER_BROKER_REJECT: rejectPayload,
} as const;

describe('QFA-623 broker journal event envelope', () => {
  it('bumps the journal schema version to 2', () => {
    expect(JOURNAL_EVENT_SCHEMA_VERSION).toBe(2);
  });

  it('classifies broker-originated event types separately from existing journal categories', () => {
    for (const type of BROKER_ORIGINATED_EVENT_TYPES) {
      expect(isBrokerOriginatedEventType(type)).toBe(true);
    }

    for (const type of ['ORDER_INTENT', 'SIM_FILL', 'EXEC_REJECT', 'QUOTE', 'CONN'] as const) {
      expect(isBrokerOriginatedEventType(type)).toBe(false);
    }
  });

  it('constructs broker envelopes with required local ingestion timestamps', () => {
    const event = createBrokerJournalEventEnvelope(
      baseBrokerInput('ORDER_ACK_SUBMISSION', submissionPayload()),
    );

    expect(event.ts_ns).toBe(ns(TS_NS));
    expect(event.ts_ns_local).toBe(ns(LOCAL_TS_NS));
    expect(validateJournalEventEnvelope(event)).toMatchObject({ ok: true, issues: [] });
  });

  it('rejects broker events missing ts_ns_local at schema-validation time', () => {
    const event = createJournalEventEnvelope({
      event_id: makeEventId('broker-no-local-1'),
      type: 'ORDER_ACK_SUBMISSION',
      ts_ns: ns(TS_NS),
      run_id: makeRunId('run-broker-01'),
      session_id: makeSessionId('2026-05-19-rth'),
      payload: submissionPayload(),
    });

    const result = validateJournalEventEnvelope(event);

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      path: '$.ts_ns_local',
      code: 'missing_required_field',
      message: 'is required',
    });
  });

  it('round-trips broker timestamps and ACK lineage through JSONL transport encoding', () => {
    const event = createBrokerJournalEventEnvelope(baseBrokerInput('ORDER_ACK_FILL', fillPayload()));
    const roundTripped = journalEventFromJsonLine(journalEventToJsonLine(event));

    expect(roundTripped.ts_ns).toBe(event.ts_ns);
    expect(roundTripped.ts_ns_local).toBe(event.ts_ns_local);
    expect(roundTripped.payload).toMatchObject({
      intent_id: 'order-intent-1',
      submission_ack_id: 'submission-ack-1',
      fill_ack_id: 'fill-ack-1',
    });
    expect(validateJournalEventEnvelope(roundTripped)).toMatchObject({ ok: true, issues: [] });
  });

  it('keeps existing non-broker envelopes valid without ts_ns_local', () => {
    const event = createJournalEventEnvelope({
      event_id: makeEventId('candidate-v1-shape-1'),
      type: 'CANDIDATE',
      ts_ns: ns(TS_NS),
      run_id: makeRunId('run-broker-01'),
      session_id: makeSessionId('2026-05-19-rth'),
      causation_id: makeCausationId('strat-eval-1'),
      payload: {
        candidate_id: 'candidate-1',
        strategy_id: 'regime_shock_reversion_short_v2',
        feature_snapshot_id: 'feature-1',
        direction: 'short',
        status: 'proposed',
        entry_price: 18500,
        stop_price: 18503,
        targets: [{ label: 'pt1', price: 18496, quantity_fraction: 0.5 }],
        confidence: 0.72,
        reasons: ['fixture'],
      } satisfies JsonValue,
    });

    const roundTripped = journalEventFromJsonLine(journalEventToJsonLine(event));

    expect(roundTripped.ts_ns_local).toBeUndefined();
    expect(validateJournalEventEnvelope(roundTripped)).toMatchObject({ ok: true, issues: [] });
  });

  it('accepts historical schema-v1 non-broker envelopes without ts_ns_local', () => {
    const event = createJournalEventEnvelope({
      event_id: makeEventId('quote-schema-v1-1'),
      type: 'QUOTE',
      ts_ns: ns(TS_NS),
      run_id: makeRunId('run-broker-01'),
      session_id: makeSessionId('2026-05-19-rth'),
      payload: {
        exchange_event_ts_ns: ns(TS_NS),
        sidecar_recv_ts_ns: ns(LOCAL_TS_NS),
        bid_px: 18500,
        bid_qty: 1,
        ask_px: 18500.25,
        ask_qty: 2,
      } satisfies JsonValue,
    });

    const historical = { ...event, schema_version: 1 };

    expect(validateJournalEventEnvelope(historical)).toMatchObject({ ok: true, issues: [] });
  });

  it('rejects broker payloads missing required lineage IDs', () => {
    for (const type of BROKER_ORIGINATED_EVENT_TYPES) {
      const payload = { ...BROKER_PAYLOAD_BY_TYPE[type]() } as Record<string, unknown>;
      delete payload.intent_id;
      if ('submission_ack_id' in payload) {
        delete payload.submission_ack_id;
      }
      if ('fill_ack_id' in payload) {
        delete payload.fill_ack_id;
      }
      if ('cancel_ack_id' in payload) {
        delete payload.cancel_ack_id;
      }

      const event = createBrokerJournalEventEnvelope(
        baseBrokerInput(type, payload as unknown as JournalEventPayloadFor<typeof type>),
      );
      const result = validateJournalEventEnvelope(event);

      expect(result.ok).toBe(false);
      expect(result.issues).toEqual(
        expect.arrayContaining([
          {
            path: '$.payload.intent_id',
            code: 'missing_required_field',
            message: 'is required',
          },
        ]),
      );
    }
  });

  it('parses every broker payload shape through the typed broker constructor', () => {
    for (const type of BROKER_ORIGINATED_EVENT_TYPES) {
      const payload = BROKER_PAYLOAD_BY_TYPE[type]();
      const event = createBrokerJournalEventEnvelope(
        baseBrokerInput(type, payload as JournalEventPayloadFor<RuntimeEventType & typeof type>),
      );

      expect(validateJournalEventEnvelope(event)).toMatchObject({ ok: true, issues: [] });
    }
  });
});
