import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import {
  argv as processArgv,
  env as processEnv,
  exit as processExit,
  stderr as processStderr,
  stdout as processStdout,
} from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  LIMIT_QUEUE_FRONT_BUCKET,
  LIMIT_QUEUE_FRONT_BUCKET_ID,
  LIMIT_QUEUE_FRONT_OBSERVATION_SCHEMA_VERSION,
  LIMIT_QUEUE_FRONT_TARGET_METRIC,
  type JsonObject,
  type LimitQueueFrontObservation,
  isJsonObject,
  observationSchemaExample,
  validateLimitQueueFrontObservation,
} from './limit-queue-front-observation-schema.js';

export const SIM_03I_OBSERVATION_EXPORT_MANIFEST_SCHEMA_VERSION = 1 as const;
export const SIM_03I_TICKET_ID = 'SIM-03I' as const;

const DEFAULT_OUT_PATH = 'reports/sim/limit_queue_front_observations.jsonl';
const DEFAULT_MANIFEST_OUT_PATH = 'reports/sim/limit_queue_front_observations_manifest.json';
const DEFAULT_DBN_DECODER_PATH = 'scripts/sim/decode-databento-mbo-jsonl.py';
const DEFAULT_PROGRESS_EVERY_RECORDS = 1_000_000;
const MAX_HASH_FILE_BYTES = 64 * 1024 * 1024;

type SplitFilter = 'calibration' | 'validation' | 'both';
type ExportStatus =
  | 'exported'
  | 'requires_corpus_source'
  | 'requires_decoded_observation_source'
  | 'no_matching_observations'
  | 'split_leakage_detected';

export interface ExportLimitQueueFrontObservationsOptions {
  readonly cwd?: string;
  readonly calibration_report: string;
  readonly diagnosis_report: string;
  readonly corpus_root: string;
  readonly out?: string;
  readonly manifest_out?: string;
  readonly max_records?: number;
  readonly split?: SplitFilter;
  readonly generated_at_ts_ns?: string;
  readonly progress_log?: string;
  readonly progress_every_records?: number;
  readonly python?: string;
  readonly dbn_decoder?: string;
}

export interface ExportLimitQueueFrontObservationsResult {
  readonly manifest: JsonObject;
  readonly exit_code: 0 | 2;
}

interface SourceFile {
  readonly session_id: string;
  readonly split: 'calibration' | 'validation';
  readonly instrument: string;
  readonly path: string;
  readonly source_session_or_file: string;
}

interface LevelState {
  totalSize: number;
  orderCount: number;
}

interface OpenOrder {
  orderId: number;
  side: 'bid' | 'ask';
  price: number;
  size: number;
  addTsNs: number;
  queueAheadSize: number;
  queueAheadOrderCount: number;
}

interface ExportCounters {
  recordsScanned: number;
  observationsEmitted: number;
  calibrationCount: number;
  validationCount: number;
  skippedCountByReason: Record<string, number>;
  inputFiles: Array<{
    readonly path: string;
    readonly byte_count: number;
    readonly sha256?: string;
    readonly hash_status: 'hashed' | 'skipped_large_file';
  }>;
  calibrationSessionIds: Set<string>;
  validationSessionIds: Set<string>;
  dbnDecodedFiles: number;
}

