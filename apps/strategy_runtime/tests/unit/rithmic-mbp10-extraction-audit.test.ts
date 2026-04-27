import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  auditRithmicMbp10Extraction,
  writeRithmicMbp10ExtractionAuditReport,
} from '../../../../scripts/infra/audit-rithmic-mbp10-extraction.js';

const START_TS_NS = 1_777_300_000_000_000_000n;
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-mbp10-audit-'));
  tempDirectories.push(directory);
  return directory;
}

describe('DATA-PARITY-04 Rithmic MBP10 extraction audit', () => {
  it('flags a null seed row with implausible prices and keeps DATA-01B blocked', () => {
    const probePath = writeProbe([
      l1Quote(0n, { bid_px: 100, ask_px: 101 }),
      mbp10Row(null, {
        bids: [{ level: 0, px: 10, sz: 1, order_count: 1 }],
        asks: [{ level: 0, px: 500, sz: 1, order_count: 1 }],
      }),
      mbp10Row(1_000_000n, {
        bids: [{ level: 0, px: 100, sz: 3, order_count: 1 }],
        asks: [{ level: 0, px: 101, sz: 2, order_count: 1 }],
      }),
    ]);

    const report = auditRithmicMbp10Extraction({ probe_path: probePath });

    expect(report.status).toBe('analysis_only');
    expect(report.data01b_eligible).toBe(false);
    expect(report.data01_status).toBe('blocked');
    expect(report.null_seed_analysis).toMatchObject({
      allow_null_seed_default: false,
      null_seed_rows_count: 1,
      null_seed_rows_with_levels_count: 1,
      implausible_null_seed_rows_count: 1,
    });
    expect(report.reconstruction_modes.no_null_seed_rows.applied_null_seed_rows_count).toBe(0);
    expect(report.reconstruction_modes.no_null_seed_rows.skipped_null_seed_rows_count).toBe(1);
  });

  it('applies timestamped bid-only and ask-only updates as incremental state', () => {
    const probePath = writeProbe([
      l1Quote(0n, { bid_px: 100, ask_px: 101 }),
      l1Quote(1_000_000n, { bid_px: 100.25, ask_px: 101 }),
      l1Quote(2_000_000n, { bid_px: 100.25, ask_px: 100.75 }),
      mbp10Row(1_000_000n, {
        bids: [{ level: 0, px: 100.25, sz: 3, order_count: 1 }],
      }),
      mbp10Row(2_000_000n, {
        asks: [{ level: 0, px: 100.75, sz: 4, order_count: 2 }],
      }),
    ]);

    const report = auditRithmicMbp10Extraction({ probe_path: probePath });
    const mode = report.reconstruction_modes.no_null_seed_rows;

    expect(mode.applied_timestamped_update_rows_count).toBe(2);
    expect(report.probe_parsing).toMatchObject({
      mbp10_rows_with_bids: 1,
      mbp10_rows_with_asks: 1,
      mbp10_rows_with_one_side_only: 2,
    });
    expect(mode.internal_l1_mbp10_parity.compared_sample_count).toBe(1);
    expect(mode.internal_l1_mbp10_parity.within_1_tick_pct).toBe(100);
  });

  it('passes internal L1/MBP10 parity on synthetic aligned data', () => {
    const probePath = writeProbe([
      l1Quote(0n, { bid_px: 100, ask_px: 101 }),
      mbp10Row(0n, {
        bids: [{ level: 0, px: 100, sz: 3, order_count: 1 }],
        asks: [{ level: 0, px: 101, sz: 2, order_count: 1 }],
      }),
    ]);

    const report = auditRithmicMbp10Extraction({ probe_path: probePath });

    expect(report.status).toBe('analysis_only');
    expect(report.mbp10_extraction_trusted).toBe(true);
    expect(report.classification).toBe('state_stream_incremental_valid');
    expect(report.internal_l1_mbp10_parity.within_1_tick_pct).toBe(100);
  });

  it('fails internal L1/MBP10 parity on synthetic mis-scaled data', () => {
    const probePath = writeProbe([
      l1Quote(0n, { bid_px: 100, ask_px: 101 }),
      mbp10Row(0n, {
        bids: [{ level: 0, px: 10000, sz: 3, order_count: 1 }],
        asks: [{ level: 0, px: 10100, sz: 2, order_count: 1 }],
      }),
    ]);

    const report = auditRithmicMbp10Extraction({ probe_path: probePath });

    expect(report.status).toBe('fail');
    expect(report.mbp10_extraction_trusted).toBe(false);
    expect(report.classification).toBe('price_scaling_error_suspected');
    expect(report.recommendation).toBe('adjust_price_scaling_after_manual_review');
    expect(report.internal_l1_mbp10_parity.within_1_tick_pct).toBe(0);
  });

  it('keeps the report shape stable and deterministic', () => {
    const probePath = writeProbe([
      l1Quote(0n, { bid_px: 100, ask_px: 101 }),
      mbp10Row(0n, {
        bids: [{ level: 0, px: 100, sz: 3, order_count: 1 }],
        asks: [{ level: 0, px: 101, sz: 2, order_count: 1 }],
      }),
    ]);
    const outPath = join(makeTempDir(), 'audit.json');

    const first = auditRithmicMbp10Extraction({ probe_path: probePath });
    const second = auditRithmicMbp10Extraction({ probe_path: probePath });
    writeRithmicMbp10ExtractionAuditReport(first, outPath);
    const parsed = JSON.parse(readFileSync(outPath, 'utf8')) as typeof first;

    expect(first).toEqual(second);
    expect(parsed).toMatchObject({
      schema_version: 1,
      ticket_id: 'DATA-PARITY-04',
      data01b_eligible: false,
      data01_status: 'blocked',
      inputs: {
        allow_null_seed: false,
        tick_size: 0.25,
      },
    });
  });

  it('does not introduce wall-clock or random sources in the audit implementation', () => {
    const sourcePath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../scripts/infra/audit-rithmic-mbp10-extraction.ts',
    );
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).not.toContain('Date.now');
    expect(source).not.toContain('new Date');
    expect(source).not.toContain('Math.random');
    expect(source).not.toContain('toLocaleString');
    expect(source).not.toContain('localeCompare');
  });
});

function writeProbe(rows: readonly Record<string, unknown>[]): string {
  const path = join(makeTempDir(), 'probe.jsonl');
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return path;
}

function l1Quote(
  offsetNs: bigint,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const tsNs = (START_TS_NS + offsetNs).toString();
  return {
    schema_version: 1,
    stream: 'L1_QUOTE',
    exchange_event_ts_ns: tsNs,
    sidecar_recv_ts_ns: (START_TS_NS + offsetNs + 1_000_000n).toString(),
    timestamp_source: 'synthetic',
    payload_kind: 'BestBidOffer',
    bid_px: 100,
    ask_px: 101,
    bid_sz: 1,
    ask_sz: 1,
    ...overrides,
  };
}

function mbp10Row(
  offsetNs: bigint | null,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schema_version: 1,
    stream: 'MBP10',
    exchange_event_ts_ns: offsetNs === null ? null : (START_TS_NS + offsetNs).toString(),
    sidecar_recv_ts_ns: (START_TS_NS + (offsetNs ?? 0n) + 1_000_000n).toString(),
    timestamp_source: offsetNs === null ? 'unavailable' : 'synthetic',
    payload_kind: 'OrderBook',
    ...overrides,
  };
}
