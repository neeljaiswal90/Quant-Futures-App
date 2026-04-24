import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const START_TS_NS = 1_700_000_000_000_000_000n;
const THIRTY_MINUTES_NS = 30n * 60n * 1_000_000_000n;
const TWENTY_NINE_MINUTES_NS = 29n * 60n * 1_000_000_000n;
const TSX_CLI = resolve('node_modules/tsx/dist/cli.mjs');
const INFRA_CLI = resolve('scripts/infra/evaluate-infra-01-probe.ts');
const STREAMS = ['L1_QUOTE', 'LAST_TRADE', 'MBP10', 'MBO'] as const;

interface CliRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly report: Record<string, unknown>;
}

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-infra-01b-cli-'));
  tempDirectories.push(directory);
  return directory;
}

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function writeClock(directory: string, overrides: Record<string, unknown> = {}): string {
  const clockPath = join(directory, 'clock_sync.json');
  writeFileSync(
    clockPath,
    JSON.stringify({
      source: 'chrony',
      captured_at_ts_ns: START_TS_NS.toString(),
      synchronized: true,
      rms_offset_ms: 1.5,
      root_dispersion_ms: 8,
      observation_window_minutes: 60,
      ...overrides,
    }),
    'utf8',
  );
  return clockPath;
}

function writeProbe(directory: string, rows: readonly Record<string, unknown>[]): string {
  const probePath = join(directory, 'probe.jsonl');
  writeFileSync(probePath, `${rows.map(line).join('\n')}\n`, 'utf8');
  return probePath;
}

function currentRecord(
  streamId: string,
  eventTs: bigint,
  latencyMs: number,
): Record<string, unknown> {
  return {
    schema_version: 1,
    stream: streamId,
    exchange_event_ts_ns: eventTs.toString(),
    sidecar_recv_ts_ns: (eventTs + BigInt(latencyMs) * 1_000_000n).toString(),
    timestamp_source: 'source_nsecs',
    payload_kind: streamId,
  };
}

function legacyRecord(
  streamId: string,
  eventTs: bigint,
  latencyMs: number,
): Record<string, unknown> {
  return {
    stream: streamId,
    source_event_ts_ns: eventTs.toString(),
    received_at_epoch_ns: (eventTs + BigInt(latencyMs) * 1_000_000n).toString(),
  };
}

function allStreamsRows(latencyMs = 2, endLatencyMs = 3): Record<string, unknown>[] {
  return STREAMS.flatMap((stream, index) => {
    const offset = BigInt(index) * 1_000_000_000n;
    return [
      currentRecord(stream, START_TS_NS + offset, latencyMs),
      currentRecord(stream, START_TS_NS + THIRTY_MINUTES_NS + offset, endLatencyMs),
    ];
  });
}

function runCli(probePath: string, clockPath: string, outPath: string): CliRunResult {
  const result = spawnSync(
    process.execPath,
    [TSX_CLI, INFRA_CLI, '--probe', probePath, '--clock', clockPath, '--out', outPath],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    report: JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>,
  };
}