export function exportLimitQueueFrontObservations(
  options: ExportLimitQueueFrontObservationsOptions,
): ExportLimitQueueFrontObservationsResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const calibrationReportPath = resolve(cwd, options.calibration_report);
  const diagnosisReportPath = resolve(cwd, options.diagnosis_report);
  const corpusRoot = resolve(cwd, options.corpus_root);
  const outPath = resolve(cwd, options.out ?? DEFAULT_OUT_PATH);
  const manifestOutPath = resolve(cwd, options.manifest_out ?? DEFAULT_MANIFEST_OUT_PATH);
  const split = options.split ?? 'both';
  const progressEveryRecords = options.progress_every_records ?? DEFAULT_PROGRESS_EVERY_RECORDS;
  const progressLogPath = options.progress_log === undefined ? null : resolve(cwd, options.progress_log);
  const python = options.python ?? processEnv.PYTHON ?? 'python';
  const dbnDecoderPath = resolve(cwd, options.dbn_decoder ?? DEFAULT_DBN_DECODER_PATH);

  const sourceText = readFileSync(calibrationReportPath, 'utf8');
  const diagnosisText = readFileSync(diagnosisReportPath, 'utf8');
  const sourceReportHash = sha256Text(sourceText);
  const diagnosisReportHash = sha256Text(diagnosisText);
  const sourceReport = parseJsonObject(sourceText, calibrationReportPath);
  const diagnosisReport = parseJsonObject(diagnosisText, diagnosisReportPath);
  validateDiagnosis(diagnosisReport);

  if (!existsSync(corpusRoot)) {
    const manifest = baseManifest({
      status: 'requires_corpus_source',
      sourceReportHash,
      diagnosisReportHash,
      corpusRoot,
      outPath,
      split,
      maxRecords: options.max_records ?? null,
      generatedAtTsNs: options.generated_at_ts_ns,
      progressLogPath,
      reason: `Corpus root not found: ${corpusRoot}`,
      sourceReport,
    });
    writeJson(manifestOutPath, manifest);
    return { manifest, exit_code: 2 };
  }

  const manifestPath = resolveManifestPath(cwd, calibrationReportPath, sourceReport);
  const sourceManifest = manifestPath === null ? null : parseJsonObject(readFileSync(manifestPath, 'utf8'), manifestPath);
  const sources = sourceManifest === null
    ? discoverSourceFiles(corpusRoot, split)
    : sourceFilesFromManifest(sourceManifest, corpusRoot, split);

  const counters: ExportCounters = {
    recordsScanned: 0,
    observationsEmitted: 0,
    calibrationCount: 0,
    validationCount: 0,
    skippedCountByReason: {},
    inputFiles: [],
    calibrationSessionIds: new Set(),
    validationSessionIds: new Set(),
    dbnDecodedFiles: 0,
  };
  const progress = new ProgressWriter(progressLogPath, progressEveryRecords);
  mkdirSync(dirname(outPath), { recursive: true });
  const observationWriter = new ObservationWriter(outPath);

  progress.emit('export_started', {
    corpus_root: corpusRoot,
    split,
    source_manifest_path: manifestPath,
  });

  try {
    for (const source of sources) {
      if (options.max_records !== undefined && counters.observationsEmitted >= options.max_records) {
        break;
      }
      progress.emit('file_started', {
        path: source.path,
        session_id: source.session_id,
        split: source.split,
      });
      const stats = statSync(source.path);
      counters.inputFiles.push({
        path: source.path,
        byte_count: stats.size,
        ...hashFileIfFeasible(source.path, stats.size),
      });
      const kind = sourceFileKind(source.path);
      if (kind === 'unsupported') {
        increment(counters.skippedCountByReason, 'unsupported_source_format_requires_decoded_jsonl');
        progress.emit('file_skipped', {
          path: source.path,
          reason: 'unsupported_source_format_requires_decoded_jsonl',
        });
        continue;
      }

      const decodedPath = kind === 'dbn'
        ? decodeDbnSource({
            source,
            cwd,
            python,
            dbnDecoderPath,
            progress,
            counters,
          })
        : source.path;
      if (decodedPath === null) {
        continue;
      }

      try {
        processDecodedSource({
          decodedPath,
          source,
          sourceReportHash,
          observationWriter,
          counters,
          progress,
          maxRecords: options.max_records,
        });
      } finally {
        if (decodedPath !== source.path) {
          rmSync(dirname(decodedPath), { recursive: true, force: true });
        }
      }
      progress.emit('file_completed', {
        path: source.path,
        session_id: source.session_id,
        split: source.split,
        records_scanned: counters.recordsScanned,
        observations_emitted: counters.observationsEmitted,
      });
    }
  } finally {
    observationWriter.close();
  }

  const overlap = sortedIntersection(counters.calibrationSessionIds, counters.validationSessionIds);
  let status: ExportStatus = 'exported';
  if (overlap.length > 0) {
    status = 'split_leakage_detected';
  } else if (counters.observationsEmitted === 0) {
    const decodedSourceBlockers =
      (counters.skippedCountByReason.unsupported_source_format_requires_decoded_jsonl ?? 0) +
      (counters.skippedCountByReason.dbn_decode_failed ?? 0);
    status = sources.length > 0 && decodedSourceBlockers === sources.length
      ? 'requires_decoded_observation_source'
      : 'no_matching_observations';
  }

  const outputHash = sha256File(outPath);
  const manifest = {
    ...baseManifest({
      status,
      sourceReportHash,
      diagnosisReportHash,
      corpusRoot,
      outPath,
      split,
      maxRecords: options.max_records ?? null,
      generatedAtTsNs: options.generated_at_ts_ns,
      progressLogPath,
      reason: statusReason(status),
      sourceReport,
    }),
    observation_count: counters.observationsEmitted,
    calibration_count: counters.calibrationCount,
    validation_count: counters.validationCount,
    input_files_count: counters.inputFiles.length,
    input_file_hashes: counters.inputFiles,
    output_hash: outputHash,
    skipped_count_by_reason: sortObject(counters.skippedCountByReason),
    dbn_decoder_path: dbnDecoderPath,
    dbn_decoded_files_count: counters.dbnDecodedFiles,
    source_manifest_path: manifestPath,
    source_manifest_hash: manifestPath === null ? null : sha256File(manifestPath),
    leakage_checks: {
      calibration_session_count: counters.calibrationSessionIds.size,
      validation_session_count: counters.validationSessionIds.size,
      overlapping_session_ids: overlap,
    },
  };
  writeJson(manifestOutPath, manifest);
  progress.emit('export_completed', {
    status,
    observations_emitted: counters.observationsEmitted,
    out_path: outPath,
    manifest_out_path: manifestOutPath,
  });

  return { manifest, exit_code: status === 'exported' ? 0 : 2 };
}

