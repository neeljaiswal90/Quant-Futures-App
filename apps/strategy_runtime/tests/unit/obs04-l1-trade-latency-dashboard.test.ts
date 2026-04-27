import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildL1TradeLatencyDashboardReport,
  renderL1TradeLatencyDashboardJsonl,
} from '../../src/operator/l1-trade-latency-dashboard.js';

describe('OBS-04 L1/trade latency dashboard', () => {
  it('computes deterministic latency stats for QUOTE and TRADE source events', () => {
    const result = renderL1TradeLatencyDashboardJsonl(
      jsonl([
        quoteEvent({ event_id: 'quote-1', exchange: '1000000000', recv: '1100000000' }),
        tradeEvent({ event_id: 'trade-1', exchange: '2000000000', recv: '2400000000' }),
      ]),
      { format: 'text' },
    );

    expect(result.exit_code).toBe(0);
    expect(result.report.status).toBe('pass');
    expect(result.report.events_seen).toBe(2);
    expect(result.report.quote_events_seen).toBe(1);
    expect(result.report.trade_events_seen).toBe(1);
    expect(result.report.latency.quote.p50_latency_ms).toBe(100);
    expect(result.report.latency.trade.p50_latency_ms).toBe(400);
    expect(result.stdout).toContain('[COMBINED] events=2 samples=2 min_ms=100 p50_ms=100 p95_ms=400 p99_ms=400 max_ms=400 negative=0');
    expect(result.stdout).toContain('guardrail=DATA-01B remains blocked pending MBP10/MBO parity');
  });

  it('renders byte-stable JSON output across two runs', () => {
    const input = jsonl([
      quoteEvent({ event_id: 'quote-1', exchange: '1000000000', recv: '1100000000' }),
      quoteEvent({ event_id: 'quote-2', exchange: '2000000000', recv: '2200000000' }),
      tradeEvent({ event_id: 'trade-1', exchange: '3000000000', recv: '3600000000' }),
    ]);

    const first = renderL1TradeLatencyDashboardJsonl(input, { format: 'json' });
    const second = renderL1TradeLatencyDashboardJsonl(input, { format: 'json' });

    expect(first.exit_code).toBe(0);
    expect(first.stdout).toEqual(second.stdout);
    expect(first.report).toEqual(second.report);
  });

  it('flags negative latency telemetry without changing canonical event time', () => {
    const report = buildL1TradeLatencyDashboardReport(
      jsonl([quoteEvent({ event_id: 'quote-1', exchange: '2000000000', recv: '1900000000' })]),
    );

    expect(report.status).toBe('warning');
    expect(report.negative_latency_count).toBe(1);
    expect(report.latency.quote.min_latency_ms).toBe(-100);
    expect(report.notes).toContain(
      'sidecar_recv_ts_ns is telemetry only; exchange_event_ts_ns remains canonical event time.',
    );
  });

  it('ignores valid non-L1/trade OBS-01 events', () => {
    const report = buildL1TradeLatencyDashboardReport(
      jsonl([
        quoteEvent({ event_id: 'quote-1', exchange: '1000000000', recv: '1100000000' }),
        barCloseEvent({ event_id: 'bar-1', exchange: '2000000000', recv: '2200000000' }),
      ]),
    );

    expect(report.status).toBe('pass');
    expect(report.events_seen).toBe(2);
    expect(report.l1_trade_events_seen).toBe(1);
    expect(report.ignored_event_count).toBe(1);
    expect(report.latency.combined.event_count).toBe(1);
  });

  it('returns diagnostics for schema-invalid rows', () => {
    const result = renderL1TradeLatencyDashboardJsonl(
      jsonl([
        {
          ...quoteEvent({ event_id: 'quote-1', exchange: '1000000000', recv: '1100000000' }),
          payload: {
            exchange_event_ts_ns: '1000000000',
            bid_px: 1,
            bid_qty: 1,
            ask_px: 2,
            ask_qty: 1,
          },
        },
      ]),
      { format: 'text' },
    );

    expect(result.exit_code).toBe(1);
    expect(result.report.status).toBe('fail');
    expect(result.report.invalid_event_count).toBe(1);
    expect(result.stderr).toContain('$.payload.sidecar_recv_ts_ns is required');
  });

  it('keeps deterministic runtime hazards out of the dashboard implementation', () => {
    const source = readFileSync(
      resolve('apps/strategy_runtime/src/operator/l1-trade-latency-dashboard.ts'),
      'utf8',
    );

    expect(source).not.toContain('Date.now');
    expect(source).not.toContain('new Date');
    expect(source).not.toContain('Math.random');
    expect(source).not.toContain('toLocaleString');
    expect(source).not.toContain('localeCompare');
  });
});

function jsonl(rows: readonly unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function baseEvent(input: {
  readonly event_id: string;
  readonly type: string;
  readonly ts_ns: string;
  readonly payload: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: input.event_id,
    type: input.type,
    ts_ns: input.ts_ns,
    run_id: 'run-obs04',
    session_id: 'session-obs04',
    payload: input.payload,
  };
}

function quoteEvent(input: {
  readonly event_id: string;
  readonly exchange: string;
  readonly recv: string;
}): Record<string, unknown> {
  return baseEvent({
    event_id: input.event_id,
    type: 'QUOTE',
    ts_ns: input.exchange,
    payload: {
      exchange_event_ts_ns: input.exchange,
      sidecar_recv_ts_ns: input.recv,
      bid_px: 100,
      bid_qty: 2,
      ask_px: 100.25,
      ask_qty: 3,
      authority: 'authoritative',
    },
  });
}

function tradeEvent(input: {
  readonly event_id: string;
  readonly exchange: string;
  readonly recv: string;
}): Record<string, unknown> {
  return baseEvent({
    event_id: input.event_id,
    type: 'TRADE',
    ts_ns: input.exchange,
    payload: {
      exchange_event_ts_ns: input.exchange,
      sidecar_recv_ts_ns: input.recv,
      trade_id: input.event_id,
      price: 100.25,
      quantity: 1,
      aggressor_side: 'buy',
    },
  });
}

function barCloseEvent(input: {
  readonly event_id: string;
  readonly exchange: string;
  readonly recv: string;
}): Record<string, unknown> {
  return baseEvent({
    event_id: input.event_id,
    type: 'BAR_CLOSE',
    ts_ns: input.exchange,
    payload: {
      exchange_event_ts_ns: input.exchange,
      sidecar_recv_ts_ns: input.recv,
      timeframe: '1m',
      start_ts_ns: '1000000000',
      end_ts_ns: '2000000000',
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 10,
      trade_count: 3,
    },
  });
}
