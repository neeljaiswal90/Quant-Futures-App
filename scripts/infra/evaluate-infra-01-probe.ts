#!/usr/bin/env tsx

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  evaluateCanonicalExchangeTimeGate,
  type CanonicalExchangeTimeProbeRecord,
  type CanonicalExchangeTimeReport,
  type ClockDisciplineSource,
  type DatabentoOverlapParityReport,
  type Infra01bClockEvidence,
} from '../../apps/strategy_runtime/src/infra/index.js';
import { stableJsonStringify, type JsonValue } from '../../apps/strategy_runtime/src/contracts/index.js';

type CliReport = CanonicalExchangeTimeReport | InvalidInputReport;

interface InvalidInputReport {
  readonly ticket_id: 'INFRA-01B';
  readonly status: 'invalid';
  readonly data01_conceptually_unblocked: false;
  readonly data01_eligible: false;
  readonly route_to: 'INFRA-01B';
  readonly input_validation: {
    readonly pass: false;
    readonly reasons: readonly {
      readonly code: 'invalid_input';
      readonly path: '$';
      readonly message: string;
    }[];
  };
  readonly ignored_records: number;
  readonly records_by_stream: Readonly<Record<string, number>>;
  readonly failure_classification: {
    readonly primary: 'invalid_input';
  };
  readonly recommended_next_ticket: 'INFRA-01B';
  readonly issues: readonly {
    readonly code: 'invalid_input';
    readonly path: '$';
    readonly message: string;
  }[];
  readonly error: string;
}

interface CliArgs {
  readonly probePath: string;
  readonly clockPath: string;
  readonly outPath: string;
  readonly databentoParityPath?: string;
}

interface ProbeReadResult {
  readonly records: readonly CanonicalExchangeTimeProbeRecord[];
  readonly recordsByStream: Readonly<Record<string, number>>;
}

const CLOCK_SOURCES = new Set<ClockDisciplineSource>(['chrony', 'ntp', 'ptp', 'manual', 'unknown']);
const DEFAULT_REPORT_PATH = 'reports/infra/infra01b_canonical_exchange_time_report.json';

function usage(): string {
  return [
    'Usage: npm run infra:01:evaluate -- --probe <probe.jsonl> --clock <clock_sync.json> [--out <report.json>] [--databento-parity <report.json>]',
    '',
    'Probe JSONL records must include either:',
    '  exchange_event_ts_ns + sidecar_recv_ts_ns',
    '  source_event_ts_ns + received_at_epoch_ns',
    '',
    `Default --out: ${DEFAULT_REPORT_PATH}`,
  ].join('\n');
}

function parseArgs(argv: readonly string[]): CliArgs {
  let probePath: string | undefined;
  let clockPath: string | undefined;
  let outPath: string | undefined;
  let databentoParityPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      throw new Error(usage());
    }
    if (arg === '--probe') {
      probePath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--clock') {
      clockPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--out') {
      outPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--databento-parity') {
      databentoParityPath = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }

  if (!probePath) {
    throw new Error(`--probe is required\n${usage()}`);
  }
  if (!clockPath) {
    throw new Error(`--clock is required\n${usage()}`);
  }

  return {
    probePath,
    clockPath,
    outPath: outPath ?? DEFAULT_REPORT_PATH,
    ...(databentoParityPath === undefined ? {} : { databentoParityPath }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstField(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(record, key)) {
      return record[key];
    }
  }
  return undefined;
}

function hasAnyField(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => Object.hasOwn(record, key));
}

function requireNumber(record: Record<string, unknown>, keys: readonly string[], path: string): number {
  const value = firstField(record, keys);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function optionalNumber(record: Record<string, unknown>, keys: readonly string[], path: string): number | undefined {
  const value = firstField(record, keys);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function timestampField(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): string | number | bigint {
  const value = firstField(record, keys);
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error(`${path} must be a nanosecond timestamp string or safe integer`);
  }
  return value;
}

function nullableTimestampField(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): string | number | bigint | null {
  if (!hasAnyField(record, keys)) {
    throw new Error(`${path} is required`);
  }

  const value = firstField(record, keys);
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error(`${path} must be a nanosecond timestamp string, safe integer, or null`);
  }
  return value;
}

function optionalTimestampField(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): string | number | bigint | null | undefined {
  const value = firstField(record, keys);
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error(`${path} must be a nanosecond timestamp string, safe integer, or null`);
  }
  return value;
}

function normalizeStreamId(record: Record<string, unknown>, lineNumber: number): string {
  const value = firstField(record, ['stream_id', 'stream', 'event_type', 'type']);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`probe line ${lineNumber}: stream_id, stream, event_type, or type is required`);
  }
  return value.trim();
}