export function parseExportLimitQueueFrontObservationsArgs(
  args: readonly string[],
): ExportLimitQueueFrontObservationsOptions {
  const options: Mutable<ExportLimitQueueFrontObservationsOptions> = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    switch (flag) {
      case '--calibration-report':
        index += 1;
        options.calibration_report = requireArgValue(flag, args[index]);
        break;
      case '--diagnosis-report':
        index += 1;
        options.diagnosis_report = requireArgValue(flag, args[index]);
        break;
      case '--corpus-root':
        index += 1;
        options.corpus_root = requireArgValue(flag, args[index]);
        break;
      case '--out':
        index += 1;
        options.out = requireArgValue(flag, args[index]);
        break;
      case '--manifest-out':
        index += 1;
        options.manifest_out = requireArgValue(flag, args[index]);
        break;
      case '--max-records':
        index += 1;
        options.max_records = positiveInt(flag, args[index]);
        break;
      case '--split':
        index += 1;
        options.split = splitFilter(requireArgValue(flag, args[index]));
        break;
      case '--generated-at-ts-ns':
        index += 1;
        options.generated_at_ts_ns = requireArgValue(flag, args[index]);
        break;
      case '--progress-log':
        index += 1;
        options.progress_log = requireArgValue(flag, args[index]);
        break;
      case '--progress-every-records':
        index += 1;
        options.progress_every_records = positiveInt(flag, args[index]);
        break;
      case '--python':
        index += 1;
        options.python = requireArgValue(flag, args[index]);
        break;
      case '--dbn-decoder':
        index += 1;
        options.dbn_decoder = requireArgValue(flag, args[index]);
        break;
      case '--help':
        processStdout.write(usage());
        processExit(0);
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  for (const required of ['calibration_report', 'diagnosis_report', 'corpus_root'] as const) {
    if (options[required] === undefined) {
      throw new Error(`--${required.replaceAll('_', '-')} is required`);
    }
  }
  return options as ExportLimitQueueFrontObservationsOptions;
}

class ProgressWriter {
  private recordsSinceLastEmit = 0;

  constructor(
    private readonly path: string | null,
    private readonly everyRecords: number,
  ) {}

  emit(eventType: string, fields: JsonObject): void {
    if (this.path === null) {
      return;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const payload = {
      event_type: eventType,
      memory: memorySnapshot(),
      ...fields,
    };
    writeFileSync(this.path, `${JSON.stringify(payload, Object.keys(payload).sort())}\n`, {
      encoding: 'utf8',
      flag: 'a',
    });
  }

  record(fields: JsonObject): void {
    if (this.path === null) {
      return;
    }
    this.recordsSinceLastEmit += 1;
    if (this.recordsSinceLastEmit < this.everyRecords) {
      return;
    }
    this.recordsSinceLastEmit = 0;
    this.emit('records_scanned', fields);
  }
}

class ObservationWriter {
  private readonly fd: number;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, 'w');
  }

  write(observation: LimitQueueFrontObservation): void {
    writeSync(this.fd, `${JSON.stringify(observation)}\n`, null, 'utf8');
  }

  close(): void {
    closeSync(this.fd);
  }
}

class MboFileState {
  private readonly levels = new Map<string, LevelState>();
  private readonly orders = new Map<number, OpenOrder>();

  constructor(
    private readonly source: SourceFile,
    private readonly sourceReportHash: string,
  ) {}

