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
      recommendation: {
        databento_parity_status_for_infra01b: 'pending',
      },
    });
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
