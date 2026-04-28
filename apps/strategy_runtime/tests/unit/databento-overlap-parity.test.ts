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

function l1QuoteRecord(offsetNs: bigint, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    stream: 'L1_QUOTE',
    exchange_event_ts_ns: (START_TS_NS + offsetNs).toString(),
    payload_kind: 'BestBidOffer',
    ...overrides,
  };
}

function bboFields(bidPx: number, askPx: number, bidSize = 5, askSize = 7): Record<string, unknown> {
  return {
    bid_px: bidPx,
    bid_sz: bidSize,
    bid_orders: 2,
    ask_px: askPx,
    ask_sz: askSize,
    ask_orders: 3,
  };
}

function databentoBboFields(bidPx: number, askPx: number, bidSize = 5, askSize = 7): Record<string, unknown> {
  return {
    bid_px_00: bidPx,
    bid_sz_00: bidSize,
    bid_ct_00: 2,
    ask_px_00: askPx,
    ask_sz_00: askSize,
    ask_ct_00: 3,
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

function twoSidedUpdate(
  offsetNs: bigint,
  bidPx: number,
  askPx: number,
  size = 5,
  orderCount = 2,
): Record<string, unknown> {
  return mbp10Record(offsetNs, {
    bids: [{ level: 0, px: bidPx, sz: size, order_count: orderCount }],
    asks: [{ level: 0, px: askPx, sz: size, order_count: orderCount }],
  });
}

function shiftInsideTo101x102(offsetNs: bigint): Record<string, unknown> {
  return mbp10Record(offsetNs, {
    bids: [{ level: 0, px: 101, sz: 5, order_count: 2 }],
    asks: [
      { level: 0, px: 101, sz: 0, order_count: 0 },
      { level: 1, px: 102, sz: 5, order_count: 2 },
    ],
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

  it('detects a known +50 ms temporal offset in the lag scan', () => {
    const rithmicPath = writeJsonl(
      [
        seedRow(),
        twoSidedUpdate(0n, 100, 101),
        shiftInsideTo101x102(50_000_000n),
      ],
      'rithmic.jsonl',
    );
    const databentoPath = writeJsonl(
      [
        databentoRecord(0n, {
          bid_px_00: 101,
          bid_sz_00: 5,
          bid_ct_00: 2,
          ask_px_00: 102,
          ask_sz_00: 5,
          ask_ct_00: 2,
        }),
      ],
      'databento.jsonl',
    );

    const report = analyzeDatabentoOverlapParity({
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoPath,
    });

    expect(report.mbp10_temporal_alignment).toMatchObject({
      best_offset_ms: 50,
      classification: 'temporal_alignment_offset_required',
    });
    expect(
      report.mbp10_temporal_alignment.lag_scan_scores.find((score) => score.offset_ms === 50),
    ).toMatchObject({
      both_sides_top_price_within_1_tick_pct: 100,
    });
    expect(
      report.mbp10_temporal_alignment.lag_scan_scores.find((score) => score.offset_ms === 0),
    ).toMatchObject({
      both_sides_top_price_within_1_tick_pct: 0,
    });
  });

  it('shows nearest-state lookup can improve over previous-or-equal sampling', () => {
    const rithmicPath = writeJsonl(
      [
        seedRow(),
        twoSidedUpdate(0n, 100, 101),
        shiftInsideTo101x102(10_000_000n),
      ],
      'rithmic.jsonl',
    );
    const databentoPath = writeJsonl(
      [
        databentoRecord(6_000_000n, {
          bid_px_00: 101,
          bid_sz_00: 5,
          bid_ct_00: 2,
          ask_px_00: 102,
          ask_sz_00: 5,
          ask_ct_00: 2,
        }),
      ],
      'databento.jsonl',
    );

    const report = analyzeDatabentoOverlapParity({
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoPath,
    });

    expect(report.mbp10_temporal_alignment.lookup_policy_scores.previous_or_equal).toMatchObject({
      both_sides_top_price_within_1_tick_pct: 0,
    });
    expect(report.mbp10_temporal_alignment.lookup_policy_scores.nearest).toMatchObject({
      both_sides_top_price_within_1_tick_pct: 100,
    });
  });

  it('scores ts_recv separately when normalized Databento rows provide it', () => {
    const rithmicPath = writeJsonl(
      [
        seedRow(),
        twoSidedUpdate(0n, 100, 101),
        shiftInsideTo101x102(50_000_000n),
      ],
      'rithmic.jsonl',
    );
    const databentoPath = writeJsonl(
      [
        databentoRecord(0n, {
          ts_recv_ns: (START_TS_NS + 50_000_000n).toString(),
          bid_px_00: 101,
          bid_sz_00: 5,
          bid_ct_00: 2,
          ask_px_00: 102,
          ask_sz_00: 5,
          ask_ct_00: 2,
        }),
      ],
      'databento.jsonl',
    );

    const report = analyzeDatabentoOverlapParity({
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoPath,
    });

    expect(report.mbp10_temporal_alignment.timestamp_basis_scores).toMatchObject({
      ts_recv_available: true,
      ts_event: {
        both_sides_top_price_within_1_tick_pct: 0,
      },
      ts_recv: {
        both_sides_top_price_within_1_tick_pct: 100,
      },
    });
    expect(report.mbp10_temporal_alignment.best_timestamp_basis).toBe('ts_recv');
  });

  it('reports deterministic mismatch clusters and BBO cross-check shape', () => {
    const rithmicPath = writeJsonl(
      [
        seedRow(),
        twoSidedUpdate(0n, 100, 101),
        shiftInsideTo101x102(90_000_000_000n),
      ],
      'rithmic.jsonl',
    );
    const databentoPath = writeJsonl(
      [
        databentoRecord(1_000_000n, {
          bid_px_00: 100,
          bid_sz_00: 5,
          bid_ct_00: 2,
          ask_px_00: 101,
          ask_sz_00: 5,
          ask_ct_00: 2,
        }),
        databentoRecord(2_000_000n, {
          bid_px_00: 101,
          bid_sz_00: 5,
          bid_ct_00: 2,
          ask_px_00: 102,
          ask_sz_00: 5,
          ask_ct_00: 2,
        }),
        databentoRecord(61_000_000_000n, {
          bid_px_00: 101,
          bid_sz_00: 5,
          bid_ct_00: 2,
          ask_px_00: 102,
          ask_sz_00: 5,
          ask_ct_00: 2,
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
      mbp10_temporal_alignment: {
        mismatch_clusters: {
          price_mismatch_sample_count: 2,
          price_match_sample_count: 1,
          max_consecutive_mismatch_run: 2,
          first_clusters: [
            {
              start_ts_ns: (START_TS_NS + 2_000_000n).toString(),
              end_ts_ns: (START_TS_NS + 61_000_000_000n).toString(),
              sample_count: 2,
            },
          ],
        },
        bbo_cross_checks: {
          rithmic_l1_quote_vs_databento_mbp1: {
            status: 'not_available',
          },
          rithmic_mbp10_top_vs_databento_mbp10: {
            lookup_policy: 'previous_or_equal',
          },
        },
      },
    });
    expect(report.mbp10_temporal_alignment.mismatch_clusters.mismatch_rate_per_minute).toHaveLength(2);
  });

  it('passes Rithmic L1 vs Databento MBP-1 triangulation on matching BBO fixtures', () => {
    const rithmicPath = writeJsonl(
      [
        seedRow(),
        checkpointRow(),
        l1QuoteRecord(1_000_000n, bboFields(100, 101)),
      ],
      'rithmic.jsonl',
    );
    const databentoMbp10Path = writeJsonl(
      [databentoRecord(2_000_000n, databentoBboFields(100, 101))],
      'databento-mbp10.jsonl',
    );
    const databentoMbp1Path = writeJsonl(
      [databentoRecord(2_000_000n, databentoBboFields(100, 101))],
      'databento-mbp1.jsonl',
    );

    const report = analyzeDatabentoOverlapParity({
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoMbp10Path,
      databento_mbp1_path: databentoMbp1Path,
    });
    const comparison = report.bbo_triangulation.comparisons.rithmic_l1_quote_vs_databento_mbp1;

    expect(report.bbo_triangulation).toMatchObject({
      status: 'analysis_only',
      data01b_eligible: false,
      classification: 'inconclusive',
    });
    expect(comparison).toMatchObject({
      status: 'available',
      best_lookup_policy: 'previous_or_equal',
      compared_samples: 1,
      both_sides_within_1_tick_pct: 100,
      bid_size_exact_match_pct: 100,
      ask_size_exact_match_pct: 100,
    });
  });

  it('classifies Databento MBP10 top versus MBP-1 disagreement as a Databento normalization issue', () => {
    const rithmicPath = writeJsonl(
      [
        seedRow(),
        checkpointRow(),
        l1QuoteRecord(1_000_000n, bboFields(100, 101)),
      ],
      'rithmic.jsonl',
    );
    const databentoMbp10Path = writeJsonl(
      [databentoRecord(2_000_000n, databentoBboFields(99, 102))],
      'databento-mbp10.jsonl',
    );
    const databentoMbp1Path = writeJsonl(
      [databentoRecord(2_000_000n, databentoBboFields(100, 101))],
      'databento-mbp1.jsonl',
    );

    const report = analyzeDatabentoOverlapParity({
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoMbp10Path,
      databento_mbp1_path: databentoMbp1Path,
    });
    const comparison = report.bbo_triangulation.comparisons.databento_mbp10_top_vs_databento_mbp1;

    expect(report.bbo_triangulation.classification).toBe('databento_mbp10_normalization_issue');
    expect(comparison).toMatchObject({
      status: 'available',
      both_sides_within_1_tick_pct: 0,
    });
  });

  it('classifies Rithmic MBP10 versus L1 disagreement as a Rithmic extraction issue', () => {
    const rithmicPath = writeJsonl(
      [
        seedRow(),
        checkpointRow(),
        l1QuoteRecord(1_000_000n, bboFields(99, 102)),
      ],
      'rithmic.jsonl',
    );
    const databentoMbp10Path = writeJsonl(
      [databentoRecord(2_000_000n, databentoBboFields(99, 102))],
      'databento-mbp10.jsonl',
    );
    const databentoMbp1Path = writeJsonl(
      [databentoRecord(2_000_000n, databentoBboFields(99, 102))],
      'databento-mbp1.jsonl',
    );

    const report = analyzeDatabentoOverlapParity({
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoMbp10Path,
      databento_mbp1_path: databentoMbp1Path,
    });
    const comparison = report.bbo_triangulation.comparisons.rithmic_mbp10_top_vs_rithmic_l1_quote;

    expect(report.bbo_triangulation.classification).toBe('rithmic_mbp10_extraction_issue');
    expect(comparison).toMatchObject({
      status: 'available',
      both_sides_within_1_tick_pct: 0,
    });
  });

  it('keeps the triangulation decision-tree report shape stable and DATA-01B blocked', () => {
    const rithmicPath = writeJsonl(
      [
        seedRow(),
        checkpointRow(),
        l1QuoteRecord(1_000_000n, bboFields(100, 101)),
      ],
      'rithmic.jsonl',
    );
    const databentoMbp10Path = writeJsonl(
      [databentoRecord(2_000_000n, databentoBboFields(100, 101))],
      'databento-mbp10.jsonl',
    );
    const databentoMbp1Path = writeJsonl(
      [databentoRecord(2_000_000n, databentoBboFields(100, 101))],
      'databento-mbp1.jsonl',
    );

    const first = analyzeDatabentoOverlapParity({
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoMbp10Path,
      databento_mbp1_path: databentoMbp1Path,
    });
    const second = analyzeDatabentoOverlapParity({
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoMbp10Path,
      databento_mbp1_path: databentoMbp1Path,
    });

    expect(first.bbo_triangulation).toMatchObject({
      status: 'analysis_only',
      data01b_eligible: false,
      comparisons: {
        rithmic_l1_quote_vs_databento_mbp1: { status: 'available' },
        rithmic_mbp10_top_vs_rithmic_l1_quote: { status: 'available' },
        databento_mbp10_top_vs_databento_mbp1: { status: 'available' },
        rithmic_mbp10_top_vs_databento_mbp10: { status: 'available' },
      },
    });
    expect(JSON.stringify(first.bbo_triangulation)).toBe(JSON.stringify(second.bbo_triangulation));
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