  addOrder(record: JsonObject, fields: RequiredMboFields): void {
    const levelKey = `${fields.side}:${fields.price}`;
    const level = this.levels.get(levelKey) ?? { totalSize: 0, orderCount: 0 };
    this.levels.set(levelKey, level);
    this.orders.set(fields.orderId, {
      orderId: fields.orderId,
      side: fields.side,
      price: fields.price,
      size: fields.size,
      addTsNs: fields.ts,
      queueAheadSize: level.totalSize,
      queueAheadOrderCount: level.orderCount,
    });
    level.totalSize += fields.size;
    level.orderCount += 1;
    void record;
  }

  terminalObservation(fields: TerminalMboFields): LimitQueueFrontObservation | null {
    const order = this.orders.get(fields.orderId);
    if (order === undefined) {
      return null;
    }
    const queueBucket = queueBucketFor(order.queueAheadSize);
    const observation = queueBucket === LIMIT_QUEUE_FRONT_BUCKET_ID
      ? this.makeObservation({
          order,
          eventTsNs: fields.ts,
          fillOutcome: fields.action === 'T' ? 'filled' : 'cancelled',
          observedTimeToFillMs: fields.action === 'T'
            ? Math.max(0, (fields.ts - order.addTsNs) / 1_000_000)
            : null,
          noFillOrCancelOutcome: fields.action === 'T' ? null : 'cancelled',
          terminalAction: fields.action,
        })
      : null;
    this.removeOrder(order, fields.action === 'T' ? Math.min(order.size, Math.max(1, fields.size)) : order.size);
    return observation;
  }

  modifyOrder(fields: ModifyMboFields): void {
    const order = this.orders.get(fields.orderId);
    if (order === undefined || fields.size <= 0) {
      return;
    }
    const level = this.levels.get(`${order.side}:${order.price}`);
    if (level !== undefined) {
      level.totalSize += fields.size - order.size;
    }
    order.size = fields.size;
  }

  closeOpenOrdersAtEnd(): readonly LimitQueueFrontObservation[] {
    const observations: LimitQueueFrontObservation[] = [];
    for (const order of [...this.orders.values()].sort((left, right) => left.orderId - right.orderId)) {
      if (queueBucketFor(order.queueAheadSize) === LIMIT_QUEUE_FRONT_BUCKET_ID) {
        observations.push(this.makeObservation({
          order,
          eventTsNs: order.addTsNs,
          fillOutcome: 'no_fill',
          observedTimeToFillMs: null,
          noFillOrCancelOutcome: 'no_fill',
          terminalAction: 'session_end',
        }));
      }
      this.removeOrder(order, order.size);
    }
    return observations;
  }

  private makeObservation(input: {
    readonly order: OpenOrder;
    readonly eventTsNs: number;
    readonly fillOutcome: 'filled' | 'no_fill' | 'cancelled';
    readonly observedTimeToFillMs: number | null;
    readonly noFillOrCancelOutcome: 'no_fill' | 'cancelled' | null;
    readonly terminalAction: string;
  }): LimitQueueFrontObservation {
    const base = {
      schema_version: LIMIT_QUEUE_FRONT_OBSERVATION_SCHEMA_VERSION,
      bucket: LIMIT_QUEUE_FRONT_BUCKET,
      split: this.source.split,
      observed_time_to_fill_ms: input.observedTimeToFillMs,
      modeled_time_to_fill_ms: null,
      fill_outcome: input.fillOutcome,
      no_fill_or_cancel_outcome: input.noFillOrCancelOutcome,
      order_side: input.order.side,
      queue_bucket: LIMIT_QUEUE_FRONT_BUCKET_ID,
      queue_position_features: {
        queue_bucket: LIMIT_QUEUE_FRONT_BUCKET_ID,
        queue_ahead_size: input.order.queueAheadSize,
        queue_ahead_order_count: input.order.queueAheadOrderCount,
        order_id: input.order.orderId,
        order_size: input.order.size,
        price: input.order.price,
        add_ts_ns: String(input.order.addTsNs),
        terminal_action: input.terminalAction,
      },
      event_ts_ns: String(input.eventTsNs),
      session_id: this.source.session_id,
      instrument: this.source.instrument,
      source_report_hash: this.sourceReportHash,
      source_session_or_file: this.source.source_session_or_file,
    };
    return validateLimitQueueFrontObservation({
      ...base,
      observation_id: observationId(base),
    });
  }

