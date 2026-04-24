import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ns } from '../../src/contracts/index.js';
import {
  DEFAULT_INFRA_01_THRESHOLDS,
  evaluateTimestampReprobe,
  type ClockDisciplineSnapshot,
  type TimestampProbeSample,
} from '../../src/infra/index.js';

const START_TS_NS = 1_700_000_000_000_000_000n;
const THIRTY_MINUTES_NS = 30n * 60n * 1_000_000_000n;
const ONE_MINUTE_NS = 60n * 1_000_000_000n;

function sample(streamId: string, sequence: number, latencyMs: number): TimestampProbeSample {
  const exchangeTs = START_TS_NS + BigInt(sequence) * 1_000_000_000n;
  const latencyNs = BigInt(latencyMs) * 1_000_000n;

  return {
    stream_id: streamId,
    sequence,
    exchange_event_ts_ns: exchangeTs,
    rithmic_publish_ts_ns: exchangeTs + 500_000n,
    sidecar_recv_ts_ns: exchangeTs + latencyNs,
  };
}

function healthyClock(overrides: Partial<ClockDisciplineSnapshot> = {}): ClockDisciplineSnapshot {
  return {
    source: 'chrony',
    captured_at_ts_ns: START_TS_NS,
    mean_offset_ms: 1.25,
    dispersion_ms: 12,
    synchronized: true,
    ...overrides,
  };
}

function passingSamples(): readonly TimestampProbeSample[] {
  return [
    sample('QUOTE', 1, 1),
    sample('QUOTE', 2, 2),
    sample('QUOTE', 3, 3),
    sample('TRADE', 4, 4),
    sample('TRADE', 5, 5),
    sample('TRADE', 6, 6),
  ];
}

function failingLatencySamples(): readonly TimestampProbeSample[] {
  return [
    sample('QUOTE', 1, -5),
    sample('QUOTE', 2, -2),
    sample('QUOTE', 3, 1),
    sample('TRADE', 4, 1),
    sample('TRADE', 5, 2),
    sample('TRADE', 6, 250),
  ];
}

function listInfraFiles(directory = join(process.cwd(), 'apps/strategy_runtime/src/infra')): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return listInfraFiles(path);
    }
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

