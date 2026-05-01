import { describe, expect, it } from 'vitest';
import { assertJsonSafe, stableJsonStringify } from '../src/transport/json-safe.js';
import { assertDecimalSequence, nextSequence, type ConsoleStreamFrame } from '../src/types/delta.js';
import { CONSOLE_SNAPSHOT_SCHEMA_VERSION, type ConsoleSnapshot } from '../src/types/snapshot.js';

function minimalSnapshot(): ConsoleSnapshot {
  return {
    schema_version: CONSOLE_SNAPSHOT_SCHEMA_VERSION,
    run_id: 'run-1',
    session_id: 'session-1',
    generated_from: {
      journal_path: 'journal.jsonl',
      journal_path_redacted: false,
      last_event_id: null,
      last_event_ts_ns: null,
      event_count: 0,
    },
    data_pipeline: {
      source_event_count: 0,
      by_type: {},
      last_event_age_ms: { status: 'unavailable', reason: 'no events yet' },
      malformed_or_schema_invalid_count: 0,
    },
    strategies: [],
    trades: { rows: [] },
    positions: [],
    pnl: {
      realized_pnl_usd: { status: 'unavailable', reason: 'no explicit lifecycle fact' },
      unrealized_pnl_usd: { status: 'unavailable', reason: 'no quote mark' },
      source: 'unavailable',
    },
    risk: {
      circuit_breaker_state: { status: 'unavailable', reason: 'no risk gate yet' },
      daily_loss_usage: { status: 'unavailable', reason: 'no risk gate yet' },
      open_trade_count: { status: 'unavailable', reason: 'no risk gate yet' },
      rejected_trade_count: { status: 'unavailable', reason: 'no risk gate yet' },
    },
    latency: {
      last_event_lag_ms: { status: 'unavailable', reason: 'no events yet' },
      telemetry_only: true,
    },
    alerts: [],
    system_health: {
      server_status: 'starting',
      ws_client_count: 0,
      ws_backpressure: false,
      dropped_critical_frame_count: 0,
      checkpoint_status: { status: 'unavailable', reason: 'not started' },
    },
    feature_surface: {
      mask_version: 5,
      mask_id: 'feature-availability-mask-v5-adr0003-data-mbo03-advisory-policy',
      mask_hash: 'sha256:test',
      mask_source: 'fallback',
      field_tiers: {},
      partition_counts: {
        authoritative: 0,
        subscope: 0,
        diagnostic_only: 0,
        shadow_only: 0,
        advisory_only: 0,
        blocked: 0,
        available: 0,
      },
      recent_violations: [],
    },
  };
}

describe('operator console snapshot and delta contracts', () => {
  it('keeps stream frames JSON-safe with decimal sequence strings', () => {
    const frame: ConsoleStreamFrame = {
      kind: 'snapshot',
      seq: '1',
      snapshot: minimalSnapshot(),
    };

    assertJsonSafe(frame);
    expect(stableJsonStringify(frame)).toContain('"schema_version":1');
    expect(nextSequence(frame.seq)).toBe('2');
  });

  it('rejects bigint and unsafe integer payloads', () => {
    expect(() => assertJsonSafe({ ts_ns: 1700000000000000000n })).toThrow('bigint');
    expect(() => assertJsonSafe({ ts_ns: 1700000000000000000 })).toThrow('unsafe integer');
  });

  it('rejects malformed sequence strings', () => {
    expect(() => assertDecimalSequence('1')).not.toThrow();
    expect(() => assertDecimalSequence('01')).toThrow();
    expect(() => assertDecimalSequence('abc')).toThrow();
  });
});