  private removeOrder(order: OpenOrder, removedSize: number): void {
    const level = this.levels.get(`${order.side}:${order.price}`);
    if (level !== undefined) {
      level.totalSize = Math.max(0, level.totalSize - removedSize);
    }
    if (removedSize >= order.size) {
      if (level !== undefined) {
        level.orderCount = Math.max(0, level.orderCount - 1);
      }
      this.orders.delete(order.orderId);
    } else {
      order.size -= removedSize;
    }
  }
}

interface RequiredMboFields {
  readonly ts: number;
  readonly orderId: number;
  readonly price: number;
  readonly size: number;
  readonly side: 'bid' | 'ask';
}

interface TerminalMboFields {
  readonly ts: number;
  readonly orderId: number;
  readonly size: number;
  readonly action: 'T' | 'C';
}

interface ModifyMboFields {
  readonly orderId: number;
  readonly size: number;
}

function observationFromRecord(
  record: JsonObject,
  source: SourceFile,
  state: MboFileState,
  sourceReportHash: string,
): LimitQueueFrontObservation | null {
  if (record.bucket === LIMIT_QUEUE_FRONT_BUCKET) {
    return validateLimitQueueFrontObservation(record, {
      expectedSourceReportHash: sourceReportHash,
      sourceLabel: source.path,
    });
  }

  const ts = intField(record, 'ts_event');
  const orderId = intField(record, 'order_id');
  const action = stringField(record, 'action');
  if (ts === null || orderId === null || action === null) {
    return null;
  }
  if (action === 'A') {
    const side = bookSide(record);
    const price = fixedPriceInt(record.price);
    const size = intField(record, 'size') ?? 0;
    if (side !== null && price !== null && size > 0) {
      state.addOrder(record, { ts, orderId, price, size, side });
    }
    return null;
  }
  if (action === 'T' || action === 'C') {
    return state.terminalObservation({
      ts,
      orderId,
      size: intField(record, 'size') ?? 0,
      action,
    });
  }
  if (action === 'M') {
    state.modifyOrder({ orderId, size: intField(record, 'size') ?? 0 });
  }
  void source;
  return null;
}

function processDecodedSource(input: {
  readonly decodedPath: string;
  readonly source: SourceFile;
  readonly sourceReportHash: string;
  readonly observationWriter: ObservationWriter;
  readonly counters: ExportCounters;
  readonly progress: ProgressWriter;
  readonly maxRecords: number | undefined;
}): void {
  const fileState = new MboFileState(input.source, input.sourceReportHash);
  forEachRecord(input.decodedPath, (record) => {
    input.counters.recordsScanned += 1;
    input.progress.record({
      records_scanned: input.counters.recordsScanned,
      observations_emitted: input.counters.observationsEmitted,
      current_file: input.source.path,
      current_session: input.source.session_id,
    });
    if (input.maxRecords !== undefined && input.counters.observationsEmitted >= input.maxRecords) {
      return;
    }
    const observation = observationFromRecord(
      record,
      input.source,
      fileState,
      input.sourceReportHash,
    );
    if (observation === null) {
      return;
    }
    emitObservation({
      observation,
      observationWriter: input.observationWriter,
      counters: input.counters,
    });
  });
  for (const observation of fileState.closeOpenOrdersAtEnd()) {
    if (input.maxRecords !== undefined && input.counters.observationsEmitted >= input.maxRecords) {
      break;
    }
    emitObservation({
      observation,
      observationWriter: input.observationWriter,
      counters: input.counters,
    });
  }
}

function decodeDbnSource(input: {
  readonly source: SourceFile;
  readonly cwd: string;
  readonly python: string;
  readonly dbnDecoderPath: string;
  readonly progress: ProgressWriter;
  readonly counters: ExportCounters;
}): string | null {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'qfa-sim03j-dbn-'));
  const outPath = join(tempDirectory, 'mbo.jsonl');
  input.progress.emit('dbn_decode_started', {
    path: input.source.path,
    session_id: input.source.session_id,
    split: input.source.split,
    dbn_decoder_path: input.dbnDecoderPath,
  });
  const result = spawnSync(
    input.python,
    [
      input.dbnDecoderPath,
      '--input',
      input.source.path,
      '--out',
      outPath,
      '--schema',
      'mbo',
    ],
    {
      cwd: input.cwd,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    rmSync(tempDirectory, { recursive: true, force: true });
    increment(input.counters.skippedCountByReason, 'dbn_decode_failed');
    input.progress.emit('dbn_decode_failed', {
      path: input.source.path,
      session_id: input.source.session_id,
      split: input.source.split,
      exit_code: result.status,
      stderr: shortText(result.stderr),
      stdout: shortText(result.stdout),
    });
    return null;
  }
  input.counters.dbnDecodedFiles += 1;
  input.progress.emit('dbn_decode_completed', {
    path: input.source.path,
    session_id: input.source.session_id,
    split: input.source.split,
    decoded_path: outPath,
  });
  return outPath;
}

