import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeRithmicTimestampOrder,
  writeTimestampOrderReport,
  type TimestampOrderReport,
} from '../../../../scripts/infra/analyze-rithmic-timestamp-order.js';

const START_TS_NS = 1_700_000_000_000_000_000n;
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-infra-01c-'));
  tempDirectories.push(directory);
  return directory;
}

function probeRecord(
  stream: string,
  offsetNs: bigint,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const templateIdByStream: Record<string, number> = {
    L1_QUOTE: 151,
    LAST_TRADE: 150,
    MBP10: 156,
    MBO: 160,
  };
  return {
    schema_version: 1,
    stream,
    exchange_event_ts_ns: (START_TS_NS + offsetNs).toString(),
    sidecar_recv_ts_ns: (START_TS_NS + offsetNs + 2_000_000n).toString(),
    timestamp_source: stream === 'MBO' ? 'source_nsecs' : 'ssboe_usecs',
    template_id: templateIdByStream[stream] ?? 999,
    payload_kind: stream,
    ...overrides,
  };
}

function writeProbe(rows: readonly Record<string, unknown>[]): string {
  const directory = makeTempDir();
  const probePath = join(directory, 'probe.jsonl');
  writeFileSync(probePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return probePath;
}

function analyze(rows: readonly Record<string, unknown>[]): TimestampOrderReport {
  return analyzeRithmicTimestampOrder({ probe_path: writeProbe(rows) });
}

describe('INFRA-01C Rithmic timestamp order analysis', () => {
  it('marks monotonic streams as non-decreasing', () => {
    const report = analyze([
      probeRecord('LAST_TRADE', 0n, { sequence: '1' }),
      probeRecord('LAST_TRADE', 1_000_000n, { sequence: '2' }),
      probeRecord('LAST_TRADE', 2_000_000n, { sequence: '3' }),
      probeRecord('MBO', 0n, { sequence: '10' }),
      probeRecord('MBO', 1_000_000n, { sequence: '11' }),
    ]);

    expect(report.streams.LAST_TRADE).toMatchObject({
      non_decreasing: true,
      violation_count: 0,
      timestamp_coverage: { valid_count: 3, missing_count: 0, coverage_ratio: 1 },
    });
    expect(report.streams.MBO).toMatchObject({ non_decreasing: true });
    expect(report.summary.streams_with_violations).toEqual([]);
  });

  it('classifies small bounded quote/book disorder separately from strict event-stream failure', () => {
    const report = analyze([
      probeRecord('L1_QUOTE', 0n),
      probeRecord('L1_QUOTE', 10_000_000n),
      probeRecord('L1_QUOTE', 9_000_000n),
      probeRecord('L1_QUOTE', 20_000_000n),
      probeRecord('LAST_TRADE', 0n, { sequence: '1' }),
      probeRecord('LAST_TRADE', 20_000_000n, { sequence: '2' }),
      probeRecord('MBO', 0n, { sequence: '1' }),
      probeRecord('MBO', 20_000_000n, { sequence: '2' }),
    ]);

    expect(report.classification).toBe('bounded_out_of_order_delivery');
    expect(report.streams.L1_QUOTE).toMatchObject({
      non_decreasing: false,
      violation_count: 1,
      max_negative_delta_ns: '1000000',
    });
    expect(
      report.disorder_window_analysis.L1_QUOTE.windows.find((window) => window.window_ms === 1),
    ).toMatchObject({
      would_resolve_local_decreases: true,
    });
  });

  it('classifies large repeated quote/book decreases as state stream behavior', () => {
    const rows: Record<string, unknown>[] = [];
    for (let index = 0; index < 300; index += 1) {
      const pairBase = BigInt(Math.floor(index / 2)) * 2_000_000n;
      const offset = index % 2 === 0 ? pairBase + 1_000_000n : pairBase;
      rows.push(probeRecord('MBP10', offset));
    }
    rows.push(probeRecord('LAST_TRADE', 0n, { sequence: '1' }));
    rows.push(probeRecord('LAST_TRADE', 600_000_000n, { sequence: '2' }));
    rows.push(probeRecord('MBO', 0n, { sequence: '1' }));
    rows.push(probeRecord('MBO', 600_000_000n, { sequence: '2' }));

    const report = analyze(rows);

    expect(report.classification).toBe('state_stream_not_strict_event_stream');
    expect(report.streams.MBP10?.violation_count).toBeGreaterThanOrEqual(100);
    expect(report.recommendation.infra01b_gate_options.require_strict_monotonic_only_for_mbo_and_last_trade).toBe(true);
  });

  it('reports when sequence remains monotonic while timestamps decrease', () => {
    const report = analyze([
      probeRecord('MBO', 2_000_000n, { sequence: '100' }),
      probeRecord('MBO', 1_000_000n, { sequence: '101' }),
      probeRecord('MBO', 3_000_000n, { sequence: '102' }),
    ]);

    expect(report.classification).toBe('extraction_bug_suspected');
    expect(report.sequence_analysis.MBO).toMatchObject({
      sequence_present_count: 3,
      sequence_monotonic: true,
      timestamp_decrease_with_sequence_monotonic_count: 1,
    });
    expect(report.sequence_analysis.MBO.first_sequence_timestamp_violation).toMatchObject({
      previous_sequence: '100',
      current_sequence: '101',
      sequence_delta: '1',
    });
  });

  it('writes a stable report shape', () => {
    const probePath = writeProbe([
      probeRecord('L1_QUOTE', 0n),
      probeRecord('L1_QUOTE', 1_000_000n),
      probeRecord('MBP10', 0n),
      probeRecord('MBP10', 1_000_000n),
    ]);
    const directory = makeTempDir();
    const outPath = join(directory, 'report.json');
    const report = analyzeRithmicTimestampOrder({ probe_path: probePath });

    writeTimestampOrderReport(report, outPath);
    const parsed = JSON.parse(readFileSync(outPath, 'utf8')) as TimestampOrderReport;

    expect(parsed).toMatchObject({
      schema_version: 1,
      ticket_id: 'INFRA-01C',
      classification: 'inconclusive',
      summary: {
        total_records: 4,
        streams: ['L1_QUOTE', 'MBP10'],
        streams_with_violations: [],
      },
    });
    expect(Object.keys(parsed.streams)).toEqual(['L1_QUOTE', 'MBP10']);
    expect(parsed.cross_stream_analysis.pairs[1]).toMatchObject({
      pair: 'L1_QUOTE_vs_MBP10',
      overlap: true,
    });
  });
});
