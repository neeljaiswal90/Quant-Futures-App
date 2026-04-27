import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeMbp10DebugDump,
  writeMbp10DebugDumpAnalysisReport,
} from '../../../../scripts/infra/analyze-mbp10-debug-dump.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-mbp10-debug-'));
  tempDirectories.push(directory);
  return directory;
}

describe('DATA-PARITY-04B MBP10 debug dump analyzer', () => {
  it('identifies the correct synthetic price scale and keeps DATA-01B blocked', () => {
    const debugDump = writeDebugDump([
      descriptorRow(),
      rawMessageRow({
        rawValue: 273_692_500,
        normalizedPx: 273_692_500,
        l1Bid: 27_369,
        l1Ask: 27_369.5,
      }),
    ]);

    const report = analyzeMbp10DebugDump(debugDump);

    expect(report.data01b_eligible).toBe(false);
    expect(report.data01_status).toBe('blocked');
    expect(report.likely_price_scale).toBe(10_000);
    expect(report.recommendation).toBe('adjust_price_scaling_after_manual_review');
    expect(report.status).toBe('fail');
  });

  it('can recommend rerunning the audit when normalized extraction is plausible', () => {
    const debugDump = writeDebugDump([
      descriptorRow(),
      rawMessageRow({
        rawValue: 27_369.25,
        normalizedPx: 27_369.25,
        l1Bid: 27_369,
        l1Ask: 27_369.5,
      }),
    ]);

    const report = analyzeMbp10DebugDump(debugDump);

    expect(report.likely_price_scale).toBe(1);
    expect(report.normalized_extraction.implausible_extracted_level_count).toBe(0);
    expect(report.recommendation).toBe('rerun_data_parity_04_audit_after_extraction_change');
    expect(report.status).toBe('analysis_only');
  });

  it('writes a stable report shape', () => {
    const debugDump = writeDebugDump([
      descriptorRow(),
      rawMessageRow({
        rawValue: 27_369.25,
        normalizedPx: 27_369.25,
        l1Bid: 27_369,
        l1Ask: 27_369.5,
      }),
    ]);
    const out = join(makeTempDir(), 'analysis.json');

    const first = analyzeMbp10DebugDump(debugDump);
    const second = analyzeMbp10DebugDump(debugDump);
    writeMbp10DebugDumpAnalysisReport(first, out);
    const parsed = JSON.parse(readFileSync(out, 'utf8')) as typeof first;

    expect(first).toEqual(second);
    expect(parsed).toMatchObject({
      schema_version: 1,
      ticket_id: 'DATA-PARITY-04B',
      data01b_eligible: false,
      data01_status: 'blocked',
    });
  });
});

function writeDebugDump(rows: readonly Record<string, unknown>[]): string {
  const path = join(makeTempDir(), 'debug.jsonl');
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return path;
}

function descriptorRow(): Record<string, unknown> {
  return {
    schema_version: 1,
    debug_record_type: 'mbp10_descriptor',
    ticket_id: 'DATA-PARITY-04B',
    descriptor: {
      available: true,
      fields: [{ name: 'bid_price', number: 1, type: 'double', label: 'repeated' }],
    },
  };
}

function rawMessageRow(args: {
  readonly rawValue: number;
  readonly normalizedPx: number;
  readonly l1Bid: number;
  readonly l1Ask: number;
}): Record<string, unknown> {
  const mid = (args.l1Bid + args.l1Ask) / 2;
  const distance = Math.abs(args.normalizedPx - mid);
  return {
    schema_version: 1,
    debug_record_type: 'mbp10_raw_message',
    ticket_id: 'DATA-PARITY-04B',
    debug_index: 0,
    nearby_l1_quote: {
      bid_px: args.l1Bid,
      ask_px: args.l1Ask,
      mid_px: mid,
    },
    raw_fields: {
      bid_price: [args.rawValue],
    },
    normalized_extracted_fields: {
      bids: [
        {
          level: 0,
          px: args.normalizedPx,
          sz: 1,
          debug_price_sanity: {
            plausible_against_l1: distance <= 100,
            distance_from_l1_mid_points: distance,
          },
        },
      ],
    },
    price_scaling_diagnostics: [
      {
        field_path: 'bid_price[0]',
        raw_value: args.rawValue,
        scale_candidates: [1, 10, 100, 1_000, 10_000, 1_000_000_000].map((factor) => {
          const value = args.rawValue / factor;
          const candidateDistance = Math.abs(value - mid);
          return {
            divide_by: factor,
            value,
            distance_from_l1_mid_points: candidateDistance,
            within_1_tick_of_l1_mid: candidateDistance <= 0.25,
            within_100_points_of_l1_mid: candidateDistance <= 100,
          };
        }),
      },
    ],
    data01b_eligible: false,
    data01_status: 'blocked',
  };
}