function emitObservation(input: {
  readonly observation: LimitQueueFrontObservation;
  readonly observationWriter: ObservationWriter;
  readonly counters: ExportCounters;
}): void {
  input.observationWriter.write(input.observation);
  input.counters.observationsEmitted += 1;
  if (input.observation.split === 'calibration') {
    input.counters.calibrationCount += 1;
    input.counters.calibrationSessionIds.add(input.observation.session_id);
  } else {
    input.counters.validationCount += 1;
    input.counters.validationSessionIds.add(input.observation.session_id);
  }
}

function sourceFilesFromManifest(
  manifest: JsonObject,
  corpusRoot: string,
  split: SplitFilter,
): readonly SourceFile[] {
  const sessions = arrayOfObjects(manifest.sessions, 'manifest.sessions');
  const sources: SourceFile[] = [];
  for (const session of sessions) {
    const sessionSplit = session.split;
    if ((sessionSplit !== 'calibration' && sessionSplit !== 'validation') || !splitAllowed(sessionSplit, split)) {
      continue;
    }
    const schemas = isJsonObject(session.schemas) ? session.schemas : {};
    const mbo = isJsonObject(schemas.mbo) ? schemas.mbo : null;
    const pathValue = typeof mbo?.path === 'string' ? mbo.path : null;
    if (pathValue === null) {
      continue;
    }
    const path = resolveMaybe(corpusRoot, pathValue);
    if (!existsSync(path)) {
      continue;
    }
    sources.push({
      session_id: stringValue(session.session_id) ?? 'unknown-session',
      split: sessionSplit,
      instrument: stringValue(session.symbol) ?? stringValue(manifest.symbol) ?? 'unknown',
      path,
      source_session_or_file: `${stringValue(session.session_id) ?? 'unknown-session'}:${path}`,
    });
  }
  return sources.sort((left, right) => `${left.split}:${left.session_id}:${left.path}`.localeCompare(`${right.split}:${right.session_id}:${right.path}`));
}

function discoverSourceFiles(corpusRoot: string, split: SplitFilter): readonly SourceFile[] {
  const paths = recursiveFiles(corpusRoot).filter((path) => sourceFileKind(path) !== 'unsupported');
  return paths.map((path) => ({
    session_id: sessionIdFromPath(path),
    split: split === 'validation' ? 'validation' : 'calibration',
    instrument: 'unknown',
    path,
    source_session_or_file: path,
  }));
}

function forEachRecord(path: string, callback: (record: JsonObject) => void): void {
  if (lowerExtension(path) === '.jsonl') {
    forEachJsonlRecord(path, callback);
    return;
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const records = Array.isArray(raw) ? raw : isJsonObject(raw) && Array.isArray(raw.records) ? raw.records : [];
  for (const value of records) {
    if (isJsonObject(value)) {
      callback(value);
    }
  }
}

function forEachJsonlRecord(path: string, callback: (record: JsonObject) => void): void {
  const fd = openSync(path, 'r');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let remainder = '';
  try {
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        break;
      }
      const text = remainder + chunk.subarray(0, bytesRead).toString('utf8');
      const lines = text.split(/\r?\n/u);
      remainder = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') {
          continue;
        }
        const value = JSON.parse(line) as unknown;
        if (isJsonObject(value)) {
          callback(value);
        }
      }
    }
    if (remainder.trim() !== '') {
      const value = JSON.parse(remainder) as unknown;
      if (isJsonObject(value)) {
        callback(value);
      }
    }
  } finally {
    closeSync(fd);
  }
}

function validateDiagnosis(diagnosis: JsonObject): void {
  if (diagnosis.ticket_id !== 'SIM-03F') {
    throw new Error('diagnosis report ticket_id is not SIM-03F');
  }
  const target = objectAt(diagnosis, ['target_bucket']);
  if (target.group !== 'limit_queue' || target.bucket_id !== LIMIT_QUEUE_FRONT_BUCKET_ID) {
    throw new Error('diagnosis report does not target limit_queue:front');
  }
  const failed = arrayOfObjects(target.exact_failed_criteria, 'target_bucket.exact_failed_criteria');
  if (!failed.some((criterion) => criterion.name === LIMIT_QUEUE_FRONT_TARGET_METRIC)) {
    throw new Error(`diagnosis report does not identify ${LIMIT_QUEUE_FRONT_TARGET_METRIC}`);
  }
}

