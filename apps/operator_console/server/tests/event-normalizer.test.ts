import { describe, expect, it } from 'vitest';
import type {
  JournalEventEnvelope,
  RuntimeEventType,
} from '../../../strategy_runtime/src/contracts/events/index.js';
import { emptyCheckpoint } from '../src/ingest/checkpoint.js';
import {
  normalizeJournalTailResult,
  type NormalizedJournalEvent,
} from '../src/ingest/event-normalizer.js';
import type {
  IngestedJournalEvent,
  JournalTailResult,
  QuarantinedJournalLine,
} from '../src/ingest/journal-tail.js';

function envelope(
  type: RuntimeEventType,
  payload: Record<string, unknown>,
  eventId = `${type.toLowerCase()}-1`,
): JournalEventEnvelope {
  return {
    schema_version: 1,
    event_id: eventId,
    type,
    ts_ns: 1_700_000_000_000_000_000n,
    run_id: 'run-1',
    session_id: 'session-1',
    payload,
  } as unknown as JournalEventEnvelope;
}

function ingested(
  event: JournalEventEnvelope,
  lineNumber = 1,
): IngestedJournalEvent {
  return {
    event,
    source_file: 'journal.jsonl',
    byte_offset_start: lineNumber * 100,
    byte_offset_end: (lineNumber * 100) + 99,
    line_number: lineNumber,
  };
}

function quarantined(
  errorMessage: string,
  lineNumber: number,
): QuarantinedJournalLine {
  return {
    schema_version: 1,
    source_file: 'journal.jsonl',
    byte_offset_start: lineNumber * 100,
    byte_offset_end: (lineNumber * 100) + 99,
    line_number: lineNumber,
    error_message: errorMessage,
    raw_line: lineNumber === 1 ? '{bad json' : '{"schema_version":1}',
  };
}

function tailResult(
  events: readonly IngestedJournalEvent[],
  malformedLines: readonly QuarantinedJournalLine[] = [],
): JournalTailResult {
  return {
    events,
    malformed_lines: malformedLines,
    checkpoint: emptyCheckpoint(),
  };
}

describe('operator console event normalizer', () => {
  it('turns malformed JSONL and invalid schema rows into alerts and excludes them from state events', () => {
    const result = normalizeJournalTailResult(tailResult([], [
      quarantined('Unexpected token b in JSON at position 1', 1),
      quarantined('journal event schema validation failed: $.payload.strategy_id is required', 2),
    ]));

    expect(result.events).toEqual([]);
    expect(result.malformed_or_schema_invalid_count).toBe(2);
    expect(result.alerts).toHaveLength(2);
    expect(result.alerts.map((alert) => alert.kind)).toEqual([
      'malformed_or_schema_invalid_row',
      'malformed_or_schema_invalid_row',
    ]);
    expect(result.alerts[0]?.details?.classification).toBe('malformed_json');
    expect(result.alerts[1]?.details?.classification).toBe('schema_invalid');
    expect(result.alerts[0]?.line_number).toBe(1);
    expect(result.alerts[1]?.byte_offset_start).toBe(200);
  });

  it('counts blocked MBO feature decision-use and excludes the event from decision-grade state', () => {
    const result = normalizeJournalTailResult(
      tailResult([
        ingested(envelope('RANK', {
          ranked_candidate_ids: ['candidate-1'],
          method: 'test',
          feature_use: {
            feature_name: 'queue_position',
            use_context: 'rank',
          },
        })),
      ]),
      { check_missing_terminal_order_intents: false },
    );

    expect(result.events).toHaveLength(1);
    expect((result.events[0] as NormalizedJournalEvent | undefined)?.decision_grade).toBe(false);
    expect(result.feature_policy_violation_count).toBe(1);
    expect(result.blocked_feature_policy_violation_count).toBe(1);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]?.kind).toBe('feature_policy_violation');
    expect(result.alerts[0]?.severity).toBe('critical');
    expect(result.alerts[0]?.details?.tier).toBe('blocked');
  });

  it('flags missing terminal execution facts for an order intent batch', () => {
    const result = normalizeJournalTailResult(tailResult([
      ingested(envelope('ORDER_INTENT', {
        order_intent_id: 'intent-1',
        candidate_id: 'candidate-1',
        sizing_decision_id: 'sizing-1',
        side: 'buy',
        order_type: 'market',
        quantity: 1,
      })),
    ]));

    expect(result.missing_terminal_order_intent_count).toBe(1);
    expect(result.alerts).toContainEqual(expect.objectContaining({
      kind: 'missing_terminal_order_intent',
      event_id: 'order_intent-1',
      details: { order_intent_id: 'intent-1' },
    }));
  });

  it('does not flag order intents that have SIM_FILL or EXEC_REJECT terminal events in the batch', () => {
    const result = normalizeJournalTailResult(tailResult([
      ingested(envelope('ORDER_INTENT', {
        order_intent_id: 'intent-1',
        candidate_id: 'candidate-1',
        sizing_decision_id: 'sizing-1',
        side: 'buy',
        order_type: 'market',
        quantity: 1,
      }), 1),
      ingested(envelope('EXEC_REJECT', {
        execution_reject_id: 'reject-1',
        order_intent_id: 'intent-1',
        candidate_id: 'candidate-1',
        sizing_decision_id: 'sizing-1',
        status: 'rejected',
        reason: 'test',
        execution_adapter: 'simulated',
      }), 2),
    ]));

    expect(result.missing_terminal_order_intent_count).toBe(0);
    expect(result.alerts.filter((alert) => alert.kind === 'missing_terminal_order_intent')).toEqual([]);
  });
});
