import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const PYTHON = process.env.PYTHON ?? 'python';
const START_TS_NS = 1_777_255_537_000_000_000n;
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-data07a-'));
  tempDirectories.push(directory);
  return directory;
}

function tsNs(offsetMs: number): string {
  return (START_TS_NS + BigInt(offsetMs) * 1_000_000n).toString();
}

function quoteRow(offsetMs: number, recvOffsetMs = offsetMs + 1): Record<string, unknown> {
  return {
    schema_version: 1,
    stream: 'L1_QUOTE',
    exchange_event_ts_ns: tsNs(offsetMs),
    sidecar_recv_ts_ns: tsNs(recvOffsetMs),
    bid_px: 27526.25,
    ask_px: 27526.5,
    bid_sz: 4,
    ask_sz: 5,
  };
}

function tradeRow(offsetMs: number, recvOffsetMs = offsetMs + 1): Record<string, unknown> {
  return {
    schema_version: 1,
    stream: 'LAST_TRADE',
    exchange_event_ts_ns: tsNs(offsetMs),
    sidecar_recv_ts_ns: tsNs(recvOffsetMs),
    price: 27526.5,
    size: 1,
    aggressor: 'buy',
  };
}

function runGapReport(rows: readonly Record<string, unknown>[]): {
  readonly reportText: string;
  readonly report: Record<string, unknown>;
} {
  const directory = makeTempDir();
  const inputPath = join(directory, 'probe.jsonl');
  const reportPath = join(directory, 'gap-report.json');
  writeFileSync(inputPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  const result = spawnSync(
    PYTHON,
    [
      '-m',
      'services.market_data_sidecar.gap_report_app',
      '--input',
      inputPath,
      '--report',
      reportPath,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );

  if (result.status !== 0) {
    throw new Error(`DATA-07A gap report failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }

  const reportText = readFileSync(reportPath, 'utf8');
  return {
    reportText,
    report: JSON.parse(reportText) as Record<string, unknown>,
  };
}

function streamSummaries(report: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return report.stream_summaries as Record<string, Record<string, unknown>>;
}

describe('DATA-07A L1/trade-only gap detection', () => {
  it('reports no gaps on a continuous QUOTE stream', () => {
    const { report } = runGapReport([quoteRow(0), quoteRow(250), quoteRow(500)]);

    expect(report).toMatchObject({
      status: 'pass',
      streams_checked: ['L1_QUOTE', 'LAST_TRADE'],
      quote_gap_count: 0,
      trade_gap_count: 0,
      max_quote_gap_ms: 250,
      warning_count: 0,
      fail_count: 0,
      partial_parity_status: 'L1_TRADE_ONLY_PASS',
      data01_full_gate_status: 'blocked',
      data01b_status: 'blocked_l2_l3_parity',
    });
    expect(streamSummaries(report).L1_QUOTE).toMatchObject({
      record_count: 3,
      observed_interval_count: 2,
      gap_count: 2,
      gaps_over_threshold: 0,
    });
  });

  it('detects quote gaps from reconstructed side-specific BBO updates', () => {
    const { report } = runGapReport([
      {
        schema_version: 1,
        stream: 'L1_QUOTE',
        exchange_event_ts_ns: tsNs(0),
        sidecar_recv_ts_ns: tsNs(1),
        bid_px: 27526.25,
        bid_sz: 4,
      },
      {
        schema_version: 1,
        stream: 'L1_QUOTE',
        exchange_event_ts_ns: tsNs(100),
        sidecar_recv_ts_ns: tsNs(101),
        ask_px: 27526.5,
        ask_sz: 5,
      },
      {
        schema_version: 1,
        stream: 'L1_QUOTE',
        exchange_event_ts_ns: tsNs(250),
        sidecar_recv_ts_ns: tsNs(251),
        bid_px: 27526,
        bid_sz: 6,
      },
      {
        schema_version: 1,
        stream: 'L1_QUOTE',
        exchange_event_ts_ns: tsNs(500),
        sidecar_recv_ts_ns: tsNs(501),
        ask_px: 27526.75,
        ask_sz: 2,
      },
    ]);

    expect(report).toMatchObject({
      status: 'pass',
      quote_gap_count: 0,
      max_quote_gap_ms: 250,
      diagnostic_count: 1,
      diagnostic_counts: {
        'L1_QUOTE:warming_quote_bbo_state': 1,
      },
    });
    expect(streamSummaries(report).L1_QUOTE).toMatchObject({
      record_count: 3,
      observed_interval_count: 2,
      gap_count: 2,
      gaps_over_threshold: 0,
    });
  });

  it('classifies quote gaps over warning and fail thresholds as feed gaps', () => {
    const { report } = runGapReport([quoteRow(0), quoteRow(1500), quoteRow(7000)]);
    const gaps = report.gaps as readonly Record<string, unknown>[];

    expect(report).toMatchObject({
      status: 'fail',
      quote_gap_count: 2,
      trade_gap_count: 0,
      max_quote_gap_ms: 5500,
      warning_count: 1,
      fail_count: 1,
    });
    expect(gaps.map((gap) => gap.reason_code)).toEqual([
      'l1_quote_feed_gap_warning',
      'l1_quote_feed_gap_fail',
    ]);
    expect(gaps.every((gap) => gap.stream === 'L1_QUOTE')).toBe(true);
  });

  it('classifies trade silence separately from quote feed gaps', () => {
    const { report } = runGapReport([tradeRow(0), tradeRow(61_000)]);
    const gaps = report.gaps as readonly Record<string, unknown>[];

    expect(report).toMatchObject({
      status: 'warning',
      quote_gap_count: 0,
      trade_gap_count: 1,
      max_trade_gap_ms: 61000,
      warning_count: 1,
      fail_count: 0,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      stream: 'LAST_TRADE',
      reason_code: 'last_trade_silence_warning',
      severity: 'warning',
    });
  });

  it('does not use sidecar receive time as canonical gap time', () => {
    const { report } = runGapReport([
      quoteRow(0, 0),
      quoteRow(100, 200_000),
    ]);

    expect(report).toMatchObject({
      status: 'pass',
      quote_gap_count: 0,
      max_quote_gap_ms: 100,
    });
  });

  it('keeps missing timestamps and MBP10/MBO rows out of verified gap detection', () => {
    const { report } = runGapReport([
      {
        ...quoteRow(0),
        exchange_event_ts_ns: null,
      },
      {
        schema_version: 1,
        stream: 'MBP10',
        exchange_event_ts_ns: tsNs(1),
        sidecar_recv_ts_ns: tsNs(2),
        bids: [{ level: 0, px: 27526.25, sz: 10 }],
      },
      {
        schema_version: 1,
        stream: 'MBO',
        exchange_event_ts_ns: tsNs(3),
        sidecar_recv_ts_ns: tsNs(4),
        action: 'new',
      },
    ]);

    expect(report).toMatchObject({
      status: 'pass',
      skipped_mbp10_rows: 1,
      skipped_mbo_rows: 1,
      skipped_null_exchange_ts_rows: 1,
      diagnostic_count: 3,
      diagnostic_counts: {
        'L1_QUOTE:missing_exchange_event_ts_ns': 1,
        'MBP10:blocked_l2_l3_stream': 1,
        'MBO:blocked_l2_l3_stream': 1,
      },
    });
    expect(streamSummaries(report).L1_QUOTE.record_count).toBe(0);
    expect(streamSummaries(report).LAST_TRADE.record_count).toBe(0);
  });

  it('has a stable report shape and byte-stable output across repeated runs', () => {
    const rows = [quoteRow(0), quoteRow(1500), tradeRow(0), tradeRow(61_000)];
    const first = runGapReport(rows);
    const second = runGapReport(rows);

    expect(first.reportText).toBe(second.reportText);
    expect(Object.keys(first.report)).toEqual([
      'data01_full_gate_status',
      'data01b_status',
      'diagnostic_count',
      'diagnostic_counts',
      'diagnostics',
      'diagnostics_truncated',
      'fail_count',
      'gaps',
      'gaps_truncated',
      'input_rows',
      'max_quote_gap_ms',
      'max_trade_gap_ms',
      'partial_parity_status',
      'quote_gap_count',
      'skipped_mbo_rows',
      'skipped_mbp10_rows',
      'skipped_null_exchange_ts_rows',
      'status',
      'stream_summaries',
      'streams_checked',
      'thresholds',
      'trade_gap_count',
      'warning_count',
    ]);
  });

  it('does not introduce wall-clock, random, or L2/L3 feature paths', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../services/market_data_sidecar');
    const source = ['gap_detection.py', 'gap_report_app.py']
      .map((file) => readFileSync(join(root, file), 'utf8'))
      .join('\n');

    expect(source).not.toContain('datetime.now');
    expect(source).not.toContain('time.time');
    expect(source).not.toContain('random');
    expect(source).not.toContain('mbp10_book_state');
    expect(source).not.toContain('advanced_mbo');
  });
});