function baseManifest(input: {
  readonly status: ExportStatus;
  readonly sourceReportHash: string;
  readonly diagnosisReportHash: string;
  readonly corpusRoot: string;
  readonly outPath: string;
  readonly split: SplitFilter;
  readonly maxRecords: number | null;
  readonly generatedAtTsNs?: string;
  readonly progressLogPath: string | null;
  readonly reason: string;
  readonly sourceReport: JsonObject;
}): JsonObject {
  return {
    sim03i_observation_export_manifest_schema_version: SIM_03I_OBSERVATION_EXPORT_MANIFEST_SCHEMA_VERSION,
    ticket_id: SIM_03I_TICKET_ID,
    status: input.status,
    reason: input.reason,
    observation_count: 0,
    calibration_count: 0,
    validation_count: 0,
    source_report_hash: input.sourceReportHash,
    diagnosis_report_hash: input.diagnosisReportHash,
    corpus_root: input.corpusRoot,
    out_path: input.outPath,
    split: input.split,
    max_records: input.maxRecords,
    input_files_count: 0,
    input_file_hashes: [],
    output_hash: null,
    skipped_count_by_reason: {},
    progress_log_path: input.progressLogPath,
    ...(input.generatedAtTsNs === undefined ? {} : { generated_at_ts_ns: input.generatedAtTsNs }),
    sim03_status: input.sourceReport.status ?? 'unknown',
    rel01_status: input.sourceReport.ready_for_rel01_execution_simulation === true ? 'unblocked' : 'blocked',
    observation_schema: observationSchemaExample(),
    scope_note: 'SIM-03I exports only limit_queue:front observations for SIM-03H; it does not change thresholds, reports, passing buckets, or REL gates.',
  };
}

function statusReason(status: ExportStatus): string {
  switch (status) {
    case 'exported':
      return 'Targeted limit_queue:front observations exported.';
    case 'requires_corpus_source':
      return 'Corpus root is missing.';
    case 'requires_decoded_observation_source':
      return 'Only unsupported source formats were found; provide decoded JSONL or add a DBN export reader.';
    case 'no_matching_observations':
      return 'No limit_queue:front observations were found in supported source files.';
    case 'split_leakage_detected':
      return 'At least one session_id appeared in both calibration and validation observations.';
  }
}

function resolveManifestPath(cwd: string, calibrationReportPath: string, sourceReport: JsonObject): string | null {
  const inputs = isJsonObject(sourceReport.inputs) ? sourceReport.inputs : {};
  const manifestPath = typeof inputs.manifest_path === 'string' ? inputs.manifest_path : null;
  if (manifestPath === null) {
    return null;
  }
  const candidates = [
    resolveMaybe(cwd, manifestPath),
    resolve(dirname(calibrationReportPath), manifestPath),
    resolve(dirname(dirname(calibrationReportPath)), manifestPath),
    resolve(dirname(dirname(dirname(calibrationReportPath))), manifestPath),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function resolveMaybe(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

function recursiveFiles(root: string): readonly string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...recursiveFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort();
}

function sessionIdFromPath(path: string): string {
  return dirname(path).split(/[\\/]/u).at(-1) ?? 'unknown-session';
}

function splitAllowed(split: 'calibration' | 'validation', filter: SplitFilter): boolean {
  return filter === 'both' || filter === split;
}

function sourceFileKind(path: string): 'decoded' | 'dbn' | 'unsupported' {
  const lower = path.toLowerCase();
  if (lower.endsWith('.jsonl') || lower.endsWith('.json')) {
    return 'decoded';
  }
  if (lower.endsWith('.dbn') || lower.endsWith('.dbn.zst')) {
    return 'dbn';
  }
  return 'unsupported';
}

function queueBucketFor(queueAheadSize: number): 'front' | 'near' | 'middle' | 'back' {
  if (queueAheadSize <= 0) {
    return 'front';
  }
  if (queueAheadSize <= 5) {
    return 'near';
  }
  if (queueAheadSize <= 20) {
    return 'middle';
  }
  return 'back';
}

function bookSide(record: JsonObject): 'bid' | 'ask' | null {
  const side = stringField(record, 'side');
  if (side === 'A') {
    return 'ask';
  }
  if (side === 'B') {
    return 'bid';
  }
  return null;
}

function intField(record: JsonObject, name: string): number | null {
  const value = record[name];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) {
    return Number.parseInt(value, 10);
  }
  return null;
}

function stringField(record: JsonObject, name: string): string | null {
  const value = record[name];
  return typeof value === 'string' ? value : null;
}

function fixedPriceInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) {
    return Number.parseInt(value, 10);
  }
  return null;
}