function normalizeProbeRecord(record: unknown, lineNumber: number): CanonicalExchangeTimeProbeRecord {
  if (!isRecord(record)) {
    throw new Error(`probe line ${lineNumber}: JSON value must be an object`);
  }

  const schemaVersion = record.schema_version;
  if (schemaVersion !== undefined && schemaVersion !== 1) {
    throw new Error(`probe line ${lineNumber}: unsupported schema_version ${String(schemaVersion)}`);
  }

  const sequence = record.sequence;
  if (
    sequence !== undefined &&
    typeof sequence !== 'string' &&
    (typeof sequence !== 'number' || !Number.isSafeInteger(sequence))
  ) {
    throw new Error(`probe line ${lineNumber}: sequence must be a string or safe integer`);
  }

  const rithmicPublishTs = optionalTimestampField(
    record,
    ['rithmic_publish_ts_ns', 'rithmic_gateway_send_ts_ns'],
    `probe line ${lineNumber}: rithmic_publish_ts_ns/rithmic_gateway_send_ts_ns`,
  );
  const timestampSource = record.timestamp_source;
  const payloadKind = record.payload_kind;
  const isStartupOrControl = record.is_startup_or_control;

  if (timestampSource !== undefined && typeof timestampSource !== 'string') {
    throw new Error(`probe line ${lineNumber}: timestamp_source must be a string when provided`);
  }
  if (payloadKind !== undefined && typeof payloadKind !== 'string') {
    throw new Error(`probe line ${lineNumber}: payload_kind must be a string when provided`);
  }
  if (isStartupOrControl !== undefined && typeof isStartupOrControl !== 'boolean') {
    throw new Error(`probe line ${lineNumber}: is_startup_or_control must be a boolean when provided`);
  }

  return {
    stream_id: normalizeStreamId(record, lineNumber),
    exchange_event_ts_ns: nullableTimestampField(
      record,
      ['exchange_event_ts_ns', 'source_event_ts_ns'],
      `probe line ${lineNumber}: exchange_event_ts_ns/source_event_ts_ns`,
    ),
    sidecar_recv_ts_ns: timestampField(
      record,
      ['sidecar_recv_ts_ns', 'received_at_epoch_ns'],
      `probe line ${lineNumber}: sidecar_recv_ts_ns/received_at_epoch_ns`,
    ),
    ...(rithmicPublishTs === undefined ? {} : { rithmic_publish_ts_ns: rithmicPublishTs }),
    ...(sequence === undefined ? {} : { sequence }),
    ...(timestampSource === undefined ? {} : { timestamp_source: timestampSource }),
    ...(payloadKind === undefined ? {} : { payload_kind: payloadKind }),
    ...(isStartupOrControl === undefined ? {} : { is_startup_or_control: isStartupOrControl }),
  };
}

async function readProbeJsonl(path: string): Promise<ProbeReadResult> {
  const source = await readFile(path, 'utf8');
  const records: CanonicalExchangeTimeProbeRecord[] = [];
  const recordsByStream: Record<string, number> = {};

  source.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `probe line ${index + 1}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const normalized = normalizeProbeRecord(parsed, index + 1);
    recordsByStream[normalized.stream_id] = (recordsByStream[normalized.stream_id] ?? 0) + 1;
    records.push(normalized);
  });

  return { records, recordsByStream };
}

function normalizeClockSource(value: unknown): ClockDisciplineSource {
  if (typeof value !== 'string' || !CLOCK_SOURCES.has(value as ClockDisciplineSource)) {
    throw new Error('clock_evidence.source must be one of chrony, ntp, ptp, manual, unknown');
  }
  return value as ClockDisciplineSource;
}

async function readClockEvidence(path: string): Promise<Infra01bClockEvidence> {
  const source = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`clock file is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error('clock file must contain a JSON object');
  }

  const clockRecord = isRecord(parsed.clock_evidence)
    ? parsed.clock_evidence
    : isRecord(parsed.clock_sync)
      ? parsed.clock_sync
      : parsed;
  const synchronized = optionalBoolean(clockRecord, 'synchronized', 'clock_evidence.synchronized');
  const capturedAt = optionalTimestampField(
    clockRecord,
    ['captured_at_ts_ns'],
    'clock_evidence.captured_at_ts_ns',
  );

  return {
    source: normalizeClockSource(clockRecord.source),
    ...(capturedAt === undefined || capturedAt === null ? {} : { captured_at_ts_ns: capturedAt }),
    ...(synchronized === undefined ? {} : { synchronized }),
    ...optionalNumberObject(clockRecord, ['rms_offset_ms'], 'rms_offset_ms'),
    ...optionalNumberObject(clockRecord, ['root_dispersion_ms'], 'root_dispersion_ms'),
    ...optionalNumberObject(clockRecord, ['observation_window_minutes'], 'observation_window_minutes'),
    ...optionalNumberObject(clockRecord, ['observation_window_seconds'], 'observation_window_seconds'),
    ...optionalNumberObject(clockRecord, ['mean_offset_ms', 'offset_ms'], 'mean_offset_ms'),
    ...optionalNumberObject(clockRecord, ['dispersion_ms'], 'dispersion_ms'),
    ...(typeof clockRecord.notes === 'string' ? { notes: clockRecord.notes } : {}),
  };
}

