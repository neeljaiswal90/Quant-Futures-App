import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseTransportJournalEvent,
} from '../../src/transport/index.js';
import {
  validateJournalEventEnvelope,
  type JournalEventEnvelope,
} from '../../src/contracts/index.js';

const PYTHON = process.env.PYTHON ?? 'python';
const START_TS_NS = 1_777_255_537_527_026_000n;
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-data01a-'));
  tempDirectories.push(directory);
  return directory;
}

function richProbeRows(): readonly Record<string, unknown>[] {
  return [
    {
      schema_version: 1,
      stream: 'L1_QUOTE',
      exchange_event_ts_ns: START_TS_NS.toString(),
      sidecar_recv_ts_ns: (START_TS_NS + 2_000_000n).toString(),
      bid_px: 27526.25,
      ask_px: 27527,
      bid_sz: 4,
      ask_sz: 5,
      bid_orders: 4,
      ask_orders: 4,
    },
    {
      schema_version: 1,
      stream: 'LAST_TRADE',
      exchange_event_ts_ns: (START_TS_NS + 1_000_000n).toString(),
      sidecar_recv_ts_ns: (START_TS_NS + 3_000_000n).toString(),
      price: 27526.5,
      size: 1,
      aggressor: 'sell',
      order_id: 'trade-order-1',
    },
    {
      schema_version: 1,
      stream: 'MBP10',
      exchange_event_ts_ns: (START_TS_NS + 2_000_000n).toString(),
      sidecar_recv_ts_ns: (START_TS_NS + 4_000_000n).toString(),
      bids: [{ level: 0, px: 27526.25, sz: 10, order_count: 3 }],
    },
    {
      schema_version: 1,
      stream: 'MBO',
      exchange_event_ts_ns: (START_TS_NS + 3_000_000n).toString(),
      sidecar_recv_ts_ns: (START_TS_NS + 5_000_000n).toString(),
      orders: [{ action: 'new', side: 'buy', price: 27526.25, size: 1 }],
    },
    {
      schema_version: 1,
      stream: 'L1_QUOTE',
      exchange_event_ts_ns: null,
      sidecar_recv_ts_ns: (START_TS_NS + 6_000_000n).toString(),
      bid_px: 27526,
      ask_px: 27526.25,
      bid_sz: 1,
      ask_sz: 2,
    },
  ];
}

