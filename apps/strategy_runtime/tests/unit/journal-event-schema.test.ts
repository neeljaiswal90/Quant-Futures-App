import { describe, expect, it } from 'vitest';
import {
  createJournalEventEnvelope,
  makeCausationId,
  makeEventId,
  makeRunId,
  makeSessionId,
  ns,
  validateJournalEventEnvelope,
  type JsonValue,
  type JournalEventEnvelope,
} from '../../src/contracts/index.js';

const TS_NS = 1_700_000_000_000_000_000n;

function quoteEvent(
  payloadOverrides: Record<string, JsonValue> = {},
): JournalEventEnvelope<'QUOTE'> {
  return createJournalEventEnvelope({
    event_id: makeEventId('quote-1'),
    type: 'QUOTE',
    ts_ns: ns(TS_NS),
    run_id: makeRunId('run-obs-01'),
    session_id: makeSessionId('2026-04-23-rth'),
    payload: {
      exchange_event_ts_ns: ns(TS_NS),
      sidecar_recv_ts_ns: ns(TS_NS + 1_000_000n),
      bid_px: 18500.25,
      bid_qty: 12,
      ask_px: 18500.5,
      ask_qty: 8,
      ...payloadOverrides,
    },
  });
}

function candidateEvent(
  payloadOverrides: Record<string, JsonValue> = {},
): JournalEventEnvelope<'CANDIDATE'> {
  return createJournalEventEnvelope({
    event_id: makeEventId('candidate-1'),
    type: 'CANDIDATE',
    ts_ns: ns(TS_NS),
    run_id: makeRunId('run-obs-01'),
    session_id: makeSessionId('2026-04-23-rth'),
    causation_id: makeCausationId('strat-eval-1'),
    payload: {
      candidate_id: 'candidate-1',
      strategy_id: 'trend_pullback_long',
      feature_snapshot_id: 'feature-1',
      direction: 'long',
      status: 'proposed',
      entry_price: 18501,
      stop_price: 18495,
      targets: [{ label: 'pt1', price: 18508, quantity_fraction: 0.5 }],
      confidence: 0.68,
      reasons: ['fixture'],
      ...payloadOverrides,
    },
  });
}

describe('OBS-01 journal event schema validation', () => {
  it('accepts a valid QUOTE event payload', () => {
    const result = validateJournalEventEnvelope(quoteEvent());

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('rejects QUOTE payloads missing exchange_event_ts_ns', () => {
    const event = quoteEvent();
    const payload = { ...(event.payload as unknown as Record<string, unknown>) };
    delete payload.exchange_event_ts_ns;

    const result = validateJournalEventEnvelope({ ...event, payload });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      path: '$.payload.exchange_event_ts_ns',
      code: 'missing_required_field',
      message: 'is required',
    });
  });

  it('accepts a valid CANDIDATE event with causation_id', () => {
    const result = validateJournalEventEnvelope(candidateEvent());

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('rejects CANDIDATE events missing required payload fields', () => {
    const event = candidateEvent();
    const payload = { ...(event.payload as unknown as Record<string, unknown>) };
    delete payload.candidate_id;
    delete payload.targets;

    const result = validateJournalEventEnvelope({ ...event, payload });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        {
          path: '$.payload.candidate_id',
          code: 'missing_required_field',
          message: 'is required',
        },
        {
          path: '$.payload.targets',
          code: 'missing_required_field',
          message: 'is required',
        },
      ]),
    );
  });

  it('rejects unsupported schema versions', () => {
    const result = validateJournalEventEnvelope({ ...quoteEvent(), schema_version: 2 });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      path: '$.schema_version',
      code: 'unsupported_schema_version',
      message: 'must be 1',
    });
  });

  it('rejects unknown event types', () => {
    const result = validateJournalEventEnvelope({ ...quoteEvent(), type: 'SHADOW_SCORE' });

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      path: '$.type',
      code: 'unsupported_event_type',
      message: 'unsupported runtime event type: SHADOW_SCORE',
    });
  });

  it('accepts explicitly exempt system/control events without causation_id', () => {
    const event = createJournalEventEnvelope({
      event_id: makeEventId('conn-1'),
      type: 'CONN',
      ts_ns: ns(TS_NS),
      run_id: makeRunId('run-obs-01'),
      session_id: makeSessionId('2026-04-23-rth'),
      payload: {
        state: 'connected',
      },
    });

    const result = validateJournalEventEnvelope(event);

    expect(result.ok).toBe(true);
  });

  it('accepts explicit RTH, ETH, maintenance, and closed SESSION_PHASE payloads', () => {
    const phases = ['rth', 'eth', 'maintenance', 'closed'] as const;

    for (const phase of phases) {
      const event = createJournalEventEnvelope({
        event_id: makeEventId(`session-phase-${phase}`),
        type: 'SESSION_PHASE',
        ts_ns: ns(TS_NS),
        run_id: makeRunId('run-obs-01'),
        session_id: makeSessionId(`2026-04-23-${phase}`),
        payload: {
          phase,
          trading_date: '2026-04-23',
          session_phase: phase,
        },
      });

      expect(validateJournalEventEnvelope(event)).toMatchObject({
        ok: true,
        issues: [],
      });
    }
  });

  it('accepts CONFIG events with numeric config_version', () => {
    const event = createJournalEventEnvelope({
      event_id: makeEventId('config-1'),
      type: 'CONFIG',
      ts_ns: ns(TS_NS),
      run_id: makeRunId('run-obs-01'),
      session_id: makeSessionId('2026-04-23-rth'),
      payload: {
        config_hash: 'a'.repeat(64),
        config_version: 1,
      },
    });

    const result = validateJournalEventEnvelope(event);

    expect(result.ok).toBe(true);
  });

  it('accepts EXEC_REJECT events with causation and simulated execution lineage', () => {
    const event = createJournalEventEnvelope({
      event_id: makeEventId('exec-reject-order-1'),
      type: 'EXEC_REJECT',
      ts_ns: ns(TS_NS),
      run_id: makeRunId('run-obs-01'),
      session_id: makeSessionId('2026-04-23-rth'),
      causation_id: makeCausationId('order-intent-1'),
      payload: {
        execution_reject_id: 'exec-reject-order-1',
        order_intent_id: 'order-1',
        candidate_id: 'candidate-1',
        sizing_decision_id: 'sizing-1',
        status: 'rejected',
        reason: 'sim_reject:no_liquidity',
        execution_adapter: 'simulated',
        execution_version: 'simulated_execution_v1',
      },
    });

    expect(validateJournalEventEnvelope(event)).toMatchObject({
      ok: true,
      issues: [],
    });
  });

  it('rejects payload field type mismatches', () => {
    const result = validateJournalEventEnvelope(quoteEvent({ bid_px: '18500.25' }));

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      path: '$.payload.bid_px',
      code: 'invalid_field_type',
      message: 'must be a finite number',
    });
  });
});
