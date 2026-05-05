// Module under test: contracts/events/* registry integration of BACKTEST_RUN_META.
// Ticket: QFA-115 Session 2b.
import { describe, expect, it } from 'vitest';
import type { BacktestRunMetaPayload } from '../../../../src/contracts/backtest-run-meta.js';
import {
  channelsForEventType,
  DERIVED_EVENT_TYPES,
  RUNTIME_EVENT_TYPES,
  SOURCE_MARKET_DATA_EVENT_TYPES,
  SYSTEM_CONTROL_EVENT_TYPES,
  validateJournalEventEnvelope,
  type AnyJournalEventEnvelope,
} from '../../../../src/contracts/events/index.js';
import { computeRunSpecHash } from '../../../../src/contracts/run-spec-hash.js';
import { ns } from '../../../../src/contracts/time.js';
import { formatJournalEvent } from '../../../../src/operator/formatter.js';
import { buildMinimalRunSpec } from '../helpers/run-spec-builder.js';

function buildValidEnvelope(): AnyJournalEventEnvelope {
  const spec = buildMinimalRunSpec();
  const hash = computeRunSpecHash(spec);
  const payload: BacktestRunMetaPayload = {
    ...spec,
    run_spec_hash: hash,
    run_started_at_ns: ns(1_801_000_000_000_000_000n),
  };
  return {
    schema_version: 1,
    event_id: 'evt-bt-0' as AnyJournalEventEnvelope['event_id'],
    type: 'BACKTEST_RUN_META',
    ts_ns: ns(1_801_000_000_000_000_000n),
    run_id: `bt-mnq-1m-s20260202-20260206-tp_long-${hash.slice(0, 12)}` as AnyJournalEventEnvelope['run_id'],
    session_id: 'sess-bt-0' as AnyJournalEventEnvelope['session_id'],
    payload,
  };
}

describe('QFA-115 Session 2b — BACKTEST_RUN_META event registry membership', () => {
  it('is registered in RUNTIME_EVENT_TYPES', () => {
    expect(RUNTIME_EVENT_TYPES).toContain('BACKTEST_RUN_META');
  });

  it('is registered in SYSTEM_CONTROL_EVENT_TYPES', () => {
    expect(SYSTEM_CONTROL_EVENT_TYPES).toContain('BACKTEST_RUN_META');
  });

  it('is NOT in DERIVED_EVENT_TYPES (no causation_id requirement)', () => {
    expect(DERIVED_EVENT_TYPES).not.toContain('BACKTEST_RUN_META');
  });

  it('is NOT in SOURCE_MARKET_DATA_EVENT_TYPES', () => {
    expect(SOURCE_MARKET_DATA_EVENT_TYPES).not.toContain('BACKTEST_RUN_META');
  });

  it('is mapped to the CONFIG channel', () => {
    expect(channelsForEventType('BACKTEST_RUN_META')).toContain('CONFIG');
  });
});

describe('QFA-115 Session 2b — BACKTEST_RUN_META schema validation', () => {
  it('accepts a well-formed envelope built from run-spec-builder', () => {
    const envelope = buildValidEnvelope();
    const result = validateJournalEventEnvelope(envelope);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('rejects a payload that duplicates envelope event_id', () => {
    const envelope = buildValidEnvelope();
    const tamperedPayload = {
      ...envelope.payload,
      event_id: 'duplicated',
    };
    const tampered = { ...envelope, payload: tamperedPayload };
    const result = validateJournalEventEnvelope(tampered);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.path.endsWith('event_id'))).toBe(true);
  });

  it('rejects a payload that duplicates envelope run_id', () => {
    const envelope = buildValidEnvelope();
    const tamperedPayload = {
      ...envelope.payload,
      run_id: 'duplicated',
    };
    const tampered = { ...envelope, payload: tamperedPayload };
    const result = validateJournalEventEnvelope(tampered);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.path.endsWith('run_id'))).toBe(true);
  });

  it('rejects a payload that duplicates envelope ts_ns / session_id / type / schema_version', () => {
    for (const envelopeField of ['ts_ns', 'session_id', 'type', 'schema_version'] as const) {
      const envelope = buildValidEnvelope();
      const tamperedPayload = {
        ...envelope.payload,
        [envelopeField]: 'duplicated',
      };
      const tampered = { ...envelope, payload: tamperedPayload };
      const result = validateJournalEventEnvelope(tampered);
      expect(result.ok).toBe(false);
      expect(
        result.issues.some((issue) => issue.path.endsWith(envelopeField)),
      ).toBe(true);
    }
  });

  it('rejects a payload missing run_spec_hash', () => {
    const envelope = buildValidEnvelope();
    const { run_spec_hash: _drop, ...rest } = envelope.payload as BacktestRunMetaPayload;
    const tampered = { ...envelope, payload: rest };
    const result = validateJournalEventEnvelope(tampered);
    expect(result.ok).toBe(false);
    expect(
      result.issues.some((issue) => issue.path.endsWith('run_spec_hash')),
    ).toBe(true);
  });

  it('rejects a payload with run_spec_schema_version other than 1', () => {
    const envelope = buildValidEnvelope();
    const tamperedPayload = {
      ...envelope.payload,
      run_spec_schema_version: 2,
    };
    const tampered = { ...envelope, payload: tamperedPayload };
    const result = validateJournalEventEnvelope(tampered);
    expect(result.ok).toBe(false);
    expect(
      result.issues.some((issue) => issue.path.endsWith('run_spec_schema_version')),
    ).toBe(true);
  });

  it('rejects a payload with non-bigint run_started_at_ns', () => {
    const envelope = buildValidEnvelope();
    const tamperedPayload = {
      ...envelope.payload,
      run_started_at_ns: 12345,
    };
    const tampered = { ...envelope, payload: tamperedPayload };
    const result = validateJournalEventEnvelope(tampered);
    expect(result.ok).toBe(false);
    expect(
      result.issues.some((issue) => issue.path.endsWith('run_started_at_ns')),
    ).toBe(true);
  });
});

describe('QFA-115 Session 2b — BACKTEST_RUN_META formatter case', () => {
  it('renders BACKTEST_RUN_META with envelope run_id (not empty placeholder)', () => {
    const envelope = buildValidEnvelope();
    const formatted = formatJournalEvent(envelope);
    expect(formatted).toContain(`run_id=${envelope.run_id}`);
    expect(formatted).not.toContain('run_id=--');
  });

  it('renders run_spec_hash and run_spec_schema_version from payload', () => {
    const envelope = buildValidEnvelope();
    const payload = envelope.payload as BacktestRunMetaPayload;
    const formatted = formatJournalEvent(envelope);
    expect(formatted).toContain(`run_spec_hash=${payload.run_spec_hash}`);
    expect(formatted).toContain(
      `run_spec_schema_version=${String(payload.run_spec_schema_version)}`,
    );
  });
});
