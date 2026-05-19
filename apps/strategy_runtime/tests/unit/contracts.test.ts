import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STRATEGY_IDS,
  REGISTERED_INACTIVE_STRATEGY_IDS,
  channelsForEventType,
  createJournalEventEnvelope,
  isStrategyId,
  journalEventFromJsonLine,
  journalEventToJsonLine,
  makeConfigHash,
  makeCorrelationId,
  makeEventId,
  makeRuntimeTimestampSet,
  makeRunId,
  makeSessionId,
  ns,
  parseStrategyId,
  stableJsonStringify,
  unixNsToJsonString,
  validateRuntimeTimestampSet,
} from '../../src/contracts/index.js';

const CONFIG_HASH = makeConfigHash('a'.repeat(64));

function listContractFiles(directory = join(process.cwd(), 'apps/strategy_runtime/src/contracts')): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return listContractFiles(path);
    }
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

describe('APP-02 contracts', () => {
  it('validates explicit timestamp semantics without assuming provider latency ordering', () => {
    const timestamps = makeRuntimeTimestampSet({
      exchange_event_ts_ns: 100,
      rithmic_publish_ts_ns: 99,
      sidecar_recv_ts_ns: 101,
      runtime_consume_ts_ns: 102,
      ts_ns: 100,
    });

    expect(timestamps.exchange_event_ts_ns).toBe(ns(100));
    expect(timestamps.rithmic_publish_ts_ns).toBe(ns(99));
    expect(validateRuntimeTimestampSet(timestamps)).toEqual([]);
  });

  it('reports invalid timestamp fields with stable paths', () => {
    expect(
      validateRuntimeTimestampSet({
        exchange_event_ts_ns: -1,
        sidecar_recv_ts_ns: 1.5,
        runtime_consume_ts_ns: Number.NaN,
        ts_ns: 1,
      }),
    ).toEqual([
      {
        path: 'exchange_event_ts_ns',
        message: 'must be a non-negative integer nanosecond timestamp',
      },
      {
        path: 'sidecar_recv_ts_ns',
        message: 'must be a non-negative integer nanosecond timestamp',
      },
      {
        path: 'runtime_consume_ts_ns',
        message: 'must be a non-negative integer nanosecond timestamp',
      },
    ]);
  });

  it('creates event envelopes without wall-clock generated fields', () => {
    const event = createJournalEventEnvelope({
      event_id: makeEventId('evt-1'),
      type: 'CANDIDATE',
      ts_ns: 1_700_000_000_000_000_000n,
      run_id: makeRunId('run-1'),
      session_id: makeSessionId('session-1'),
      correlation_id: makeCorrelationId('candidate-chain-1'),
      config: {
        config_hash: CONFIG_HASH,
        config_version: 1,
      },
      payload: {
        candidate_id: 'candidate-1',
        strategy_id: 'trend_pullback_long',
      },
    });

    expect(event).toEqual({
      schema_version: 2,
      event_id: 'evt-1',
      type: 'CANDIDATE',
      ts_ns: 1_700_000_000_000_000_000n,
      run_id: 'run-1',
      session_id: 'session-1',
      payload: {
        candidate_id: 'candidate-1',
        strategy_id: 'trend_pullback_long',
      },
      correlation_id: 'candidate-chain-1',
      config: {
        config_hash: CONFIG_HASH,
        config_version: 1,
      },
    });
  });

  it('serializes journal events in deterministic JSON key order', () => {
    const event = createJournalEventEnvelope({
      event_id: makeEventId('evt-quote-1'),
      type: 'QUOTE',
      ts_ns: 42,
      run_id: makeRunId('run-1'),
      session_id: makeSessionId('session-1'),
      payload: {
        z: 3,
        a: {
          bid_px: 18000.25,
          ask_px: 18000.5,
        },
      },
    });

    expect(journalEventToJsonLine(event)).toBe(
      '{"event_id":"evt-quote-1","payload":{"a":{"ask_px":18000.5,"bid_px":18000.25},"z":3},"run_id":"run-1","schema_version":2,"session_id":"session-1","ts_ns":"42","type":"QUOTE"}\n',
    );
    expect(stableJsonStringify({ b: 1, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":1}',
    );
  });

  it('serializes nanosecond timestamps as JSON strings and revives them to branded bigint', () => {
    const timestamp = ns(1_776_965_227_000_000_000n);
    const event = createJournalEventEnvelope({
      event_id: makeEventId('evt-ts-1'),
      type: 'QUOTE',
      ts_ns: timestamp,
      run_id: makeRunId('run-1'),
      session_id: makeSessionId('2026-04-23-rth'),
      payload: {
        exchange_event_ts_ns: timestamp,
        quote: 'synthetic',
      },
    });

    const line = journalEventToJsonLine(event);
    const parsed = JSON.parse(line) as {
      ts_ns: unknown;
      payload: { exchange_event_ts_ns: unknown };
    };
    const revived = journalEventFromJsonLine(line);

    expect(line).toContain('"ts_ns":"1776965227000000000"');
    expect(line).toContain('"exchange_event_ts_ns":"1776965227000000000"');
    expect(line).not.toContain('"ts_ns":1776965227000000000');
    expect(parsed.ts_ns).toBe('1776965227000000000');
    expect(parsed.payload.exchange_event_ts_ns).toBe('1776965227000000000');
    expect(revived.ts_ns).toBe(timestamp);
    expect(revived.payload).toEqual({
      exchange_event_ts_ns: timestamp,
      quote: 'synthetic',
    });
    expect(unixNsToJsonString(timestamp)).toBe('1776965227000000000');
  });

  it('rejects invalid timestamp strings at contract and JSONL revive boundaries', () => {
    for (const invalid of ['', '1.5', '-1', 'not-a-timestamp']) {
      expect(() => ns(invalid)).toThrow();
      expect(() =>
        journalEventFromJsonLine(
          `{"event_id":"evt-bad","payload":{},"run_id":"run","schema_version":1,"session_id":"session","ts_ns":${JSON.stringify(invalid)},"type":"QUOTE"}`,
        ),
      ).toThrow();
    }

    expect(() =>
      journalEventFromJsonLine(
        '{"event_id":"evt-bad","payload":{},"run_id":"run","schema_version":1,"session_id":"session","ts_ns":1776965227000000000,"type":"QUOTE"}',
      ),
    ).toThrow('ts_ns must be a decimal string');
  });

  it('accepts the Cycle3 active IDs while preserving inactive registered lineage', () => {
    expect(ACTIVE_STRATEGY_IDS).toEqual([
      'vwap_overnight_reversal_long',
      'vwap_overnight_reversal_short',
      'regime_shock_reversion_short_v2',
    ]);
    expect(REGISTERED_INACTIVE_STRATEGY_IDS).toEqual([
      'trend_pullback_long',
      'trend_pullback_short',
      'breakout_retest_long',
      'breakdown_retest_short',
      'regime_mean_reversion_long',
      'regime_mean_reversion_short',
      'liquidity_sweep_reversal_long',
      'liquidity_sweep_reversal_short',
    ]);
    expect(isStrategyId('vwap_overnight_reversal_long')).toBe(true);
    expect(isStrategyId('breakout_retest_long')).toBe(true);
    expect(parseStrategyId('breakdown_retest_short')).toBe('breakdown_retest_short');
    expect(isStrategyId('shadow_lob_scalp')).toBe(false);
    expect(() => parseStrategyId('shadow_lob_scalp')).toThrow('Unknown strategy_id');
  });

  it('maps event types to planned operator channels without recompute contracts', () => {
    expect(channelsForEventType('QUOTE')).toEqual(['MARKET']);
    expect(channelsForEventType('SIM_FILL')).toEqual(['ORDERS']);
    expect(channelsForEventType('EXEC_REJECT')).toEqual(['ORDERS']);
    expect(channelsForEventType('MGMT_ACTION')).toEqual(['POSITION']);
  });

  it('keeps deterministic contract helpers free of wall-clock and random sources', () => {
    const forbiddenPatterns = [/\bDate\.now\b/, /\bnew Date\s*\(/, /\bMath\.random\b/, /\btoLocaleString\b/];
    const findings = listContractFiles().flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return forbiddenPatterns
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${file}: ${pattern}`);
    });

    expect(findings).toEqual([]);
  });
});