function observationId(base: JsonObject): string {
  return sha256Text([
    base.source_report_hash,
    base.session_id,
    base.split,
    base.order_side,
    base.event_ts_ns,
    isJsonObject(base.queue_position_features) ? base.queue_position_features.add_ts_ns : '',
    isJsonObject(base.queue_position_features) ? base.queue_position_features.order_id : '',
    isJsonObject(base.queue_position_features) ? base.queue_position_features.price : '',
    base.fill_outcome,
  ].join('|'));
}

function hashFileIfFeasible(path: string, byteCount: number): {
  readonly sha256?: string;
  readonly hash_status: 'hashed' | 'skipped_large_file';
} {
  if (byteCount > MAX_HASH_FILE_BYTES) {
    return { hash_status: 'skipped_large_file' };
  }
  return { sha256: sha256File(path), hash_status: 'hashed' };
}

function shortText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim().slice(0, 500);
}

function lowerExtension(path: string): string {
  return extname(path).toLowerCase();
}

function memorySnapshot(): JsonObject {
  const memory = process.memoryUsage();
  return {
    rss_bytes: memory.rss,
    heap_used_bytes: memory.heapUsed,
    heap_total_bytes: memory.heapTotal,
  };
}

function sortedIntersection(left: Set<string>, right: Set<string>): readonly string[] {
  return [...left].filter((value) => right.has(value)).sort();
}

function sortObject(input: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)));
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function objectAt(root: JsonObject, path: readonly string[]): JsonObject {
  let current: unknown = root;
  for (const segment of path) {
    if (!isJsonObject(current)) {
      throw new Error(`expected object at ${path.join('.')}`);
    }
    current = current[segment];
  }
  if (!isJsonObject(current)) {
    throw new Error(`expected object at ${path.join('.')}`);
  }
  return current;
}

function arrayOfObjects(value: unknown, label: string): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected array at ${label}`);
  }
  return value.map((item, index) => {
    if (!isJsonObject(item)) {
      throw new Error(`expected object at ${label}[${index}]`);
    }
    return item;
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseJsonObject(text: string, path: string): JsonObject {
  const value = JSON.parse(text) as unknown;
  if (!isJsonObject(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value;
}

function writeJson(path: string, payload: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function requireArgValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function positiveInt(flag: string, value: string | undefined): number {
  const parsed = Number.parseInt(requireArgValue(flag, value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function splitFilter(value: string): SplitFilter {
  if (value === 'calibration' || value === 'validation' || value === 'both') {
    return value;
  }
  throw new Error('--split must be calibration, validation, or both');
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256File(path: string): string {
  const digest = createHash('sha256');
  const fd = openSync(path, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        break;
      }
      digest.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return digest.digest('hex');
}

function usage(): string {
  return [
    'Usage: npm run sim:03i:export-front-observations -- --calibration-report path --diagnosis-report path --corpus-root path [--out path] [--manifest-out path]',
    '',
    'Exports targeted limit_queue:front observations for SIM-03H without changing SIM-03 or REL gates.',
    'DBN/ZST MBO files are decoded through scripts/sim/decode-databento-mbo-jsonl.py by default.',
    '',
  ].join('\n');
}

type Mutable<T> = {
  -readonly [Key in keyof T]?: T[Key];
};

function main(): void {
  try {
    const options = parseExportLimitQueueFrontObservationsArgs(processArgv.slice(2));
    const result = exportLimitQueueFrontObservations(options);
    const cwd = resolve(options.cwd ?? process.cwd());
    processStdout.write(`SIM-03I status: ${result.manifest.status}\n`);
    processStdout.write(`observations=${result.manifest.observation_count}\n`);
    processStdout.write(`manifest=${resolve(cwd, options.manifest_out ?? DEFAULT_MANIFEST_OUT_PATH)}\n`);
    processExit(result.exit_code);
  } catch (error) {
    processStderr.write(`SIM-03I export failed: ${errorMessage(error)}\n`);
    processExit(1);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (processArgv[1] !== undefined && resolve(processArgv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
