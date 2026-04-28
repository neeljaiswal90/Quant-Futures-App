import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateJournalEventEnvelope, type JournalEventEnvelope } from '../../src/contracts/index.js';
import { parseTransportJournalEvent } from '../../src/transport/index.js';

const PYTHON = process.env.PYTHON ?? 'python';
const START_TS_NS = 1_777_301_421_588_943_700n;
const MASK_ID = 'feature-availability-mask-v2-adr0002-infra01e-infra01f-data02mbo';
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-data02-mbo-'));
  tempDirectories.push(directory);
  return directory;
}

function writeInput(directory: string, rows: readonly Record<string, unknown>[]): string {
  const inputPath = join(directory, 'input.jsonl');
  writeFileSync(inputPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return inputPath;
}

function runBookState(rows: readonly Record<string, unknown>[]): {
  readonly journal: string;
  readonly report: Record<string, unknown>;
  readonly lines: readonly string[];
} {
  const directory = makeTempDir();
  const inputPath = writeInput(directory, rows);
  const outputPath = join(directory, 'mbo-book-state.jsonl');
  const reportPath = join(directory, 'report.json');
  const result = spawnSync(
    PYTHON,
    [
      '-m',
      'services.market_data_sidecar.mbo_book_state_app',
      '--input',
      inputPath,
      '--out',
      outputPath,
      '--report',
      reportPath,
      '--run-id',
      'run-data02-mbo-test',
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
    throw new Error(`DATA-02-MBO book-state builder failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }

  const journal = readFileSync(outputPath, 'utf8');
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
  return {
    journal,
    report,
    lines: journal.trim().split(/\r?\n/).filter(Boolean),
  };
}

function lifecycleEventRow(
  offsetNs: bigint,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const exchangeTsNs = (START_TS_NS + offsetNs).toString();
  const eventId = `mbo-order-lifecycle-source-${offsetNs.toString()}`;
  return {
    schema_version: 1,
    event_id: eventId,
    type: 'MICROSTRUCTURE',
    ts_ns: exchangeTsNs,
    run_id: 'run-data01b-mbo-source',
    session_id: '2026-04-27-rth',
    payload: {
      exchange_event_ts_ns: exchangeTsNs,
      sidecar_recv_ts_ns: (START_TS_NS + offsetNs + 1_000_000n).toString(),
      feature_snapshot_id: eventId,
      l3_authority: 'unavailable',
      source: 'mbo_order_lifecycle',
      microstructure_kind: 'mbo_order_lifecycle',
      provider: 'rithmic',
      provider_scope: 'provider_internal',
      action: 'add',
      side: 'bid',
      price: 27526.25,
      size: 3,
      order_id: 'order-1',
      sequence: '9001',
      priority: '17',
      values: {},
      mbo_status: 'accepted_subscope',
      mbo_lifecycle_status: 'accepted_subscope',
      mbo_feature_status: 'deferred_to_data02_mbo',
      data01b_full_status: 'blocked',
      ...overrides,
    },
  };
}

function rawMboRow(offsetNs: bigint): Record<string, unknown> {
  return {
    schema_version: 1,
    stream: 'MBO',
    exchange_event_ts_ns: (START_TS_NS + offsetNs).toString(),
    sidecar_recv_ts_ns: (START_TS_NS + offsetNs + 1_000_000n).toString(),
    orders: [
      {
        index: 0,
        action: 'new',
        side: 'sell',
        price: 27526.5,
        size: 4,
        order_id: 'ask-1',
      },
    ],
  };
}

function eventAt(result: ReturnType<typeof runBookState>, index: number): JournalEventEnvelope {
  const event = parseTransportJournalEvent(result.lines[index]!);
  expect(validateJournalEventEnvelope(event)).toMatchObject({ ok: true, issues: [] });
  return event as JournalEventEnvelope;
}

describe('DATA-02-MBO provider-internal book state', () => {
  it('builds FIFO price-level book state and emits queue estimates from lifecycle events', () => {
    const result = runBookState([
      lifecycleEventRow(0n, { order_id: 'bid-1', side: 'bid', price: 27526.25, size: 5 }),
      lifecycleEventRow(1_000_000n, { order_id: 'bid-2', side: 'bid', price: 27526.25, size: 3 }),
      lifecycleEventRow(2_000_000n, { order_id: 'ask-1', side: 'ask', price: 27526.5, size: 4 }),
    ]);

    expect(result.report).toMatchObject({
      input_rows: 3,
      consumed_mbo_lifecycle_events: 3,
      emitted_book_state_snapshots: 3,
      active_orders: 3,
      bid_level_count: 1,
      ask_level_count: 1,
      mbo_book_state_status: 'accepted_subscope',
      queue_position_status: 'provider_internal_estimate',
      data01b_full_status: 'blocked',
    });

    const second = eventAt(result, 1);
    const secondPayload = second.payload as Record<string, unknown>;
    expect(second.causation_id).toBe('mbo-order-lifecycle-source-1000000');
    expect(secondPayload).toMatchObject({
      source_event_id: 'mbo-order-lifecycle-source-1000000',
      source: 'mbo_order_book_state',
      microstructure_kind: 'mbo_order_book_state',
      order_id: 'bid-2',
      queue: {
        queue_position_estimate: 1,
        queue_ahead_order_count_estimate: 1,
        queue_ahead_size_estimate: 5,
        level_order_count_subscope: 2,
        level_aggregate_size_subscope: 8,
        queue_position_as_fact_available: false,
      },
      bid_levels: [{ px: 27526.25, aggregate_size_subscope: 8, order_count_subscope: 2 }],
      feature_availability_mask: {
        mask_id: MASK_ID,
        field_tiers: {
          mbo_book_state: 'subscope',
          queue_position_estimate: 'subscope',
          queue_position_as_fact: 'blocked',
        },
      },
    });

    const third = eventAt(result, 2);
    const thirdPayload = third.payload as Record<string, unknown>;
    const values = thirdPayload.values as Record<string, unknown>;
    expect(BigInt(third.ts_ns)).toBe(thirdPayload.exchange_event_ts_ns);
    expect(thirdPayload.sidecar_recv_ts_ns).not.toBe(thirdPayload.exchange_event_ts_ns);
    expect(thirdPayload).toMatchObject({
      top_bid_px: 27526.25,
      top_ask_px: 27526.5,
      spread_points: 0.25,
      spread_ticks: 1,
      mid_px: 27526.375,
      active_order_count: 3,
      validity: {
        provider_internal_scope: true,
        has_complete_top_of_book: true,
        queue_position_estimate_available: true,
        queue_position_as_fact_available: false,
        l2_l3_scope: 'mbo_provider_internal',
      },
    });
    expect(values).toMatchObject({
      source: 'mbo_order_book_state',
      active_order_count: 3,
      bid_level_count: 1,
      ask_level_count: 1,
      queue_position_estimate: 0,
      feature_availability_mask_id: MASK_ID,
      data01b_full_status: 'blocked',
    });
  });

  it('updates and cancels orders before emitting the snapshot', () => {
    const result = runBookState([
      lifecycleEventRow(0n, { order_id: 'bid-1', side: 'bid', price: 27526.25, size: 5 }),
      lifecycleEventRow(1_000_000n, { order_id: 'bid-2', side: 'bid', price: 27526.25, size: 3 }),
      lifecycleEventRow(2_000_000n, { action: 'modify', order_id: 'bid-1', side: 'bid', price: 27526.25, size: 2 }),
      lifecycleEventRow(3_000_000n, { action: 'cancel', order_id: 'bid-1', side: 'bid', price: 27526.25, size: 0 }),
    ]);

    expect(result.report).toMatchObject({
      emitted_book_state_snapshots: 4,
      active_orders: 1,
      bid_level_count: 1,
      missing_state_update_count: 0,
    });
    expect(eventAt(result, 2).payload).toMatchObject({
      order_id: 'bid-1',
      size: 2,
      queue: {
        queue_position_estimate: 0,
        level_aggregate_size_subscope: 5,
      },
      bid_levels: [{ px: 27526.25, aggregate_size_subscope: 5, order_count_subscope: 2 }],
    });
    expect(eventAt(result, 3).payload).toMatchObject({
      order_id: 'bid-1',
      order_active: false,
      queue: {
        queue_position_estimate: null,
        queue_position_as_fact_available: false,
      },
      bid_levels: [{ px: 27526.25, aggregate_size_subscope: 3, order_count_subscope: 1 }],
    });
  });

  it('can consume rich MBO probe rows directly without inventing causation', () => {
    const result = runBookState([rawMboRow(0n)]);

    expect(result.report).toMatchObject({
      input_rows: 1,
      consumed_mbo_lifecycle_events: 1,
      emitted_book_state_snapshots: 1,
    });
    const event = eventAt(result, 0);
    expect(event.causation_id).toBeUndefined();
    expect(event.payload).toMatchObject({
      order_id: 'ask-1',
      side: 'ask',
      price: 27526.5,
      active_order_count: 1,
      ask_level_count: 1,
    });
  });

  it('diagnoses non-lifecycle rows and invalid lifecycle payloads without promoting full DATA-01B', () => {
    const result = runBookState([
      { stream: 'MBP10', exchange_event_ts_ns: START_TS_NS.toString() },
      lifecycleEventRow(1_000_000n, { order_id: '', side: 'bid', price: 27526.25, size: 3 }),
      lifecycleEventRow(2_000_000n, { order_id: 'valid', side: 'bid', price: 27526.25, size: 3 }),
    ]);

    expect(result.report).toMatchObject({
      input_rows: 3,
      emitted_book_state_snapshots: 1,
      skipped_non_mbo_lifecycle_rows: 1,
      skipped_invalid_lifecycle_rows: 1,
      data01b_full_status: 'blocked',
      diagnostic_counts: {
        'MBO:mbo lifecycle payload missing order_id': 1,
        'MBP10:mbp10_not_consumed_by_mbo_book_state_path': 1,
      },
    });
  });

  it('is byte-stable across repeated runs', () => {
    const rows = [
      lifecycleEventRow(0n, { order_id: 'bid-1', side: 'bid', price: 27526.25, size: 5 }),
      lifecycleEventRow(1_000_000n, { order_id: 'ask-1', side: 'ask', price: 27526.5, size: 4 }),
    ];
    const first = runBookState(rows);
    const second = runBookState(rows);

    expect(first.journal).toBe(second.journal);
    expect(first.report).toEqual(second.report);
  });

  it('documents provider-internal scope while keeping hard queue facts and full DATA-01B blocked', () => {
    const doc = readFileSync('docs/data/DATA-02-MBO.md', 'utf8');

    expect(doc).toContain('mbo_book_state_status = accepted_subscope');
    expect(doc).toContain('queue_position_status = provider_internal_estimate');
    expect(doc).toContain('queue_position_as_fact_available = false');
    expect(doc).toContain('data01b_full_status = blocked');
    expect(doc).not.toMatch(/full DATA-01B (?:is )?(?:passed|eligible|unblocked)/i);
  });
});