describe('INFRA-01 timestamp validation', () => {
  it('unblocks DATA-01 only when clock sync and latency re-probe both pass', () => {
    const report = evaluateTimestampReprobe({
      probe_id: 'infra-01-reprobe-rth-001',
      started_at_ts_ns: START_TS_NS,
      ended_at_ts_ns: START_TS_NS + THIRTY_MINUTES_NS,
      clock: healthyClock(),
      samples: passingSamples(),
    });

    expect(report.status).toBe('pass');
    expect(report.data_01_gate).toBe('unblocked');
    expect(report.infra_01b_required).toBe(false);
    expect(report.recommended_next_ticket).toBe('DATA-01');
    expect(report.failure_lane).toBeUndefined();
    expect(report.secondary_failure_lane).toBeUndefined();
    expect(report.issues).toEqual([]);
    expect(report.clock_sync.passes).toBe(true);
    expect(report.latency_reprobe.passes).toBe(true);
    expect(report.latency_reprobe.evidence_complete).toBe(true);
    expect(report.latency_reprobe.probe.duration_minutes).toBe(30);
    expect(report.latency_reprobe.probe.sample_count).toBe(6);
    expect(report.latency_reprobe.streams.map((stream) => stream.stream_id)).toEqual([
      'QUOTE',
      'TRADE',
    ]);
    expect(report.latency_reprobe.streams[0]).toMatchObject({
      stream_id: 'QUOTE',
      p50_latency_ms: 2,
      p99_latency_ms: 3,
      passes: true,
    });
    expect(report.clock_sync.thresholds).toEqual({
      max_abs_mean_offset_ms: 5,
      max_dispersion_ms: 20,
    });
    expect(report.latency_reprobe.thresholds).toEqual({
      required_duration_minutes: 30,
      max_abs_median_latency_ms: 10,
      max_p99_latency_ms: 200,
      min_samples_per_stream: 1,
      allow_negative_p50_latency: false,
    });
    expect(DEFAULT_INFRA_01_THRESHOLDS.clock_sync.max_abs_mean_offset_ms).toBe(5);
    expect(DEFAULT_INFRA_01_THRESHOLDS.clock_sync.max_dispersion_ms).toBe(20);
  });

  it('routes healthy-clock negative p50 or heavy-tail latency failures to INFRA-01B timestamp semantics analysis', () => {
    const report = evaluateTimestampReprobe({
      probe_id: 'infra-01-reprobe-rth-002',
      started_at_ts_ns: START_TS_NS,
      ended_at_ts_ns: START_TS_NS + THIRTY_MINUTES_NS,
      clock: healthyClock(),
      samples: failingLatencySamples(),
    });

    expect(report.status).toBe('fail');
    expect(report.data_01_gate).toBe('blocked');
    expect(report.infra_01b_required).toBe(true);
    expect(report.failure_lane).toBe('timestamp_semantics_mismatch');
    expect(report.secondary_failure_lane).toBeUndefined();
    expect(report.recommended_next_ticket).toBe('INFRA-01B');
    expect(report.recommended_action).toContain('without arbitrary offsets');
    expect(report.clock_sync.passes).toBe(true);
    expect(report.latency_reprobe.passes).toBe(false);
    expect(report.latency_reprobe.issues.map((issue) => issue.code)).toEqual([
      'negative_p50_latency',
      'p99_latency_out_of_range',
    ]);
    expect(report.latency_reprobe.streams.find((stream) => stream.stream_id === 'QUOTE')).toMatchObject(
      {
        p50_latency_ms: -2,
        negative_p50_latency: true,
        passes: false,
      },
    );
    expect(report.latency_reprobe.streams.find((stream) => stream.stream_id === 'TRADE')).toMatchObject(
      {
        p99_latency_ms: 250,
        p99_within_threshold: false,
        passes: false,
      },
    );
  });

  it('routes unhealthy clock sync evidence to INFRA-01B clock-discipline analysis', () => {
    const report = evaluateTimestampReprobe({
      probe_id: 'infra-01-reprobe-rth-003',
      started_at_ts_ns: START_TS_NS,
      ended_at_ts_ns: START_TS_NS + THIRTY_MINUTES_NS,
      clock: healthyClock({
        mean_offset_ms: 6,
        dispersion_ms: 25,
        synchronized: false,
      }),
      samples: passingSamples(),
    });

    expect(report.status).toBe('fail');
    expect(report.data_01_gate).toBe('blocked');
    expect(report.failure_lane).toBe('clock_discipline_failure');
    expect(report.secondary_failure_lane).toBeUndefined();
    expect(report.infra_01b_required).toBe(true);
    expect(report.clock_sync.passes).toBe(false);
    expect(report.latency_reprobe.passes).toBe(true);
    expect(report.recommended_action).toContain('consider PTP');
    expect(report.clock_sync.issues.map((issue) => issue.code)).toEqual([
      'clock_unsynchronized',
      'clock_mean_offset_out_of_range',
      'clock_dispersion_out_of_range',
    ]);
  });

  it('classifies clock sync as primary when clock and latency both fail', () => {
    const report = evaluateTimestampReprobe({
      probe_id: 'infra-01-reprobe-rth-004',
      started_at_ts_ns: START_TS_NS,
      ended_at_ts_ns: START_TS_NS + THIRTY_MINUTES_NS,
      clock: healthyClock({
        mean_offset_ms: -8,
        dispersion_ms: 24,
      }),
      samples: failingLatencySamples(),
    });

    expect(report.status).toBe('fail');
    expect(report.failure_lane).toBe('clock_discipline_failure');
    expect(report.secondary_failure_lane).toBe('timestamp_semantics_unresolved');
    expect(report.clock_sync.passes).toBe(false);
    expect(report.latency_reprobe.evidence_complete).toBe(true);
    expect(report.latency_reprobe.passes).toBe(false);
    expect(report.recommended_action).toContain('clock discipline failed');
  });

  it('keeps DATA-01 blocked for incomplete latency evidence without classifying a failed re-probe', () => {
    const report = evaluateTimestampReprobe({
      probe_id: 'infra-01-reprobe-short',
      started_at_ts_ns: START_TS_NS,
      ended_at_ts_ns: START_TS_NS + 29n * ONE_MINUTE_NS,
      clock: healthyClock(),
      samples: [],
    });

    expect(report.status).toBe('incomplete');
    expect(report.data_01_gate).toBe('blocked');
    expect(report.infra_01b_required).toBe(false);
    expect(report.failure_lane).toBeUndefined();
    expect(report.secondary_failure_lane).toBeUndefined();
    expect(report.recommended_next_ticket).toBe('INFRA-01');
    expect(report.clock_sync.passes).toBe(true);
    expect(report.latency_reprobe.evidence_complete).toBe(false);
    expect(report.latency_reprobe.passes).toBe(false);
    expect(report.latency_reprobe.issues.map((issue) => issue.code)).toEqual([
      'probe_duration_too_short',
      'no_probe_samples',
    ]);
  });

  it('reports invalid timestamp evidence with stable sectioned issue paths', () => {
    const report = evaluateTimestampReprobe({
      probe_id: 'infra-01-reprobe-invalid',
      started_at_ts_ns: START_TS_NS,
      ended_at_ts_ns: START_TS_NS + THIRTY_MINUTES_NS,
      clock: healthyClock(),
      samples: [
        {
          stream_id: 'QUOTE',
          exchange_event_ts_ns: 'not-a-timestamp',
          sidecar_recv_ts_ns: START_TS_NS + 1_000_000n,
        },
      ],
    });

    expect(report.status).toBe('incomplete');
    expect(report.data_01_gate).toBe('blocked');
    expect(report.latency_reprobe.probe.sample_count).toBe(0);
    expect(report.latency_reprobe.issues).toEqual([
      {
        code: 'invalid_timestamp',
        path: 'latency_reprobe.samples[0]',
        message: 'string nanosecond timestamp must be unsigned decimal digits',
      },
    ]);
  });

  it('keeps INFRA-01 deterministic and free of host wall-clock dependencies', () => {
    const forbiddenPatterns = [
      /\bDate\.now\b/,
      /\bnew Date\s*\(/,
      /\bMath\.random\b/,
      /\btoLocaleString\b/,
      /\blocaleCompare\b/,
    ];
    const findings = listInfraFiles().flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return forbiddenPatterns
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${file}: ${pattern}`);
    });

    expect(findings).toEqual([]);
  });

  it('preserves APP-02 bigint timestamp branding at the INFRA-01 boundary', () => {
    const report = evaluateTimestampReprobe({
      probe_id: 'infra-01-reprobe-branding',
      started_at_ts_ns: ns(START_TS_NS),
      ended_at_ts_ns: ns(START_TS_NS + THIRTY_MINUTES_NS),
      clock: healthyClock({ captured_at_ts_ns: ns(START_TS_NS) }),
      samples: [sample('QUOTE', 1, 2), sample('QUOTE', 2, 3), sample('QUOTE', 3, 4)],
    });

    expect(report.latency_reprobe.probe.started_at_ts_ns).toBe(ns(START_TS_NS));
    expect(report.latency_reprobe.probe.ended_at_ts_ns).toBe(ns(START_TS_NS + THIRTY_MINUTES_NS));
    expect(typeof report.latency_reprobe.probe.started_at_ts_ns).toBe('bigint');
    expect(typeof report.clock_sync.captured_at_ts_ns).toBe('bigint');
  });
});
