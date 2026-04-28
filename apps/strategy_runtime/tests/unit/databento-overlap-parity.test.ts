import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeDatabentoOverlapParity,
  compareMbp10Samples,
  reconstructRithmicMbp10FromRecords,
  writeDatabentoOverlapParityReport,
  type BookSample,
} from '../../../../scripts/infra/analyze-databento-overlap-parity.js';

const START_TS_NS = 1_777_300_000_000_000_000n;
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-databento-parity-'));
  tempDirectories.push(directory);
  return directory;
}

function mbp10Record(
  offsetNs: bigint | null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    stream: 'MBP10',
    exchange_event_ts_ns: offsetNs === null ? null : (START_TS_NS + offsetNs).toString(),
    sidecar_recv_ts_ns: (START_TS_NS + (offsetNs ?? 0n) + 1_000_000n).toString(),
    payload_kind: 'MBP10',
    ...overrides,
  };
}

function databentoRecord(offsetNs: bigint, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts_event_ns: (START_TS_NS + offsetNs).toString(),
    ...overrides,
  };
}

function seedRow(): Record<string, unknown> {
  return mbp10Record(null, {
    bids: [{ level: 0, px: 100, sz: 5, order_count: 2 }],
    asks: [{ level: 0, px: 101, sz: 7, order_count: 3 }],
  });
}

function checkpointRow(offsetNs = 500_000n): Record<string, unknown> {
  return mbp10Record(offsetNs, {
    bids: [{ level: 0, px: 100, sz: 5, order_count: 2 }],
    asks: [{ level: 0, px: 101, sz: 7, order_count: 3 }],
  });
}

function writeJsonl(rows: readonly Record<string, unknown>[], fileName: string): string {
  const directory = makeTempDir();
  const path = join(directory, fileName);
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return path;
}