function optionalNumberObject(
  record: Record<string, unknown>,
  keys: readonly string[],
  outputKey: keyof Omit<Infra01bClockEvidence, 'source'>,
): Partial<Infra01bClockEvidence> {
  const value = optionalNumber(record, keys, `clock_evidence.${String(outputKey)}`);
  return value === undefined ? {} : { [outputKey]: value };
}

async function readDatabentoParity(path: string): Promise<DatabentoOverlapParityReport> {
  const source = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Databento parity report is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error('Databento parity report must contain a JSON object');
  }

  const parityRecord = isRecord(parsed.databento_overlap_parity) ? parsed.databento_overlap_parity : parsed;
  const status = parityRecord.status;
  if (status !== 'pass' && status !== 'fail' && status !== 'pending') {
    throw new Error('Databento parity status must be pass, fail, or pending');
  }

  return {
    present: true,
    status,
    report_path: resolve(path),
    ...(typeof parityRecord.summary === 'string' ? { summary: parityRecord.summary } : {}),
    ...(typeof parityRecord.notes === 'string' ? { notes: parityRecord.notes } : {}),
    ...optionalParityNumberObject(parityRecord, 'matched_windows'),
    ...optionalParityNumberObject(parityRecord, 'unmatched_event_count'),
    ...optionalParityNumberObject(parityRecord, 'max_price_alignment_ticks'),
  };
}

function optionalParityNumberObject(
  record: Record<string, unknown>,
  key: keyof DatabentoOverlapParityReport,
): Partial<DatabentoOverlapParityReport> {
  const value = record[key];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Databento parity ${String(key)} must be a finite number`);
  }
  return { [key]: value };
}

function compareTimestampInputs(a: string | number | bigint, b: string | number | bigint): number {
  const left = BigInt(a);
  const right = BigInt(b);
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function deriveProbeBounds(records: readonly CanonicalExchangeTimeProbeRecord[]): {
  readonly started_at_ts_ns: string | number | bigint;
  readonly ended_at_ts_ns: string | number | bigint;
} {
  const eventTimestamps = records
    .map((record) => record.exchange_event_ts_ns)
    .filter((value): value is string | number | bigint => value !== null);

  if (eventTimestamps.length === 0) {
    throw new Error('probe file contains no usable records with exchange_event_ts_ns');
  }

  const sorted = [...eventTimestamps].sort(compareTimestampInputs);
  return {
    started_at_ts_ns: sorted[0]!,
    ended_at_ts_ns: sorted[sorted.length - 1]!,
  };
}

async function writeJsonReport(path: string, report: CliReport): Promise<void> {
  const resolved = resolve(path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, `${stableJsonStringify(report as unknown as JsonValue)}\n`, 'utf8');
}

function invalidReport(error: unknown, probe: ProbeReadResult): InvalidInputReport {
  const message = error instanceof Error ? error.message : String(error);
  const reason = {
    code: 'invalid_input' as const,
    path: '$' as const,
    message,
  };

  return {
    ticket_id: 'INFRA-01B',
    status: 'invalid',
    data01_conceptually_unblocked: false,
    data01_eligible: false,
    route_to: 'INFRA-01B',
    input_validation: {
      pass: false,
      reasons: [reason],
    },
    ignored_records: 0,
    records_by_stream: probe.recordsByStream,
    failure_classification: {
      primary: 'invalid_input',
    },
    recommended_next_ticket: 'INFRA-01B',
    issues: [reason],
    error: message,
  };
}

function exitCodeForReport(report: CliReport): number {
  if (report.status === 'pass') {
    return 0;
  }
  if (report.status === 'fail') {
    return 2;
  }
  return 3;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  let probe: ProbeReadResult = {
    records: [],
    recordsByStream: {},
  };
  let report: CliReport;

  try {
    const [probeResult, clockEvidence, databentoParity] = await Promise.all([
      readProbeJsonl(args.probePath),
      readClockEvidence(args.clockPath),
      args.databentoParityPath === undefined
        ? Promise.resolve(undefined)
        : readDatabentoParity(args.databentoParityPath),
    ]);
    probe = probeResult;
    const bounds = deriveProbeBounds(probe.records);
    report = evaluateCanonicalExchangeTimeGate({
      probe_id: resolve(args.probePath),
      started_at_ts_ns: bounds.started_at_ts_ns,
      ended_at_ts_ns: bounds.ended_at_ts_ns,
      records: probe.records,
      records_by_stream: probe.recordsByStream,
      clock_evidence: clockEvidence,
      databento_overlap_parity: databentoParity,
    });
  } catch (error) {
    report = invalidReport(error, probe);
  }

  await writeJsonReport(args.outPath, report);
  if (report.status === 'pass') {
    console.log('INFRA-01B exchange-time evidence passed; route to INFRA-01 verification.');
  } else if (report.status === 'fail') {
    console.error('INFRA-01B exchange-time gate failed; route remains INFRA-01B.');
  } else {
    console.error('INFRA-01B probe input is invalid or incomplete; collect valid evidence before routing.');
  }
  return exitCodeForReport(report);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 3;
  });
