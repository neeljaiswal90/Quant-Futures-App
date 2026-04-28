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
  const directory = mkdtempSync(join(tmpdir(), 'qfa-data01b-mbo-'));
  tempDirectories.push(directory);
  return directory;
}

function writeInput(directory: string, rows: readonly Record<string, unknown>[]): string {
  const inputPath = join(directory, 'probe.jsonl');
  writeFileSync(inputPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return inputPath;
}

function runMboLifecycle(rows: readonly Record<string, unknown>[]): {
  readonly journal: string;
  readonly report: Record<string, unknown>;
  readonly lines: readonly string[];
} {
  const directory = makeTempDir();
  const inputPath = writeInput(directory, rows);
  const outputPath = join(directory, 'mbo-order-lifecycle.jsonl');
  const reportPath = join(directory, 'report.json');
  const result = spawnSync(
    PYTHON,
    [
      '-m',
      'services.market_data_sidecar.mbo_order_lifecycle_app',
      '--input',
      inputPath,
      '--out',
      outputPath,
      '--report',
      reportPath,
      '--run-id',
      'run-data01b-mbo-test',
      '--session-id',
      '2026-04-27-rth',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );

  if (result.status !== 0) {
    throw new Error(`DATA-01B-MBO sidecar failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }

  const journal = readFileSync(outputPath, 'utf8');
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
  return {
    journal,
    report,
    lines: journal.trim().split(/\r?\n/).filter(Boolean),
  };
}

function mboRow(offsetNs: bigint, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    stream: 'MBO',
    exchange_event_ts_ns: (START_TS_NS + offsetNs).toString(),
    sidecar_recv_ts_ns: (START_TS_NS + offsetNs + 1_000_000n).toString(),
    rithmic_publish_ts_ns: (START_TS_NS + offsetNs + 500_000n).toString(),
    sequence: '9001',
    orders: [
      {
        index: 0,
        action: 'new',
        side: 'buy',
        price: 27526.25,
        size: 3,
        order_id: 'order-1',
        priority: '17',
      },
    ],
    ...overrides,
  };
}

function firstEvent(result: ReturnType<typeof runMboLifecycle>): JournalEventEnvelope {
  const event = parseTransportJournalEvent(result.lines[0]!);
  expect(validateJournalEventEnvelope(event)).toMatchObject({ ok: true, issues: [] });
  return event as JournalEventEnvelope;
}

describe('DATA-01B-MBO provider-internal order lifecycle ingestion', () => {
  it('emits OBS-01-compatible MBO lifecycle events with canonical exchange time', () => {
    const result = runMboLifecycle([mboRow(0n)]);

    expect(result.report).toMatchObject({
      input_rows: 1,
      emitted_events: 1,
      emitted_mbo_order_lifecycle_events: 1,
      mbo_status: 'accepted_subscope',
      mbo_lifecycle_status: 'accepted_subscope',
      mbo_feature_status: 'deferred_to_data02_mbo',
      data01b_full_status: 'blocked',
    });

    const event = firstEvent(result);
    expect(event.type).toBe('MICROSTRUCTURE');
    expect(event.event_id).toBe('mbo-order-lifecycle-run-data01b-mbo-test-000000000001');
    expect(event.causation_id).toBeUndefined();
    const payload = event.payload as Record<string, unknown>;
    const values = payload.values as Record<string, unknown>;

    expect(BigInt(event.ts_ns)).toBe(payload.exchange_event_ts_ns);
    expect(payload.sidecar_recv_ts_ns).not.toBe(payload.exchange_event_ts_ns);
    expect(payload).toMatchObject({
      feature_snapshot_id: 'mbo-order-lifecycle-run-data01b-mbo-test-000000000001',
      l3_authority: 'unavailable',
      source: 'mbo_order_lifecycle',
      microstructure_kind: 'mbo_order_lifecycle',
      provider: 'rithmic',
      provider_scope: 'provider_internal',
      action: 'add',
      raw_action: 'new',
      side: 'bid',
      raw_side: 'buy',
      price: 27526.25,
      size: 3,
      order_id: 'order-1',
      sequence: '9001',
      priority: '17',
      feature_availability_mask: {
        mask_id: 'feature-availability-mask-v3-adr0002-infra01e-infra01f-data04',
        field_tiers: {
          mbo_order_id: 'subscope',
          mbo_size: 'subscope',
          mbo_trade_unknown_taxonomy: 'diagnostic_only',
          queue_position: 'blocked',
        },
      },
      mbo_status: 'accepted_subscope',
      mbo_lifecycle_status: 'accepted_subscope',
      mbo_feature_status: 'deferred_to_data02_mbo',
      data01b_full_status: 'blocked',
    });
    expect(values).toMatchObject({
      source: 'mbo_order_lifecycle',
      microstructure_kind: 'mbo_order_lifecycle',
      provider_scope: 'provider_internal',
      action: 'add',
      side: 'bid',
      price: 27526.25,
      size: 3,
      has_order_id: true,
      has_sequence: true,
      feature_availability_mask_id: 'feature-availability-mask-v3-adr0002-infra01e-infra01f-data04',
      mbo_feature_status: 'deferred_to_data02_mbo',
      data01b_full_status: 'blocked',
    });
  });

  it('emits one deterministic lifecycle event per order update in a rich MBO row', () => {
    const result = runMboLifecycle([
      mboRow(0n, {
        orders: [
          { index: 0, action: 'new', side: 'buy', price: 27526.25, size: 3, order_id: 'order-1' },
          { index: 1, action: 'change', side: 'sell', price: 27526.5, size: 2, order_id: 'order-2' },
          { index: 2, action: 'delete', side: 'buy', price: 27526, size: 0, order_id: 'order-3' },
        ],
      }),
    ]);

    expect(result.report).toMatchObject({
      input_rows: 1,
      emitted_events: 3,
      emitted_mbo_order_lifecycle_events: 3,
    });
    const events = result.lines.map((line) => JSON.parse(line) as JournalEventEnvelope);
    expect(events.map((event) => event.event_id)).toEqual([
      'mbo-order-lifecycle-run-data01b-mbo-test-000000000001',
      'mbo-order-lifecycle-run-data01b-mbo-test-000000000002',
      'mbo-order-lifecycle-run-data01b-mbo-test-000000000003',
    ]);
    expect(events.map((event) => (event.payload as Record<string, unknown>).action)).toEqual(['add', 'modify', 'cancel']);
    expect(events.map((event) => (event.payload as Record<string, unknown>).side)).toEqual(['bid', 'ask', 'bid']);
    expect(events.map((event) => (event.payload as Record<string, unknown>).source_index)).toEqual([0, 1, 2]);
  });

  it('quarantines missing exchange timestamps and never uses sidecar receive time as canonical', () => {
    const result = runMboLifecycle([
      mboRow(0n, {
        exchange_event_ts_ns: null,
        sidecar_recv_ts_ns: (START_TS_NS + 999_000_000n).toString(),
      }),
      mboRow(1_000_000n, {
        sidecar_recv_ts_ns: (START_TS_NS + 999_000_000n).toString(),
      }),
    ]);

    expect(result.report).toMatchObject({
      input_rows: 2,
      emitted_events: 1,
      skipped_null_exchange_ts_rows: 1,
      diagnostic_counts: {
        'MBO:missing_exchange_event_ts_ns': 1,
      },
    });
    const event = firstEvent(result);
    expect(event.ts_ns).toBe(START_TS_NS + 1_000_000n);
    expect(event.payload).toMatchObject({
      exchange_event_ts_ns: START_TS_NS + 1_000_000n,
      sidecar_recv_ts_ns: START_TS_NS + 999_000_000n,
    });
  });

  it('skips non-MBO streams and keeps full DATA-01B blocked', () => {
    const result = runMboLifecycle([
      {
        stream: 'MBP10',
        exchange_event_ts_ns: START_TS_NS.toString(),
        sidecar_recv_ts_ns: (START_TS_NS + 1_000_000n).toString(),
        bids: [{ px: 27526.25, sz: 1 }],
      },
      {
        stream: 'LAST_TRADE',
        exchange_event_ts_ns: (START_TS_NS + 1_000_000n).toString(),
        sidecar_recv_ts_ns: (START_TS_NS + 2_000_000n).toString(),
        trade_px: 27526.25,
      },
      mboRow(2_000_000n),
    ]);

    expect(result.report).toMatchObject({
      input_rows: 3,
      emitted_events: 1,
      skipped_mbp10_rows: 1,
      skipped_non_mbo_rows: 1,
      data01b_full_status: 'blocked',
      diagnostic_counts: {
        'LAST_TRADE:non_mbo_stream': 1,
        'MBP10:mbp10_not_consumed_by_mbo_path': 1,
      },
    });
  });

  it('rejects invalid order lifecycle rows without emitting partial bad events', () => {
    const result = runMboLifecycle([
      mboRow(0n, {
        orders: [
          { action: 'trade', side: 'buy', price: 27526.25, size: 1, order_id: 'unsupported-action' },
          { action: 'new', side: 'sideways', price: 27526.25, size: 1, order_id: 'bad-side' },
          { action: 'new', side: 'buy', size: 1, order_id: 'missing-price' },
          { action: 'new', side: 'buy', price: 27526.25, order_id: 'missing-size' },
          { action: 'new', side: 'buy', price: 27526.25, size: 1 },
          { action: 'new', side: 'buy', price: 27526.25, size: 1, order_id: 'valid' },
        ],
      }),
    ]);

    expect(result.report).toMatchObject({
      input_rows: 1,
      emitted_events: 1,
      skipped_invalid_order_rows: 5,
      diagnostic_counts: {
        'MBO:missing_mbo_order_id': 1,
        'MBO:missing_mbo_price': 1,
        'MBO:missing_mbo_size': 1,
        'MBO:unsupported_mbo_action': 1,
        'MBO:unsupported_mbo_side': 1,
      },
    });
    expect(firstEvent(result).payload).toMatchObject({ order_id: 'valid' });
  });

  it('is byte-stable across repeated runs', () => {
    const rows = [
      mboRow(0n),
      mboRow(1_000_000n, {
        orders: [{ action: 'change', side: 'sell', price: 27526.5, size: 2, order_id: 'order-2' }],
      }),
    ];
    const first = runMboLifecycle(rows);
    const second = runMboLifecycle(rows);

    expect(first.journal).toBe(second.journal);
    expect(first.report).toEqual(second.report);
  });

  it('documents the MBO sub-scope without promoting full DATA-01B', () => {
    const doc = readFileSync('docs/data/DATA-01B-MBO.md', 'utf8');

    expect(doc).toContain('mbo_lifecycle_status = accepted_subscope');
    expect(doc).toContain('mbo_feature_status = deferred_to_data02_mbo');
    expect(doc).toContain('data01b_full_status = blocked');
    expect(doc).toContain('Full DATA-01B');
    expect(doc).not.toMatch(/full DATA-01B (?:is )?(?:passed|eligible|unblocked)/i);
  });
});