function writeInput(directory: string, rows: readonly Record<string, unknown>[]): string {
  const inputPath = join(directory, 'probe.jsonl');
  writeFileSync(inputPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return inputPath;
}

function runData01a(rows: readonly Record<string, unknown>[]): {
  readonly journal: string;
  readonly report: Record<string, unknown>;
  readonly lines: readonly string[];
} {
  const directory = makeTempDir();
  const inputPath = writeInput(directory, rows);
  const outputPath = join(directory, 'journal.jsonl');
  const reportPath = join(directory, 'report.json');
  const result = spawnSync(
    PYTHON,
    [
      '-m',
      'services.market_data_sidecar.app',
      '--input',
      inputPath,
      '--out',
      outputPath,
      '--report',
      reportPath,
      '--run-id',
      'run-data01a-test',
      '--session-id',
      '2026-04-26-rth',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );

  if (result.status !== 0) {
    throw new Error(`DATA-01A sidecar failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }

  const journal = readFileSync(outputPath, 'utf8');
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
  return {
    journal,
    report,
    lines: journal.trim().split(/\r?\n/).filter(Boolean),
  };
}

describe('DATA-01A L1/trade-only sidecar ingestion', () => {
  it('emits only OBS-01 QUOTE and TRADE source events from rich Rithmic rows', () => {
    const result = runData01a(richProbeRows());

    expect(result.report).toMatchObject({
      input_rows: 5,
      emitted_events: 2,
      emitted_quote_events: 1,
      emitted_trade_events: 1,
      skipped_mbp10_rows: 1,
      skipped_mbo_rows: 1,
      skipped_null_exchange_ts_rows: 1,
      diagnostic_count: 3,
      diagnostic_counts: {
        'L1_QUOTE:missing_exchange_event_ts_ns': 1,
        'MBP10:blocked_l2_l3_stream': 1,
        'MBO:blocked_l2_l3_stream': 1,
      },
      diagnostics_truncated: false,
      partial_parity_status: 'L1_TRADE_ONLY_PASS',
      data01_full_gate_status: 'blocked',
      data01b_status: 'blocked_l2_l3_parity',
    });

    const events = result.lines.map((line) => parseTransportJournalEvent(line));
    expect(events.map((event) => event.type)).toEqual(['QUOTE', 'TRADE']);
    for (const event of events) {
      expect(validateJournalEventEnvelope(event)).toMatchObject({ ok: true, issues: [] });
      const payload = event.payload as { readonly exchange_event_ts_ns: bigint; readonly sidecar_recv_ts_ns: bigint };
      expect(BigInt(event.ts_ns)).toBe(payload.exchange_event_ts_ns);
      expect(payload.sidecar_recv_ts_ns).not.toBe(payload.exchange_event_ts_ns);
    }
  });

  it('preserves L1/trade payload fields and deterministic event ids', () => {
    const result = runData01a(richProbeRows());
    const [quote, trade] = result.lines.map((line) => JSON.parse(line) as JournalEventEnvelope);

    expect(quote).toMatchObject({
      event_id: 'quote-run-data01a-test-000000000001',
      type: 'QUOTE',
      run_id: 'run-data01a-test',
      session_id: '2026-04-26-rth',
      payload: {
        bid_px: 27526.25,
        bid_qty: 4,
        ask_px: 27527,
        ask_qty: 5,
        authority: 'authoritative',
      },
    });
    expect(trade).toMatchObject({
      event_id: 'trade-run-data01a-test-000000000002',
      type: 'TRADE',
      payload: {
        price: 27526.5,
        quantity: 1,
        aggressor_side: 'sell',
        trade_id: 'trade-order-1',
      },
    });
  });

  it('reconstructs complete BBO events from side-specific L1 quote updates', () => {
    const result = runData01a([
      {
        schema_version: 1,
        stream: 'L1_QUOTE',
        exchange_event_ts_ns: START_TS_NS.toString(),
        sidecar_recv_ts_ns: (START_TS_NS + 1_000_000n).toString(),
        bid_px: 27526.25,
        bid_sz: 4,
      },
      {
        schema_version: 1,
        stream: 'L1_QUOTE',
        exchange_event_ts_ns: (START_TS_NS + 1_000_000n).toString(),
        sidecar_recv_ts_ns: (START_TS_NS + 2_000_000n).toString(),
        ask_px: 27526.5,
        ask_sz: 5,
      },
      {
        schema_version: 1,
        stream: 'L1_QUOTE',
        exchange_event_ts_ns: (START_TS_NS + 2_000_000n).toString(),
        sidecar_recv_ts_ns: (START_TS_NS + 3_000_000n).toString(),
        bid_px: 27526,
        bid_sz: 6,
      },
      {
        schema_version: 1,
        stream: 'LAST_TRADE',
        exchange_event_ts_ns: (START_TS_NS + 3_000_000n).toString(),
        sidecar_recv_ts_ns: (START_TS_NS + 4_000_000n).toString(),
        price: 27526.25,
        size: 2,
        aggressor: 'buy',
      },
    ]);
    const [firstQuote, secondQuote, trade] = result.lines.map((line) => JSON.parse(line) as JournalEventEnvelope);

    expect(result.report).toMatchObject({
      input_rows: 4,
      emitted_events: 3,
      emitted_quote_events: 2,
      emitted_trade_events: 1,
      diagnostic_count: 1,
      diagnostic_counts: {
        'L1_QUOTE:warming_quote_bbo_state': 1,
      },
    });
    expect(firstQuote).toMatchObject({
      event_id: 'quote-run-data01a-test-000000000001',
      type: 'QUOTE',
      ts_ns: (START_TS_NS + 1_000_000n).toString(),
      payload: {
        bid_px: 27526.25,
        bid_qty: 4,
        ask_px: 27526.5,
        ask_qty: 5,
      },
    });
    expect(secondQuote).toMatchObject({
      event_id: 'quote-run-data01a-test-000000000002',
      type: 'QUOTE',
      ts_ns: (START_TS_NS + 2_000_000n).toString(),
      payload: {
        bid_px: 27526,
        bid_qty: 6,
        ask_px: 27526.5,
        ask_qty: 5,
      },
    });
    expect(trade).toMatchObject({
      event_id: 'trade-run-data01a-test-000000000003',
      type: 'TRADE',
    });
  });

  it('is byte-stable across repeated runs', () => {
    const first = runData01a(richProbeRows());
    const second = runData01a(richProbeRows());

    expect(first.journal).toBe(second.journal);
    expect(JSON.stringify(first.report)).toBe(JSON.stringify(second.report));
  });

  it('does not introduce wall-clock, random, or L2/L3 feature paths', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../services/market_data_sidecar');
    const files = [
      'app.py',
      'providers/rithmic_live.py',
      'publish/event_journal.py',
      'publish/snapshot_publisher.py',
      'session/session_clock.py',
    ];
    const source = files.map((file) => readFileSync(join(root, file), 'utf8')).join('\n');

    expect(source).not.toContain('datetime.now');
    expect(source).not.toContain('time.time');
    expect(source).not.toContain('random');
    expect(source).not.toContain('mbp10_book_state');
    expect(source).not.toContain('advanced_mbo');
  });
});
