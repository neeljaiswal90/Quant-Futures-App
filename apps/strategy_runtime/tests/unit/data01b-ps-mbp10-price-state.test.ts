import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateJournalEventEnvelope, type JournalEventEnvelope } from '../../src/contracts/index.js';
import { parseTransportJournalEvent } from '../../src/transport/index.js';

const PYTHON = process.env.PYTHON ?? 'python';
const START_TS_NS = 1_777_301_421_588_943_700n;
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-data01b-ps-'));
  tempDirectories.push(directory);
  return directory;
}

function writeInput(directory: string, rows: readonly Record<string, unknown>[]): string {
  const inputPath = join(directory, 'probe.jsonl');
  writeFileSync(inputPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return inputPath;
}

function runPriceState(rows: readonly Record<string, unknown>[]): {
  readonly journal: string;
  readonly report: Record<string, unknown>;
  readonly lines: readonly string[];
} {
  const directory = makeTempDir();
  const inputPath = writeInput(directory, rows);
  const outputPath = join(directory, 'mbp10-price-state.jsonl');
  const reportPath = join(directory, 'report.json');
  const result = spawnSync(
    PYTHON,
    [
      '-m',
      'services.market_data_sidecar.mbp10_price_state_app',
      '--input',
      inputPath,
      '--out',
      outputPath,
      '--report',
      reportPath,
      '--run-id',
      'run-data01b-ps-test',
      '--session-id',
      '2026-04-27-rth',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );

  if (result.status !== 0) {
    throw new Error(`DATA-01B-PS sidecar failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }

  const journal = readFileSync(outputPath, 'utf8');
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
  return {
    journal,
    report,
    lines: journal.trim().split(/\r?\n/).filter(Boolean),
  };
}

function mbp10Row(offsetNs: bigint, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    stream: 'MBP10',
    exchange_event_ts_ns: (START_TS_NS + offsetNs).toString(),
    sidecar_recv_ts_ns: (START_TS_NS + offsetNs + 1_000_000n).toString(),
    bids: [{ px: 27526.25, sz: 10, order_count: 3 }],
    asks: [{ px: 27526.5, sz: 7, order_count: 4 }],
    ...overrides,
  };
}

describe('DATA-01B-PS MBP10 price-state ingestion', () => {
  it('reconstructs a price-keyed book and emits OBS-01-compatible price-state events', () => {
    const result = runPriceState([
      mbp10Row(0n, {
        bids: [
          { px: 27525.75, sz: 2, order_count: 1 },
          { px: 27526.25, sz: 10, order_count: 3 },
        ],
        asks: [
          { px: 27527, sz: 4, order_count: 2 },
          { px: 27526.5, sz: 7, order_count: 4 },
        ],
      }),
    ]);

    expect(result.report).toMatchObject({
      input_rows: 1,
      emitted_events: 1,
      emitted_mbp10_price_state_events: 1,
      mbp10_price_state_status: 'accepted_subscope',
      mbo_status: 'accepted_subscope',
      size_order_count_status: 'diagnostic_only',
      data01b_full_status: 'blocked',
    });

    const event = parseTransportJournalEvent(result.lines[0]!);
    expect(validateJournalEventEnvelope(event)).toMatchObject({ ok: true, issues: [] });
    expect(event.type).toBe('MICROSTRUCTURE');
    const payload = (event as JournalEventEnvelope).payload as Record<string, unknown>;
    expect(BigInt(event.ts_ns)).toBe(payload.exchange_event_ts_ns);
    expect(payload.sidecar_recv_ts_ns).not.toBe(payload.exchange_event_ts_ns);
    expect(payload).toMatchObject({
      l3_authority: 'unavailable',
      feature_availability_mask: {
        mask_id: 'feature-availability-mask-v5-adr0003-data-mbo03-advisory-policy',
        field_tiers: {
          mbp10_top_bid_px: 'authoritative',
          mbp10_size_diagnostic: 'diagnostic_only',
          mbo_order_id: 'subscope',
          queue_position: 'blocked',
        },
        lineage: {
          data01b_full_status: 'blocked',
        },
      },
      mbp10_price_state_status: 'accepted_subscope',
      mbo_status: 'accepted_subscope',
      size_order_count_status: 'diagnostic_only',
      data01b_full_status: 'blocked',
      bids: [
        { px: 27526.25, size_diagnostic: 10, order_count_diagnostic: 3 },
        { px: 27525.75, size_diagnostic: 2, order_count_diagnostic: 1 },
      ],
      asks: [
        { px: 27526.5, size_diagnostic: 7, order_count_diagnostic: 4 },
        { px: 27527, size_diagnostic: 4, order_count_diagnostic: 2 },
      ],
    });
    expect(payload.values).toMatchObject({
      bid_px_00: 27526.25,
      bid_px_01: 27525.75,
      ask_px_00: 27526.5,
      ask_px_01: 27527,
      bid_size_diagnostic_00: 10,
      bid_order_count_diagnostic_00: 3,
      feature_availability_mask_id: 'feature-availability-mask-v5-adr0003-data-mbo03-advisory-policy',
    });
  });

  it('applies zero-size updates as deletes and re-sorts top 10 levels', () => {
    const result = runPriceState([
      mbp10Row(0n, {
        bids: [
          { px: 27526, sz: 1 },
          { px: 27525.75, sz: 1 },
        ],
        asks: [
          { px: 27526.5, sz: 1 },
          { px: 27526.75, sz: 1 },
        ],
      }),
      mbp10Row(1_000_000n, {
        bids: [
          { px: 27526.25, sz: 3 },
          { px: 27526, sz: 0 },
        ],
        asks: [
          { px: 27526.25, sz: 2 },
          { px: 27526.5, sz: 0 },
        ],
      }),
    ]);

    expect(result.lines).toHaveLength(2);
    const second = JSON.parse(result.lines[1]!) as JournalEventEnvelope;
    expect(second.payload).toMatchObject({
      bids: [
        { px: 27526.25, size_diagnostic: 3 },
        { px: 27525.75, size_diagnostic: 1 },
      ],
      asks: [
        { px: 27526.25, size_diagnostic: 2 },
        { px: 27526.75, size_diagnostic: 1 },
      ],
    });
  });

  it('caps emitted state to top 10 sorted levels', () => {
    const result = runPriceState([
      mbp10Row(0n, {
        bids: Array.from({ length: 12 }, (_, index) => ({ px: 27520 + index * 0.25, sz: 1 })),
        asks: Array.from({ length: 12 }, (_, index) => ({ px: 27530 + index * 0.25, sz: 1 })),
      }),
    ]);
    const event = JSON.parse(result.lines[0]!) as JournalEventEnvelope;
    const payload = event.payload as { readonly bids: readonly { readonly px: number }[]; readonly asks: readonly { readonly px: number }[] };

    expect(payload.bids).toHaveLength(10);
    expect(payload.asks).toHaveLength(10);
    expect(payload.bids.map((level) => level.px)).toEqual([27522.75, 27522.5, 27522.25, 27522, 27521.75, 27521.5, 27521.25, 27521, 27520.75, 27520.5]);
    expect(payload.asks.map((level) => level.px)).toEqual([27530, 27530.25, 27530.5, 27530.75, 27531, 27531.25, 27531.5, 27531.75, 27532, 27532.25]);
  });

  it('skips MBO rows outside the price-state path and keeps full DATA-01B blocked', () => {
    const result = runPriceState([
      {
        schema_version: 1,
        stream: 'MBO',
        exchange_event_ts_ns: START_TS_NS.toString(),
        sidecar_recv_ts_ns: (START_TS_NS + 1_000_000n).toString(),
        orders: [{ action: 'new', side: 'buy', price: 27526.25, size: 1 }],
      },
      mbp10Row(1_000_000n),
    ]);

    expect(result.report).toMatchObject({
      input_rows: 2,
      emitted_events: 1,
      skipped_mbo_rows: 1,
      data01b_full_status: 'blocked',
      diagnostic_counts: {
        'MBO:mbo_accepted_subscope_not_consumed_by_price_state_path': 1,
      },
    });
  });

  it('uses null-timestamp MBP10 rows only as seed state and does not emit them', () => {
    const result = runPriceState([
      mbp10Row(0n, {
        exchange_event_ts_ns: null,
        bids: [{ px: 27526.25, sz: 10 }],
        asks: [{ px: 27526.5, sz: 8 }],
      }),
      mbp10Row(1_000_000n, {
        bids: [{ px: 27526, sz: 5 }],
        asks: [],
      }),
    ]);

    expect(result.report).toMatchObject({
      input_rows: 2,
      emitted_events: 1,
      seeded_null_exchange_ts_rows: 1,
      diagnostic_counts: {
        'MBP10:seeded_null_exchange_ts_ns': 1,
      },
    });
    const event = JSON.parse(result.lines[0]!) as JournalEventEnvelope;
    expect(event.payload).toMatchObject({
      bids: [
        { px: 27526.25, size_diagnostic: 10 },
        { px: 27526, size_diagnostic: 5 },
      ],
      asks: [{ px: 27526.5, size_diagnostic: 8 }],
    });
  });
});