describe('Databento overlap parity MBP10 reconstruction', () => {
  it('applies an incremental bid-only update without changing the ask side', () => {
    const result = reconstructRithmicMbp10FromRecords([
      seedRow(),
      mbp10Record(1_000_000n, {
        bids: [{ level: 0, px: 100.25, sz: 8, order_count: 4 }],
      }),
    ]);

    expect(result.report).toMatchObject({
      null_timestamp_rows_count: 1,
      null_timestamp_seed_rows_count: 1,
      incremental_update_rows_count: 1,
      bid_only_update_rows_count: 1,
      reconstructed_book_sample_count: 1,
    });
    expect(result.samples[0]?.bids).toEqual([
      { level: 0, px: 100.25, sz: 8, order_count: 4 },
      { level: 1, px: 100, sz: 5, order_count: 2 },
    ]);
    expect(result.samples[0]?.asks).toEqual([{ level: 0, px: 101, sz: 7, order_count: 3 }]);
  });

  it('keys Rithmic price-level updates by price instead of treating source index as depth', () => {
    const result = reconstructRithmicMbp10FromRecords([
      seedRow(),
      mbp10Record(1_000_000n, {
        bids: [{ level: 0, px: 99.75, sz: 8, order_count: 4 }],
      }),
    ]);

    expect(result.samples[0]?.bids).toEqual([
      { level: 0, px: 100, sz: 5, order_count: 2 },
      { level: 1, px: 99.75, sz: 8, order_count: 4 },
    ]);
  });

  it('reconstructs Rithmic MBP10 timestamped updates in exchange-time order', () => {
    const result = reconstructRithmicMbp10FromRecords([
      seedRow(),
      mbp10Record(2_000_000n, {
        bids: [{ level: 0, px: 100.25, sz: 8, order_count: 4 }],
      }),
      mbp10Record(1_000_000n, {
        bids: [{ level: 0, px: 100, sz: 0, order_count: 0 }],
      }),
    ]);

    expect(result.samples.map((sample) => sample.ts_ns)).toEqual([
      (START_TS_NS + 1_000_000n).toString(),
      (START_TS_NS + 2_000_000n).toString(),
    ]);
    expect(result.samples[0]?.bids).toEqual([]);
    expect(result.samples[1]?.bids).toEqual([
      { level: 0, px: 100.25, sz: 8, order_count: 4 },
    ]);
  });

  it('deletes a price level when Rithmic sends a zero-size update', () => {
    const result = reconstructRithmicMbp10FromRecords([
      seedRow(),
      mbp10Record(1_000_000n, {
        bids: [{ level: 0, px: 100, sz: 0, order_count: 0 }],
      }),
    ]);

    expect(result.samples[0]?.bids).toEqual([]);
    expect(result.samples[0]?.asks).toEqual([{ level: 0, px: 101, sz: 7, order_count: 3 }]);
  });

  it('applies an incremental ask-only update without changing the bid side', () => {
    const result = reconstructRithmicMbp10FromRecords([
      seedRow(),
      mbp10Record(1_000_000n, {
        asks: [{ level: 0, px: 100.75, sz: 9, order_count: 5 }],
      }),
    ]);

    expect(result.report).toMatchObject({
      ask_only_update_rows_count: 1,
      reconstructed_book_sample_count: 1,
    });
    expect(result.samples[0]?.bids).toEqual([{ level: 0, px: 100, sz: 5, order_count: 2 }]);
    expect(result.samples[0]?.asks).toEqual([
      { level: 0, px: 100.75, sz: 9, order_count: 5 },
      { level: 1, px: 101, sz: 7, order_count: 3 },
    ]);
  });

  it('uses null-timestamp book rows as seed state while excluding them from timestamped samples', () => {
    const result = reconstructRithmicMbp10FromRecords([
      seedRow(),
      mbp10Record(null, {}),
      mbp10Record(1_000_000n, {
        bids: [{ level: 1, px: 99.75, sz: 2, order_count: 1 }],
      }),
    ]);

    expect(result.report).toMatchObject({
      null_timestamp_rows_count: 2,
      null_timestamp_seed_rows_count: 1,
      null_timestamp_non_seed_rows_count: 1,
      reconstructed_book_sample_count: 1,
    });
    expect(result.samples[0]?.ts_ns).toBe((START_TS_NS + 1_000_000n).toString());
    expect(result.samples[0]?.bids).toEqual([
      { level: 0, px: 100, sz: 5, order_count: 2 },
      { level: 1, px: 99.75, sz: 2, order_count: 1 },
    ]);
  });

  it('compares reconstructed Rithmic state against Databento MBP10 samples', () => {
    const rithmic = reconstructRithmicMbp10FromRecords([
      seedRow(),
      mbp10Record(1_000_000n, {
        bids: [{ level: 0, px: 100.25, sz: 8, order_count: 4 }],
      }),
    ]);
    const databento: BookSample[] = [
      {
        ts_ns: (START_TS_NS + 2_000_000n).toString(),
        source_record_index: 1,
        bids: [
          { level: 0, px: 100.25, sz: 8, order_count: 4 },
          { level: 1, px: 100, sz: 5, order_count: 2 },
        ],
        asks: [{ level: 0, px: 101, sz: 7, order_count: 3 }],
      },
    ];

    const report = compareMbp10Samples(rithmic.samples, databento);

    expect(report).toMatchObject({
      compared_sample_count: 1,
      unmatched_databento_sample_count: 0,
      top_of_book: {
        comparable_field_count: 6,
        matching_field_count: 6,
        mismatch_count: 0,
      },
      depth_levels: {
        comparable_field_count: 9,
        matching_field_count: 9,
        mismatch_count: 0,
      },
    });
  });

  it('does not assume each Rithmic MBP10 row is a complete snapshot', () => {
    const rithmicPath = writeJsonl(
      [
        seedRow(),
        mbp10Record(1_000_000n, {
          bids: [{ level: 0, px: 100.25, sz: 8, order_count: 4 }],
        }),
      ],
      'rithmic.jsonl',
    );
    const databentoPath = writeJsonl(
      [
        databentoRecord(2_000_000n, {
          bid_px_00: 100.25,
          bid_sz_00: 8,
          bid_ct_00: 4,
          bid_px_01: 100,
          bid_sz_01: 5,
          bid_ct_01: 2,
          ask_px_00: 101,
          ask_sz_00: 7,
          ask_ct_00: 3,
        }),
      ],
      'databento.jsonl',
    );

    const report = analyzeDatabentoOverlapParity({
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoPath,
    });

    expect(report).toMatchObject({
      status: 'analysis_only',
      data01_eligible: false,
      rithmic_mbp10_reconstruction: {
        null_timestamp_seed_rows_count: 1,
        bid_only_update_rows_count: 1,
        reconstructed_book_sample_count: 1,
      },
      mbp10_parity: {
        compared_sample_count: 1,
        top_of_book: {
          comparable_field_count: 6,
          matching_field_count: 6,
          mismatch_count: 0,
        },
      },
      mbp10_component_parity: {
        compared_samples: 1,
        classification: 'mbp10_parity_component_pass',
        top_of_book: {
          both_sides_price_within_1_tick_pct: 100,
          bid_size_exact_match_pct: 100,
          ask_size_exact_match_pct: 100,
        },
      },
      recommendation: {
        databento_parity_status_for_infra01b: 'pending',
      },
    });
  });

  it('classifies matching prices with size mismatch as size/order-count semantics mismatch', () => {
    const rithmicPath = writeJsonl([seedRow(), checkpointRow()], 'rithmic.jsonl');
    const databentoPath = writeJsonl(
      [
        databentoRecord(1_000_000n, {
          bid_px_00: 100,
          bid_sz_00: 6,
          bid_ct_00: 2,
          ask_px_00: 101,
          ask_sz_00: 9,
          ask_ct_00: 3,
        }),
      ],
      'databento.jsonl',
    );

    const report = analyzeDatabentoOverlapParity({
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoPath,
    });

    expect(report.mbp10_component_parity).toMatchObject({
      classification: 'size_order_count_semantics_mismatch',
      top_of_book: {
        bid_price_within_1_tick_pct: 100,
        ask_price_within_1_tick_pct: 100,
        both_sides_price_within_1_tick_pct: 100,
        bid_size_exact_match_pct: 0,
        ask_size_exact_match_pct: 0,
      },
      mismatch_breakdown: {
        size_only_mismatch_count: 2,
        price_only_mismatch_count: 0,
      },
    });
    expect(report.mbp10_component_parity.first_mismatches.size_mismatches[0]).toMatchObject({
      exchange_event_ts_ns: (START_TS_NS + 1_000_000n).toString(),
      side: 'bid',
      level: 0,
      rithmic_size: 5,
      databento_size: 6,
      classification: 'size_mismatch',
    });
  });

  it('classifies low price parity as price-level reconstruction mismatch', () => {
    const rithmicPath = writeJsonl([seedRow(), checkpointRow()], 'rithmic.jsonl');
    const databentoPath = writeJsonl(
      [
        databentoRecord(1_000_000n, {
          bid_px_00: 99,
          bid_sz_00: 5,
          bid_ct_00: 2,
          ask_px_00: 102,
          ask_sz_00: 7,
          ask_ct_00: 3,
        }),
      ],
      'databento.jsonl',
    );

    const report = analyzeDatabentoOverlapParity({
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoPath,
    });

    expect(report.mbp10_component_parity).toMatchObject({
      classification: 'price_level_reconstruction_mismatch',
      top_of_book: {
        both_sides_price_within_1_tick_pct: 0,
      },
      mismatch_breakdown: {
        price_only_mismatch_count: 2,
      },
    });
    expect(report.mbp10_component_parity.first_mismatches.price_mismatches).toHaveLength(2);
  });

  it('separates order-count-only mismatch from price mismatch', () => {
    const rithmicPath = writeJsonl([seedRow(), checkpointRow()], 'rithmic.jsonl');
    const databentoPath = writeJsonl(
      [
        databentoRecord(1_000_000n, {
          bid_px_00: 100,
          bid_sz_00: 5,
          bid_ct_00: 4,
          ask_px_00: 101,
          ask_sz_00: 7,
          ask_ct_00: 6,
        }),
      ],
      'databento.jsonl',
    );

    const report = analyzeDatabentoOverlapParity({
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoPath,
    });

    expect(report.mbp10_component_parity).toMatchObject({
      classification: 'size_order_count_semantics_mismatch',
      mismatch_breakdown: {
        order_count_only_mismatch_count: 2,
        price_only_mismatch_count: 0,
        size_only_mismatch_count: 0,
      },
    });
    expect(report.mbp10_component_parity.first_mismatches.order_count_mismatches[0]).toMatchObject({
      side: 'bid',
      level: 0,
      rithmic_order_count: 2,
      databento_order_count: 4,
      classification: 'order_count_mismatch',
    });
  });

  it('counts missing levels separately from component mismatches', () => {
    const rithmicPath = writeJsonl([seedRow(), checkpointRow()], 'rithmic.jsonl');
    const databentoPath = writeJsonl(
      [
        databentoRecord(1_000_000n, {
          bids: Array.from({ length: 10 }, (_, level) => ({
            level,
            px: 100 - level * 0.25,
            sz: 5,
            order_count: 2,
          })),
          asks: Array.from({ length: 10 }, (_, level) => ({
            level,
            px: 101 + level * 0.25,
            sz: 7,
            order_count: 3,
          })),
        }),
      ],
      'databento.jsonl',
    );

    const report = analyzeDatabentoOverlapParity({
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoPath,
    });

    expect(report.mbp10_component_parity).toMatchObject({
      classification: 'book_depth_presence_mismatch',
      mismatch_breakdown: {
        missing_level_count: 18,
      },
    });
    expect(report.mbp10_component_parity.first_mismatches.level_presence_mismatches[0]).toMatchObject({
      side: 'bid',
      level: 1,
      rithmic_px: null,
      databento_px: 99.75,
      classification: 'level_presence_mismatch',
    });
  });

  it('emits deterministic depth-by-level component summaries and first mismatch samples', () => {
    const rithmicPath = writeJsonl(
      [
        seedRow(),
        mbp10Record(1_000_000n, {
          bids: [{ level: 0, px: 99.75, sz: 4, order_count: 2 }],
        }),
      ],
      'rithmic.jsonl',
    );
    const databentoPath = writeJsonl(
      [
        databentoRecord(2_000_000n, {
          bid_px_00: 100,
          bid_sz_00: 5,
          bid_ct_00: 2,
          bid_px_01: 99.75,
          bid_sz_01: 6,
          bid_ct_01: 2,
          ask_px_00: 101,
          ask_sz_00: 7,
          ask_ct_00: 3,
        }),
      ],
      'databento.jsonl',
    );

    const report = analyzeDatabentoOverlapParity({
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoPath,
    });

    expect(report.mbp10_component_parity.depth_by_level.slice(0, 4)).toMatchObject([
      {
        level: 0,
        side: 'ask',
        compared_count: 1,
        price_within_1_tick_pct: 100,
        size_exact_match_pct: 100,
      },
      {
        level: 0,
        side: 'bid',
        compared_count: 1,
        price_within_1_tick_pct: 100,
        size_exact_match_pct: 100,
      },
      {
        level: 1,
        side: 'ask',
        compared_count: 1,
        presence_match_pct: 100,
      },
      {
        level: 1,
        side: 'bid',
        compared_count: 1,
        price_within_1_tick_pct: 100,
        size_exact_match_pct: 0,
        size_abs_delta_p50: 2,
      },
    ]);
    expect(JSON.stringify(report.mbp10_component_parity.first_mismatches)).toBe(
      JSON.stringify(
        analyzeDatabentoOverlapParity({
          rithmic_probe_path: rithmicPath,
          databento_mbp10_path: databentoPath,
        }).mbp10_component_parity.first_mismatches,
      ),
    );
  });

  it('writes a stable report shape', () => {
    const rithmicPath = writeJsonl(
      [
        seedRow(),
        mbp10Record(1_000_000n, {
          asks: [{ level: 0, px: 100.75, sz: 9, order_count: 5 }],
        }),
      ],
      'rithmic.jsonl',
    );
    const databentoPath = writeJsonl(
      [
        databentoRecord(2_000_000n, {
          bid_px_00: 100,
          bid_sz_00: 5,
          bid_ct_00: 2,
          ask_px_00: 100.75,
          ask_sz_00: 9,
          ask_ct_00: 5,
          ask_px_01: 101,
          ask_sz_01: 7,
          ask_ct_01: 3,
        }),
      ],
      'databento.jsonl',
    );
    const outPath = join(makeTempDir(), 'report.json');
    const first = analyzeDatabentoOverlapParity({
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoPath,
    });
    const second = analyzeDatabentoOverlapParity({
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoPath,
    });

    writeDatabentoOverlapParityReport(first, outPath);
    const parsed = JSON.parse(readFileSync(outPath, 'utf8')) as typeof first;

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(parsed).toMatchObject({
      schema_version: 1,
      ticket_id: 'DATABENTO-OVERLAP-PARITY',
      status: 'analysis_only',
      data01_route: 'blocked_pending_infra01_verification',
    });
  });

  it('does not introduce wall-clock or random sources in the analyzer', () => {
    const sourcePath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../scripts/infra/analyze-databento-overlap-parity.ts',
    );
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).not.toContain('Date.now');
    expect(source).not.toContain('new Date');
    expect(source).not.toContain('Math.random');
    expect(source).not.toContain('toLocaleString');
    expect(source).not.toContain('localeCompare');
  });
});
