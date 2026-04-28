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
  const directory = mkdtempSync(join(tmpdir(), 'qfa-data02-ps-'));
  tempDirectories.push(directory);
  return directory;
}

function writeInput(directory: string, rows: readonly Record<string, unknown>[]): string {
  const inputPath = join(directory, 'input.jsonl');
  writeFileSync(inputPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return inputPath;
}

function runFeatures(rows: readonly Record<string, unknown>[]): {
  readonly journal: string;
  readonly report: Record<string, unknown>;
  readonly lines: readonly string[];
} {
  const directory = makeTempDir();
  const inputPath = writeInput(directory, rows);
  const outputPath = join(directory, 'features.jsonl');
  const reportPath = join(directory, 'report.json');
  const result = spawnSync(
    PYTHON,
    [
      '-m',
      'services.market_data_sidecar.mbp10_price_state_features_app',
      '--input',
      inputPath,
      '--out',
      outputPath,
      '--report',
      reportPath,
      '--run-id',
      'run-data02-ps-test',
      '--session-id',
      '2026-04-27-rth',
      '--symbol',
      'MNQM6',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );

  if (result.status !== 0) {
    throw new Error(`DATA-02-PS feature builder failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
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
    bids: [
      { px: 27526.25, sz: 10, order_count: 3 },
      { px: 27526.0, sz: 6, order_count: 2 },
    ],
    asks: [
      { px: 27526.5, sz: 7, order_count: 4 },
      { px: 27526.75, sz: 5, order_count: 2 },
    ],
    ...overrides,
  };
}

function l1QuoteRow(offsetNs: bigint, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    stream: 'L1_QUOTE',
    exchange_event_ts_ns: (START_TS_NS + offsetNs).toString(),
    sidecar_recv_ts_ns: (START_TS_NS + offsetNs + 1_000_000n).toString(),
    bid_px: 27526.25,
    bid_sz: 3,
    ask_px: 27526.5,
    ask_sz: 4,
    ...overrides,
  };
}

function priceStateEventRow(offsetNs: bigint): Record<string, unknown> {
  const exchangeTsNs = (START_TS_NS + offsetNs).toString();
  return {
    schema_version: 1,
    event_id: 'mbp10-price-state-run-upstream-000000000001',
    type: 'MICROSTRUCTURE',
    ts_ns: exchangeTsNs,
    run_id: 'run-upstream',
    session_id: '2026-04-27-rth',
    payload: {
      exchange_event_ts_ns: exchangeTsNs,
      sidecar_recv_ts_ns: (START_TS_NS + offsetNs + 1_000_000n).toString(),
      feature_snapshot_id: 'mbp10-price-state-source-1',
      l3_authority: 'unavailable',
      values: {},
      bids: [{ px: 27526.25, size_diagnostic: 10, order_count_diagnostic: 3 }],
      asks: [{ px: 27526.5, size_diagnostic: 7, order_count_diagnostic: 4 }],
      mbp10_price_state_status: 'accepted_subscope',
      mbo_status: 'accepted_subscope',
      size_order_count_status: 'diagnostic_only',
      data01b_full_status: 'blocked',
    },
  };
}

function firstEvent(result: ReturnType<typeof runFeatures>): JournalEventEnvelope {
  const event = parseTransportJournalEvent(result.lines[0]!);
  expect(validateJournalEventEnvelope(event)).toMatchObject({ ok: true, issues: [] });
  return event as JournalEventEnvelope;
}

describe('DATA-02-PS MBP10 price-state feature snapshots', () => {
  it('emits a valid deterministic feature snapshot from a reconstructed book', () => {
    const result = runFeatures([l1QuoteRow(0n), mbp10Row(1_000_000n)]);

    expect(result.report).toMatchObject({
      input_rows: 2,
      emitted_feature_snapshots: 1,
      invalid_feature_snapshots: 0,
      mbp10_price_state_status: 'accepted_subscope',
      mbo_status: 'accepted_subscope',
      size_order_count_status: 'diagnostic_only',
      data01b_full_status: 'blocked',
      l2_l3_scope: 'price_state_only',
      mbo_features_available: false,
    });

    const event = firstEvent(result);
    expect(event.type).toBe('MICROSTRUCTURE');
    expect(event.event_id).toBe('mbp10-price-state-features-run-data02-ps-test-000000000001');
    const payload = event.payload as Record<string, unknown>;
    const values = payload.values as Record<string, unknown>;

    expect(BigInt(event.ts_ns)).toBe(payload.exchange_event_ts_ns);
    expect(payload.sidecar_recv_ts_ns).not.toBe(payload.exchange_event_ts_ns);
    expect(payload).toMatchObject({
      feature_schema_version: 1,
      feature_snapshot_id: 'mbp10-price-state-features-run-data02-ps-test-000000000001',
      symbol: 'MNQM6',
      source: 'mbp10_price_state',
      top_bid_px: 27526.25,
      top_ask_px: 27526.5,
      spread_points: 0.25,
      spread_ticks: 1,
      mid_px: 27526.375,
      bid_levels_px: [27526.25, 27526],
      ask_levels_px: [27526.5, 27526.75],
      freshness_status: 'fresh',
      feature_availability_mask: {
        mask_id: 'feature-availability-mask-v2-adr0002-infra01e-infra01f-data02mbo',
        field_tiers: {
          mbp10_spread_ticks: 'authoritative',
          mbp10_size_diagnostic: 'diagnostic_only',
          mbo_order_id: 'subscope',
          queue_position: 'blocked',
        },
      },
      mbp10_price_state_status: 'accepted_subscope',
      mbo_status: 'accepted_subscope',
      size_order_count_status: 'diagnostic_only',
      data01b_full_status: 'blocked',
    });
    expect(payload.validity).toMatchObject({
      has_complete_top_of_book: true,
      spread_valid: true,
      price_ladder_valid: true,
      stale_mbp10_state: false,
      l2_l3_scope: 'price_state_only',
      mbo_features_available: false,
    });
    expect(payload.price_ladder_summary).toMatchObject({
      bid_level_count: 2,
      ask_level_count: 2,
      bid_nearest_level_gap_points: 0.25,
      ask_nearest_level_gap_points: 0.25,
      mid_to_nearest_bid_points: 0.125,
      mid_to_nearest_ask_points: 0.125,
    });
    expect(values).toMatchObject({
      source: 'mbp10_price_state',
      top_bid_px: 27526.25,
      top_ask_px: 27526.5,
      spread_ticks: 1,
      has_complete_top_of_book: true,
      l1_mbp10_top_bid_within_1_tick: true,
      l1_mbp10_top_ask_within_1_tick: true,
      feature_availability_mask_id: 'feature-availability-mask-v2-adr0002-infra01e-infra01f-data02mbo',
      mbo_features_available: false,
    });
  });

  it('sets causation_id when deriving from a prior DATA-01B-PS MICROSTRUCTURE event', () => {
    const result = runFeatures([priceStateEventRow(0n)]);
    const event = firstEvent(result);

    expect(event.ts_ns).toBe(START_TS_NS);
    expect(event.causation_id).toBe('mbp10-price-state-run-upstream-000000000001');
    expect(event.payload).toMatchObject({
      source_event_id: 'mbp10-price-state-run-upstream-000000000001',
      exchange_event_ts_ns: START_TS_NS,
      top_bid_px: 27526.25,
      top_ask_px: 27526.5,
    });
  });

  it('applies zero-size deletes before building the price ladder snapshot', () => {
    const result = runFeatures([
      mbp10Row(0n),
      mbp10Row(1_000_000n, {
        bids: [
          { px: 27526.25, sz: 0 },
          { px: 27526.5, sz: 2 },
        ],
        asks: [
          { px: 27526.5, sz: 0 },
          { px: 27527, sz: 2 },
        ],
      }),
    ]);

    expect(result.lines).toHaveLength(2);
    const second = JSON.parse(result.lines[1]!) as JournalEventEnvelope;
    expect(second.payload).toMatchObject({
      top_bid_px: 27526.5,
      top_ask_px: 27526.75,
      bid_levels_px: [27526.5, 27526],
      ask_levels_px: [27526.75, 27527],
      spread_points: 0.25,
      spread_ticks: 1,
    });
  });

  it('invalidates snapshots that are missing either side of top of book', () => {
    const result = runFeatures([
      mbp10Row(0n, {
        asks: [],
      }),
    ]);

    expect(result.report).toMatchObject({
      emitted_feature_snapshots: 1,
      invalid_feature_snapshots: 1,
    });
    const event = firstEvent(result);
    expect(event.payload).toMatchObject({
      top_bid_px: 27526.25,
      top_ask_px: null,
      spread_points: null,
      spread_ticks: null,
      mid_px: null,
      validity: {
        has_complete_top_of_book: false,
        spread_valid: false,
        price_ladder_valid: true,
      },
    });
  });

  it('keeps size and order count as diagnostic-only fields', () => {
    const result = runFeatures([mbp10Row(0n)]);
    const event = firstEvent(result);
    const payload = event.payload as Record<string, unknown>;
    const values = payload.values as Record<string, unknown>;

    expect(payload.diagnostic).toMatchObject({
      bid_size_diagnostic_sum: 16,
      ask_size_diagnostic_sum: 12,
      bid_order_count_diagnostic_sum: 5,
      ask_order_count_diagnostic_sum: 6,
    });
    expect(values.bid_size_diagnostic_00).toBe(10);
    expect(values.ask_order_count_diagnostic_00).toBe(4);
    expect(Object.keys(values).some((key) => /queue|ofi|imbalance/i.test(key))).toBe(false);
    expect(values.size_order_count_status).toBe('diagnostic_only');
  });

  it('skips MBO rows outside the price-state path and keeps full DATA-01B blocked', () => {
    const result = runFeatures([
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
      emitted_feature_snapshots: 1,
      skipped_mbo_rows: 1,
      data01b_full_status: 'blocked',
      diagnostic_counts: {
        'MBO:mbo_accepted_subscope_not_consumed_by_price_state_path': 1,
      },
    });
  });

  it('marks stale state using exchange time rather than sidecar receive time', () => {
    const result = runFeatures([
      mbp10Row(0n, { sidecar_recv_ts_ns: (START_TS_NS + 99_000_000_000n).toString() }),
      mbp10Row(500_000_000n, { sidecar_recv_ts_ns: (START_TS_NS + 100_000_000_000n).toString() }),
      mbp10Row(2_000_000_000n, { sidecar_recv_ts_ns: (START_TS_NS + 101_000_000_000n).toString() }),
    ]);

    const second = JSON.parse(result.lines[1]!) as JournalEventEnvelope;
    const third = JSON.parse(result.lines[2]!) as JournalEventEnvelope;
    expect(second.payload).toMatchObject({
      freshness_status: 'fresh',
      validity: { stale_mbp10_state: false },
    });
    expect(third.payload).toMatchObject({
      freshness_status: 'stale',
      validity: { stale_mbp10_state: true },
    });
  });

  it('is byte-stable across repeated runs', () => {
    const rows = [l1QuoteRow(0n), mbp10Row(1_000_000n), mbp10Row(2_000_000n)];
    const first = runFeatures(rows);
    const second = runFeatures(rows);

    expect(first.journal).toBe(second.journal);
    expect(first.report).toEqual(second.report);
  });
});