describe('INFRA-01B canonical exchange-time probe CLI', () => {
  it('passes canonical coverage and non-decreasing checks for a valid 35-minute all-stream probe', () => {
    const directory = makeTempDir();
    const probePath = writeProbe(directory, allStreamsRows());
    const clockPath = writeClock(directory);
    const outPath = join(directory, 'report.json');

    const result = runCli(probePath, clockPath, outPath);

    expect(result.status).toBe(0);
    expect(result.report.status).toBe('pass');
    expect(result.report.data01_conceptually_unblocked).toBe(true);
    expect(result.report.data01_eligible).toBe(false);
    expect(result.report.route_to).toBe('INFRA-01');
    expect(result.report.input_validation).toEqual({ pass: true, reasons: [] });
    expect(result.report.exchange_timestamp_coverage).toMatchObject({
      pass: true,
      coverage_ratio: 1,
      market_data_records: 8,
      valid_exchange_timestamp_records: 8,
      ignored_startup_control_records: 0,
    });
    expect(result.report.canonical_event_time).toMatchObject({
      pass: true,
      missing_streams: [],
      present_streams: ['L1_QUOTE', 'LAST_TRADE', 'MBP10', 'MBO'],
    });
    expect(result.report.per_stream_monotonicity).toMatchObject({ pass: true });
    expect(result.report.receive_latency_telemetry).toMatchObject({ pass: true });
    expect(result.report.databento_overlap_parity).toMatchObject({
      present: false,
      status: 'pending',
    });
    expect(result.report.failure_classification).toEqual({});
    expect(result.stdout).toContain('route to INFRA-01 verification');
  });

  it('normalizes legacy timestamp field names', () => {
    const directory = makeTempDir();
    const rows = STREAMS.flatMap((stream, index) => {
      const offset = BigInt(index) * 1_000_000_000n;
      return [
        legacyRecord(stream, START_TS_NS + offset, 2),
        legacyRecord(stream, START_TS_NS + THIRTY_MINUTES_NS + offset, 3),
      ];
    });
    const probePath = writeProbe(directory, rows);
    const clockPath = writeClock(directory);
    const outPath = join(directory, 'legacy-report.json');

    const result = runCli(probePath, clockPath, outPath);

    expect(result.status).toBe(0);
    expect(result.report.status).toBe('pass');
    expect(result.report.records_by_stream).toEqual({
      L1_QUOTE: 2,
      LAST_TRADE: 2,
      MBP10: 2,
      MBO: 2,
    });
  });

  it('ignores documented startup/control records with null exchange timestamps', () => {
    const directory = makeTempDir();
    const probePath = writeProbe(directory, [
      {
        schema_version: 1,
        stream: 'CONTROL',
        exchange_event_ts_ns: null,
        sidecar_recv_ts_ns: (START_TS_NS + 1_000_000n).toString(),
        timestamp_source: 'unavailable',
        payload_kind: 'StartupControl',
      },
      ...allStreamsRows(),
    ]);
    const clockPath = writeClock(directory);
    const outPath = join(directory, 'startup-report.json');

    const result = runCli(probePath, clockPath, outPath);

    expect(result.status).toBe(0);
    expect(result.report.status).toBe('pass');
    expect(result.report.ignored_records).toBe(1);
    expect(result.report.exchange_timestamp_coverage).toMatchObject({
      pass: true,
      coverage_ratio: 1,
      market_data_records: 8,
      ignored_startup_control_records: 1,
    });
  });

  it('fails the gate when missing exchange timestamps exceed the coverage threshold', () => {
    const directory = makeTempDir();
    const rows = [
      ...allStreamsRows(),
      {
        schema_version: 1,
        stream: 'LAST_TRADE',
        exchange_event_ts_ns: null,
        sidecar_recv_ts_ns: (START_TS_NS + 2_000_000n).toString(),
        timestamp_source: 'unavailable',
        payload_kind: 'LastTrade',
      },
    ];
    const probePath = writeProbe(directory, rows);
    const clockPath = writeClock(directory);
    const outPath = join(directory, 'coverage-report.json');

    const result = runCli(probePath, clockPath, outPath);

    expect(result.status).toBe(2);
    expect(result.report.status).toBe('fail');
    expect(result.report.route_to).toBe('INFRA-01B');
    expect(result.report.input_validation).toEqual({ pass: true, reasons: [] });
    expect(result.report.failure_classification).toMatchObject({
      primary: 'canonical_event_time_failure',
    });
    expect(result.report.exchange_timestamp_coverage).toMatchObject({
      pass: false,
      market_data_records: 9,
      valid_exchange_timestamp_records: 8,
      missing_exchange_timestamp_records: 1,
    });
  });

  it('fails when exchange_event_ts_ns decreases within a stream but allows equal timestamps', () => {
    const directory = makeTempDir();
    const rows = [
      currentRecord('L1_QUOTE', START_TS_NS, 2),
      currentRecord('L1_QUOTE', START_TS_NS, 2),
      currentRecord('L1_QUOTE', START_TS_NS - 1_000_000n, 2),
      currentRecord('L1_QUOTE', START_TS_NS + THIRTY_MINUTES_NS, 2),
      ...STREAMS.filter((stream) => stream !== 'L1_QUOTE').flatMap((stream, index) => {
        const offset = BigInt(index + 1) * 1_000_000_000n;
        return [
          currentRecord(stream, START_TS_NS + offset, 2),
          currentRecord(stream, START_TS_NS + THIRTY_MINUTES_NS + offset, 3),
        ];
      }),
    ];
    const probePath = writeProbe(directory, rows);
    const clockPath = writeClock(directory);
    const outPath = join(directory, 'monotonic-report.json');

    const result = runCli(probePath, clockPath, outPath);

    expect(result.status).toBe(2);
    expect(result.report.status).toBe('fail');
    expect(result.report.failure_classification).toMatchObject({
      primary: 'canonical_event_time_failure',
    });
    expect(result.report.per_stream_monotonicity).toMatchObject({ pass: false });
    expect(
      (
        result.report.per_stream_monotonicity as {
          streams: readonly { stream_id: string; violation_count: number }[];
        }
      ).streams.find((stream) => stream.stream_id === 'L1_QUOTE'),
    ).toMatchObject({ violation_count: 1 });
  });

  it('routes failed receive-clock telemetry to INFRA-01B without marking the input invalid', () => {
    const directory = makeTempDir();
    const probePath = writeProbe(directory, allStreamsRows(-5, 650));
    const clockPath = writeClock(directory);
    const outPath = join(directory, 'telemetry-report.json');

    const result = runCli(probePath, clockPath, outPath);

    expect(result.status).toBe(2);
    expect(result.report.status).toBe('fail');
    expect(result.report.data01_conceptually_unblocked).toBe(true);
    expect(result.report.route_to).toBe('INFRA-01B');
    expect(result.report.input_validation).toEqual({ pass: true, reasons: [] });
    expect(result.report.failure_classification).toMatchObject({
      primary: 'telemetry_clock_health_issue',
    });
    expect(result.report.receive_latency_telemetry).toMatchObject({ pass: false });
  });

  it('treats a valid probe plus failed Windows-style clock evidence as a failed gate, not invalid input', () => {
    const directory = makeTempDir();
    const probePath = writeProbe(directory, allStreamsRows());
    const clockPath = writeClock(directory, {
      source: 'ntp',
      rms_offset_ms: undefined,
      root_dispersion_ms: undefined,
      observation_window_minutes: 60,
      mean_offset_ms: 192.0,
      dispersion_ms: 8218.9,
    });
    const outPath = join(directory, 'clock-report.json');

    const result = runCli(probePath, clockPath, outPath);

    expect(result.status).toBe(2);
    expect(result.report.status).toBe('fail');
    expect(result.report.input_validation).toEqual({ pass: true, reasons: [] });
    expect(result.report.data01_conceptually_unblocked).toBe(true);
    expect(result.report.failure_classification).toMatchObject({
      primary: 'clock_evidence_incomplete',
    });
    expect(result.report.clock_evidence).toMatchObject({
      pass: false,
      source: 'ntp',
      mean_offset_ms: 192,
      dispersion_ms: 8218.9,
      canonical_event_time_blocker: false,
    });
  });

  it('exits 3 with invalid status when probe duration is shorter than 30 minutes', () => {
    const directory = makeTempDir();
    const rows = STREAMS.flatMap((stream, index) => {
      const offset = BigInt(index) * 1_000_000_000n;
      return [
        currentRecord(stream, START_TS_NS + offset, 2),
        currentRecord(stream, START_TS_NS + TWENTY_NINE_MINUTES_NS + offset, 3),
      ];
    });
    const probePath = writeProbe(directory, rows);
    const clockPath = writeClock(directory);
    const outPath = join(directory, 'short-report.json');

    const result = runCli(probePath, clockPath, outPath);

    expect(result.status).toBe(3);
    expect(result.report.status).toBe('invalid');
    expect(result.report.route_to).toBe('INFRA-01B');
    expect(result.report.input_validation).toMatchObject({ pass: false });
    expect(
      (result.report.input_validation as { reasons: readonly { code: string }[] }).reasons.map(
        (reason) => reason.code,
      ),
    ).toContain('probe_duration_too_short');
  });

  it('exits 3 and writes an invalid report when JSONL is invalid', () => {
    const directory = makeTempDir();
    const probePath = join(directory, 'bad.jsonl');
    writeFileSync(probePath, '{"stream":"L1_QUOTE"\n', 'utf8');
    const clockPath = writeClock(directory);
    const outPath = join(directory, 'bad-report.json');

    const result = runCli(probePath, clockPath, outPath);

    expect(result.status).toBe(3);
    expect(result.report.status).toBe('invalid');
    expect(result.report.failure_classification).toEqual({ primary: 'invalid_input' });
    expect((result.report.input_validation as { reasons: readonly { message: string }[] }).reasons[0]?.message).toContain(
      'invalid JSON',
    );
  });

  it('exits 3 and writes an invalid report when the probe file is missing', () => {
    const directory = makeTempDir();
    const probePath = join(directory, 'missing.jsonl');
    const clockPath = writeClock(directory);
    const outPath = join(directory, 'missing-report.json');

    const result = runCli(probePath, clockPath, outPath);

    expect(result.status).toBe(3);
    expect(result.report.status).toBe('invalid');
    expect((result.report.input_validation as { reasons: readonly { message: string }[] }).reasons[0]?.message).toContain(
      'missing.jsonl',
    );
  });

  it('fails the gate when any V1 stream is missing', () => {
    const directory = makeTempDir();
    const probePath = writeProbe(
      directory,
      allStreamsRows().filter((row) => row.stream !== 'MBO'),
    );
    const clockPath = writeClock(directory);
    const outPath = join(directory, 'missing-stream-report.json');

    const result = runCli(probePath, clockPath, outPath);

    expect(result.status).toBe(2);
    expect(result.report.status).toBe('fail');
    expect(result.report.canonical_event_time).toMatchObject({
      pass: false,
      missing_streams: ['MBO'],
    });
    expect(result.report.failure_classification).toMatchObject({
      primary: 'canonical_event_time_failure',
    });
  });

  it('exits 3 and writes an invalid report when clock source is unsupported', () => {
    const directory = makeTempDir();
    const probePath = writeProbe(directory, allStreamsRows());
    const clockPath = writeClock(directory, { source: 'bad-clock-source' });
    const outPath = join(directory, 'invalid-clock-report.json');

    const result = runCli(probePath, clockPath, outPath);

    expect(result.status).toBe(3);
    expect(result.report.status).toBe('invalid');
    expect((result.report.input_validation as { reasons: readonly { message: string }[] }).reasons[0]?.message).toContain(
      'clock_evidence.source must be one of chrony, ntp, ptp, manual, unknown',
    );
  });
});
