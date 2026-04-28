import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeMboParity,
  writeMboParityReport,
} from '../../../../scripts/infra/analyze-mbo-parity.js';

const START_TS_NS = 1_777_300_000_000_000_000n;
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-mbo-parity-'));
  tempDirectories.push(directory);
  return directory;
}

function writeJsonl(rows: readonly Record<string, unknown>[], fileName: string): string {
  const path = join(makeTempDir(), fileName);
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return path;
}

function rithmicMboRecord(
  offsetNs: bigint,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    stream: 'MBO',
    exchange_event_ts_ns: (START_TS_NS + offsetNs).toString(),
    sequence: String(1000n + offsetNs / 1_000_000n),
    orders: [
      {
        action: 'new',
        side: 'buy',
        price: 100,
        size: 5,
        order_id: `r-${offsetNs}`,
      },
    ],
    ...overrides,
  };
}

function databentoMboRecord(
  offsetNs: bigint,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ts_event_ns: (START_TS_NS + offsetNs).toString(),
    sequence: String(2000n + offsetNs / 1_000_000n),
    action: 'A',
    side: 'B',
    price: 100,
    size: 5,
    order_id: `d-${offsetNs}`,
    ...overrides,
  };
}

describe('DATA-PARITY-10 MBO parity diagnostic', () => {
  it('classifies aligned synthetic MBO event semantics', () => {
    const rithmicPath = writeJsonl(
      [
        rithmicMboRecord(1_000_000n),
        rithmicMboRecord(2_000_000n, { orders: [{ action: 'delete', side: 'sell', price: 101, size: 2, order_id: 'r2' }] }),
      ],
      'rithmic.jsonl',
    );
    const databentoPath = writeJsonl(
      [
        databentoMboRecord(1_000_000n),
        databentoMboRecord(2_000_000n, { action: 'C', side: 'A', price: 101, size: 2, order_id: 'd2' }),
      ],
      'databento.jsonl',
    );

    const report = analyzeMboParity({
      rithmic_probe_path: rithmicPath,
      databento_mbo_path: databentoPath,
    });

    expect(report).toMatchObject({
      status: 'analysis_only',
      data01b_full_eligible: false,
      mbo_policy_decision: 'pending',
      classification: 'mbo_event_semantics_aligned',
      cross_source: {
        signature_match_pct_of_databento: 100,
      },
    });
  });

  it('classifies action and side distribution mismatches separately', () => {
    const rithmicPath = writeJsonl([rithmicMboRecord(1_000_000n)], 'rithmic.jsonl');
    const databentoPath = writeJsonl(
      [databentoMboRecord(1_000_000n, { action: 'C', side: 'A' })],
      'databento.jsonl',
    );

    const report = analyzeMboParity({
      rithmic_probe_path: rithmicPath,
      databento_mbo_path: databentoPath,
    });

    expect(report.classification).toBe('mbo_action_side_mismatch');
    expect(report.cross_source.action_distribution_delta_pct.add).toBe(100);
    expect(report.cross_source.side_distribution_delta_pct.bid).toBe(100);
  });

  it('reports action taxonomy counts by provider', () => {
    const rithmicPath = writeJsonl(
      [
        rithmicMboRecord(1_000_000n),
        rithmicMboRecord(2_000_000n, { orders: [{ action: 'delete', side: 'sell', price: 101, size: 2, order_id: 'r2' }] }),
      ],
      'rithmic.jsonl',
    );
    const databentoPath = writeJsonl(
      [
        databentoMboRecord(1_000_000n),
        databentoMboRecord(2_000_000n, { action: 'T', side: 'B', price: 100, size: 1, order_id: 'd-trade' }),
        databentoMboRecord(3_000_000n, { action: 'Z', side: 'A', price: 101, size: 1, order_id: 'd-unknown' }),
      ],
      'databento.jsonl',
    );

    const report = analyzeMboParity({
      rithmic_probe_path: rithmicPath,
      databento_mbo_path: databentoPath,
    });

    expect(report.mbo_action_taxonomy.action_counts.rithmic.action_counts).toMatchObject({
      add: 1,
      cancel: 1,
      trade: 0,
      unknown: 0,
    });
    expect(report.mbo_action_taxonomy.action_counts.databento.action_counts).toMatchObject({
      add: 1,
      trade: 1,
      unknown: 1,
    });
    expect(report.mbo_action_taxonomy.action_counts.databento.first_examples_by_action.trade[0]).toMatchObject({
      raw_action: 'T',
      action: 'trade',
    });
  });

  it('separates alternate signature modes when trade actions are excluded', () => {
    const rithmicPath = writeJsonl([rithmicMboRecord(1_000_000n)], 'rithmic.jsonl');
    const databentoPath = writeJsonl(
      [
        databentoMboRecord(1_000_000n),
        databentoMboRecord(2_000_000n, { action: 'T', side: 'B', price: 100, size: 1, order_id: 'trade-1' }),
      ],
      'databento.jsonl',
    );

    const report = analyzeMboParity({
      rithmic_probe_path: rithmicPath,
      databento_mbo_path: databentoPath,
    });

    expect(report.mbo_action_taxonomy.alternate_signature_modes.strict_all_actions).toMatchObject({
      databento_count_included: 2,
      matched_count: 1,
      match_pct_of_databento: 50,
    });
    expect(report.mbo_action_taxonomy.alternate_signature_modes.exclude_trade).toMatchObject({
      databento_count_included: 1,
      matched_count: 1,
      match_pct_of_databento: 100,
    });
    expect(report.mbo_action_taxonomy.classification).toBe('book_action_parity_pass_trade_excluded');
  });

  it('classifies unknown action taxonomy when unknowns dominate after structural parity is reviewable', () => {
    const rithmicRows = Array.from({ length: 25 }, (_, index) => rithmicMboRecord(BigInt(index + 1) * 1_000_000n));
    const databentoRows = [
      ...Array.from({ length: 24 }, (_, index) => databentoMboRecord(BigInt(index + 1) * 1_000_000n)),
      databentoMboRecord(25_000_000n, { price: 101 }),
      ...Array.from({ length: 10 }, (_, index) => databentoMboRecord(BigInt(index + 100) * 1_000_000n, {
        action: 'Z',
        side: 'B',
        price: 100,
        size: 1,
        order_id: `unknown-${index}`,
      })),
    ];
    const rithmicPath = writeJsonl(rithmicRows, 'rithmic.jsonl');
    const databentoPath = writeJsonl(databentoRows, 'databento.jsonl');

    const report = analyzeMboParity({
      rithmic_probe_path: rithmicPath,
      databento_mbo_path: databentoPath,
    });

    expect(report.mbo_action_taxonomy.alternate_signature_modes.structural_book_actions_only.match_pct_of_databento).toBe(96);
    expect(report.mbo_action_taxonomy.classification).toBe('unknown_action_mapping_required');
    expect(report.mbo_action_taxonomy.data01b_eligible).toBe(false);
  });

  it('keeps structural-only mismatches blocked', () => {
    const rithmicPath = writeJsonl([rithmicMboRecord(1_000_000n)], 'rithmic.jsonl');
    const databentoPath = writeJsonl([databentoMboRecord(1_000_000n, { price: 101 })], 'databento.jsonl');

    const report = analyzeMboParity({
      rithmic_probe_path: rithmicPath,
      databento_mbo_path: databentoPath,
    });

    expect(report.mbo_action_taxonomy.alternate_signature_modes.structural_book_actions_only.match_pct_of_databento).toBe(0);
    expect(report.mbo_action_taxonomy.classification).toBe('structural_mbo_parity_failure');
    expect(report.mbo_action_taxonomy.recommendation).toContain('keep DATA-01B full scope blocked');
  });

  it('reports timestamp-window sensitivity deterministically', () => {
    const rithmicPath = writeJsonl([rithmicMboRecord(0n)], 'rithmic.jsonl');
    const databentoPath = writeJsonl([databentoMboRecord(5_000_000n)], 'databento.jsonl');

    const report = analyzeMboParity({
      rithmic_probe_path: rithmicPath,
      databento_mbo_path: databentoPath,
    });

    expect(report.mbo_action_taxonomy.timestamp_window_sensitivity.windows.exact).toMatchObject({
      databento_count_included: 1,
      candidate_match_count: 0,
    });
    expect(report.mbo_action_taxonomy.timestamp_window_sensitivity.windows.plus_minus_5ms).toMatchObject({
      databento_count_included: 1,
      candidate_match_count: 1,
      candidate_match_pct_of_databento: 100,
    });
  });

  it('flags decreasing sequence semantics', () => {
    const rithmicPath = writeJsonl(
      [
        rithmicMboRecord(1_000_000n, { sequence: '5' }),
        rithmicMboRecord(2_000_000n, { sequence: '4' }),
      ],
      'rithmic.jsonl',
    );
    const databentoPath = writeJsonl([databentoMboRecord(1_000_000n)], 'databento.jsonl');

    const report = analyzeMboParity({
      rithmic_probe_path: rithmicPath,
      databento_mbo_path: databentoPath,
    });

    expect(report.classification).toBe('mbo_sequence_semantics_mismatch');
    expect(report.rithmic_mbo.sequence_analysis).toMatchObject({
      non_decreasing: false,
      decreased_count: 1,
    });
  });

  it('keeps order-id incompatibility diagnostic and DATA-01B blocked', () => {
    const rithmicPath = writeJsonl(
      [rithmicMboRecord(1_000_000n, { orders: [{ action: 'new', side: 'buy', price: 100, size: 5 }] })],
      'rithmic.jsonl',
    );
    const databentoPath = writeJsonl(
      [databentoMboRecord(1_000_000n, { order_id: undefined })],
      'databento.jsonl',
    );

    const report = analyzeMboParity({
      rithmic_probe_path: rithmicPath,
      databento_mbo_path: databentoPath,
    });

    expect(report.classification).toBe('mbo_order_id_semantics_incompatible');
    expect(report.data01b_full_eligible).toBe(false);
    expect(report.remaining_blocks).toContain('FULL_DATA01B_REQUIRES_MBO_ACCEPTANCE');
  });

  it('writes a stable analysis-only report shape', () => {
    const rithmicPath = writeJsonl([rithmicMboRecord(1_000_000n)], 'rithmic.jsonl');
    const databentoPath = writeJsonl([databentoMboRecord(1_000_000n)], 'databento.jsonl');
    const first = analyzeMboParity({
      rithmic_probe_path: rithmicPath,
      databento_mbo_path: databentoPath,
    });
    const second = analyzeMboParity({
      rithmic_probe_path: rithmicPath,
      databento_mbo_path: databentoPath,
    });
    const outPath = join(makeTempDir(), 'report.json');

    writeMboParityReport(first, outPath);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.parse(readFileSync(outPath, 'utf8'))).toMatchObject({
      schema_version: 1,
      ticket_id: 'DATA-PARITY-10',
      status: 'analysis_only',
      data01b_full_eligible: false,
      mbo_action_taxonomy: {
        ticket_id: 'DATA-PARITY-11',
        status: 'analysis_only',
        data01b_eligible: false,
      },
    });
  });
});
