import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  journalEventFromJsonLine,
  validateJournalEventEnvelope,
  type JournalEventEnvelope,
} from '../../src/contracts/index.js';

const PYTHON = process.env.PYTHON ?? 'python';
const START_TS_NS = 1_777_301_421_588_943_700n;
const MASK_ID = 'feature-availability-mask-v5-adr0003-data-mbo03-advisory-policy';
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-data04-'));
  tempDirectories.push(directory);
  return directory;
}

function writeInput(directory: string, rows: readonly Record<string, unknown>[]): string {
  const inputPath = join(directory, 'input.jsonl');
  writeFileSync(inputPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return inputPath;
}

function runMicrostructureFeatures(rows: readonly Record<string, unknown>[]): {
  readonly journal: string;
  readonly report: Record<string, unknown>;
  readonly lines: readonly string[];
} {
  const directory = makeTempDir();
  const inputPath = writeInput(directory, rows);
  const outputPath = join(directory, 'microstructure-features.jsonl');
  const reportPath = join(directory, 'report.json');
  const result = spawnSync(
    PYTHON,
    [
      '-m',
      'services.market_data_sidecar.microstructure_features_app',
      '--input',
      inputPath,
      '--out',
      outputPath,
      '--report',
      reportPath,
      '--run-id',
      'run-data04-test',
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
    throw new Error(`DATA-04 feature engine failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }

  const journal = readFileSync(outputPath, 'utf8');
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
  return {
    journal,
    report,
    lines: journal.trim().split(/\r?\n/).filter(Boolean),
  };
}

function priceStateRow(offsetNs: bigint): Record<string, unknown> {
  const ts = (START_TS_NS + offsetNs).toString();
  const eventId = `price-state-source-${offsetNs}`;
  return {
    schema_version: 1,
    event_id: eventId,
    type: 'MICROSTRUCTURE',
    ts_ns: ts,
    run_id: 'run-data02-ps-source',
    session_id: '2026-04-27-rth',
    payload: {
      feature_snapshot_id: eventId,
      exchange_event_ts_ns: ts,
      sidecar_recv_ts_ns: (START_TS_NS + offsetNs + 1_000_000n).toString(),
      source: 'mbp10_price_state',
      top_bid_px: 27526.25,
      top_ask_px: 27526.5,
      spread_points: 0.25,
      spread_ticks: 1,
      mid_px: 27526.375,
      values: {},
      mbp10_price_state_status: 'accepted_subscope',
      data01b_full_status: 'blocked',
    },
  };
}

function mboBookStateRow(offsetNs: bigint, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const ts = (START_TS_NS + offsetNs).toString();
  const eventId = `mbo-book-state-source-${offsetNs}`;
  return {
    schema_version: 1,
    event_id: eventId,
    type: 'MICROSTRUCTURE',
    ts_ns: ts,
    run_id: 'run-data02-mbo-source',
    session_id: '2026-04-27-rth',
    payload: {
      feature_snapshot_id: eventId,
      exchange_event_ts_ns: ts,
      sidecar_recv_ts_ns: (START_TS_NS + offsetNs + 1_000_000n).toString(),
      source: 'mbo_order_book_state',
      microstructure_kind: 'mbo_order_book_state',
      top_bid_px: 27526.25,
      top_ask_px: 27526.5,
      bid_levels: [
        { px: 27526.25, aggregate_size_subscope: 10, order_count_subscope: 2 },
        { px: 27526, aggregate_size_subscope: 4, order_count_subscope: 1 },
      ],
      ask_levels: [
        { px: 27526.5, aggregate_size_subscope: 6, order_count_subscope: 2 },
        { px: 27526.75, aggregate_size_subscope: 2, order_count_subscope: 1 },
      ],
      queue: {
        queue_position_estimate: 1,
        queue_ahead_order_count_estimate: 1,
        queue_ahead_size_estimate: 5,
        level_order_count_subscope: 2,
        level_aggregate_size_subscope: 10,
        queue_position_as_fact_available: false,
      },
      values: {},
      mbo_status: 'accepted_subscope',
      mbo_book_state_status: 'accepted_subscope',
      queue_position_status: 'provider_internal_estimate',
      data01b_full_status: 'blocked',
      ...overrides,
    },
  };
}

function tradeRow(offsetNs: bigint, side: 'buy' | 'sell', size: number): Record<string, unknown> {
  const ts = (START_TS_NS + offsetNs).toString();
  const eventId = `trade-source-${offsetNs}`;
  return {
    schema_version: 1,
    event_id: eventId,
    type: 'TRADE',
    ts_ns: ts,
    run_id: 'run-data01a-source',
    session_id: '2026-04-27-rth',
    payload: {
      exchange_event_ts_ns: ts,
      sidecar_recv_ts_ns: (START_TS_NS + offsetNs + 1_000_000n).toString(),
      price: 27526.5,
      size,
      aggressor_side: side,
    },
  };
}

function eventAt(result: ReturnType<typeof runMicrostructureFeatures>, index: number): JournalEventEnvelope {
  const event = journalEventFromJsonLine(result.lines[index]!);
  expect(validateJournalEventEnvelope(event)).toMatchObject({ ok: true, issues: [] });
  return event;
}

describe('DATA-04 tier-aware microstructure feature engine', () => {
  it('derives tier-clean features from price-state, MBO book state, and trades', () => {
    const result = runMicrostructureFeatures([
      priceStateRow(0n),
      mboBookStateRow(1_000_000n),
      mboBookStateRow(2_000_000n, {
        bid_levels: [
          { px: 27526.25, aggregate_size_subscope: 12, order_count_subscope: 3 },
          { px: 27526, aggregate_size_subscope: 4, order_count_subscope: 1 },
        ],
        ask_levels: [
          { px: 27526.5, aggregate_size_subscope: 5, order_count_subscope: 2 },
          { px: 27526.75, aggregate_size_subscope: 2, order_count_subscope: 1 },
        ],
      }),
      tradeRow(3_000_000n, 'buy', 4),
      tradeRow(4_000_000n, 'sell', 1),
    ]);

    expect(result.report).toMatchObject({
      input_rows: 5,
      emitted_feature_snapshots: 5,
      price_state_inputs: 1,
      mbo_book_state_inputs: 2,
      trade_inputs: 2,
      microstructure_feature_status: 'accepted_tiered',
      blocked_feature_status: 'blocked_by_feature_availability_mask',
      data01b_full_status: 'blocked',
      sim_status: 'blocked',
      rel_status: 'blocked',
    });
    expect(result.report.feature_tier_counts).toMatchObject({
      authoritative: 20,
      subscope: 40,
    });

    const event = eventAt(result, 4);
    expect(event.type).toBe('FEATURES');
    expect(event.event_id).toBe('microstructure-features-run-data04-test-000000000005');
    expect(event.causation_id).toBe('trade-source-4000000');
    const payload = event.payload as Record<string, unknown>;
    const values = payload.values as Record<string, unknown>;

    expect(BigInt(event.ts_ns)).toBe(payload.exchange_event_ts_ns);
    expect(payload).toMatchObject({
      microstructure_feature_schema_version: 1,
      feature_snapshot_id: 'microstructure-features-run-data04-test-000000000005',
      source: 'microstructure_feature_engine',
      trigger_kind: 'trade',
      source_event_id: 'trade-source-4000000',
      source_event_ids: ['price-state-source-0', 'mbo-book-state-source-2000000', 'trade-source-4000000'],
      feature_availability_mask: {
        mask_id: MASK_ID,
        field_tiers: {
          microstructure_spread_ticks: 'authoritative',
          mbo_ofi_short: 'subscope',
          queue_position_as_fact: 'blocked',
        },
      },
      feature_tiers: {
        spread_points: 'authoritative',
        spread_ticks: 'authoritative',
        mid_px: 'authoritative',
        top_of_book_imbalance: 'subscope',
        microprice_offset_ticks: 'subscope',
        ofi_short: 'subscope',
        ofi_medium: 'subscope',
        ofi_blend: 'subscope',
        trade_aggressor_imbalance: 'authoritative',
        recent_depth_imbalance: 'subscope',
        queue_imbalance: 'subscope',
      },
      blocked_features: ['queue_position', 'queue_position_as_fact', 'order_lifetime', 'cancel_add_ratio', 'absorption', 'sweep'],
      blocked_feature_tiers: {
        queue_position: 'blocked',
        queue_position_as_fact: 'blocked',
      },
      validity: {
        has_price_state: true,
        has_mbo_book_state: true,
        has_trade_aggressor_window: true,
        queue_position_as_fact_available: false,
        blocked_features_not_emitted: true,
      },
    });
    expect(values).toMatchObject({
      spread_points: 0.25,
      spread_ticks: 1,
      mid_px: 27526.375,
      top_of_book_imbalance: 0.4117647058823529,
      ofi_short: 3,
      ofi_medium: 3,
      ofi_blend: 3,
      trade_aggressor_imbalance: 0.6,
      recent_depth_imbalance: 0.391304347826087,
      queue_ahead_fraction_estimate: 0.5,
      queue_imbalance: 0,
      spread_points_tier: 'authoritative',
      top_of_book_imbalance_tier: 'subscope',
      queue_position_tier: 'blocked',
      feature_availability_mask_id: MASK_ID,
      data01b_full_status: 'blocked',
      sim_status: 'blocked',
      rel_status: 'blocked',
    });
    expect(Number(values.microprice_offset_ticks)).toBeCloseTo(0.205882352941, 10);
    expect(values).not.toHaveProperty('queue_position');
    expect(values).not.toHaveProperty('absorption');
    expect(values).not.toHaveProperty('sweep');
  });

  it('keeps deterministic output and reports unsupported inputs as diagnostics', () => {
    const rows = [
      { schema_version: 1, stream: 'MBP10', exchange_event_ts_ns: START_TS_NS.toString() },
      priceStateRow(0n),
      mboBookStateRow(1_000_000n),
    ];
    const first = runMicrostructureFeatures(rows);
    const second = runMicrostructureFeatures(rows);

    expect(first.journal).toBe(second.journal);
    expect(first.report).toEqual(second.report);
    expect(first.report).toMatchObject({
      input_rows: 3,
      emitted_feature_snapshots: 2,
      skipped_rows: 1,
      diagnostic_counts: {
        'MBP10:unsupported_microstructure_feature_input': 1,
      },
      data01b_full_status: 'blocked',
    });
  });

  it('propagates the strictest input tier for mixed price/size features', () => {
    const result = runMicrostructureFeatures([mboBookStateRow(0n)]);
    const event = eventAt(result, 0);
    const payload = event.payload as Record<string, unknown>;
    const values = payload.values as Record<string, unknown>;

    expect(payload.feature_tiers).toMatchObject({
      spread_points: 'authoritative',
      microprice_offset_ticks: 'subscope',
      top_of_book_imbalance: 'subscope',
    });
    expect(values).toMatchObject({
      spread_points: null,
      spread_ticks: null,
      mid_px: null,
      top_of_book_imbalance: 0.25,
      microprice_offset_ticks: 0.125,
      spread_points_tier: 'authoritative',
      microprice_offset_ticks_tier: 'subscope',
      top_of_book_imbalance_tier: 'subscope',
    });
  });

  it('documents tier boundaries while keeping SIM, RSRCH, and REL blocked', () => {
    const doc = readFileSync('docs/data/DATA-04-MICROSTRUCTURE-FEATURES.md', 'utf8');

    expect(doc).toContain('microstructure_feature_status = accepted_tiered');
    expect(doc).toContain('authoritative');
    expect(doc).toContain('subscope');
    expect(doc).toContain('diagnostic_only');
    expect(doc).toContain('queue_position_as_fact = blocked');
    expect(doc).toContain('SIM-02/SIM-03 remain blocked');
    expect(doc).not.toMatch(/full DATA-01B (?:is )?(?:passed|eligible|unblocked)/i);
  });
});
