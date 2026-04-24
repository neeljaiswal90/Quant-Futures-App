import { watch, type FSWatcher } from 'node:fs';
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  categorizeRuntimeEventType,
  formatJournalEventSchemaValidationErrors,
  isRuntimeEventType,
  journalEventFromJsonLine,
  validateJournalEventEnvelope,
  type JournalEventEnvelope,
  type RuntimeEventType,
} from '../contracts/events/index.js';
import { ns, stableJsonStringify, type JsonValue, type UnixNs } from '../contracts/index.js';
import type { PublicRuntimeConfig } from '../config/types.js';

export const JOURNAL_TRANSPORT_CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const JOURNAL_TRANSPORT_QUARANTINE_SCHEMA_VERSION = 1 as const;

export interface JournalTransportConfig {
  readonly journal_dir: string;
  readonly checkpoint_path: string;
  readonly quarantine_dir: string;
  readonly journal_extension?: string;
  readonly causation_buffer_capacity?: number;
}

export interface RecentCausationEntry {
  readonly event_id: string;
  readonly ts_ns: UnixNs;
  readonly type: RuntimeEventType;
  readonly causation_id?: string;
}

export interface JournalTransportCheckpointFileState {
  readonly offset_bytes: number;
  readonly line_number: number;
  readonly last_event_id?: string;
}

export interface JournalTransportCheckpoint {
  readonly schema_version: typeof JOURNAL_TRANSPORT_CHECKPOINT_SCHEMA_VERSION;
  readonly files: Readonly<Record<string, JournalTransportCheckpointFileState>>;
  readonly causation_buffer: readonly RecentCausationEntry[];
}

export interface IngestedJournalEvent {
  readonly event: JournalEventEnvelope;
  readonly source_file: string;
  readonly byte_offset_start: number;
  readonly byte_offset_end: number;
  readonly line_number: number;
}

export interface QuarantinedJournalLine {
  readonly schema_version: typeof JOURNAL_TRANSPORT_QUARANTINE_SCHEMA_VERSION;
  readonly source_file: string;
  readonly byte_offset_start: number;
  readonly byte_offset_end: number;
  readonly line_number: number;
  readonly error_message: string;
  readonly error: string;
  readonly event_id?: string;
  readonly causation_id?: string;
  readonly event_type?: string;
  readonly raw_line: string;
}

export interface JournalTransportSink {
  readonly onEvent: (event: IngestedJournalEvent) => void | Promise<void>;
  readonly onMalformedLine?: (line: QuarantinedJournalLine) => void | Promise<void>;
}

export interface JournalTransportPollResult {
  readonly events_ingested: number;
  readonly malformed_lines: number;
  readonly files_scanned: readonly string[];
  readonly checkpoint: JournalTransportCheckpoint;
}

export interface JournalTransportWatchHandle {
  readonly stop: () => Promise<void>;
}

interface MutableCheckpointFileState {
  offset_bytes: number;
  line_number: number;
  last_event_id?: string;
}

interface MutableCheckpoint {
  schema_version: typeof JOURNAL_TRANSPORT_CHECKPOINT_SCHEMA_VERSION;
  files: Record<string, MutableCheckpointFileState>;
  causation_buffer: RecentCausationEntry[];
}

const DEFAULT_JOURNAL_EXTENSION = '.jsonl';
const DEFAULT_CAUSATION_BUFFER_CAPACITY = 4_096;
const TEMP_FILE_SUFFIXES = ['.tmp', '.partial', '.writing'];

export function createJournalTransportConfigFromAppConfig(
  publicConfig: PublicRuntimeConfig,
): JournalTransportConfig {
  return createJournalTransportConfig(publicConfig.paths.journal_dir);
}

export function createJournalTransportConfig(journalDir: string): JournalTransportConfig {
  const resolvedJournalDir = resolve(journalDir);
  return {
    journal_dir: resolvedJournalDir,
    checkpoint_path: join(resolvedJournalDir, '.checkpoints', 'runtime-ingest-checkpoint.json'),
    quarantine_dir: join(resolvedJournalDir, 'quarantine'),
    journal_extension: DEFAULT_JOURNAL_EXTENSION,
    causation_buffer_capacity: DEFAULT_CAUSATION_BUFFER_CAPACITY,
  };
}

export class JsonlJournalTransportIngestor {
  private readonly config: Required<JournalTransportConfig>;
  private readonly sink: JournalTransportSink;
  private pollInFlight: Promise<JournalTransportPollResult> | undefined;
  private watcher: FSWatcher | undefined;
  private watcherError: unknown;

  constructor(config: JournalTransportConfig, sink: JournalTransportSink) {
    this.config = {
      ...config,
      journal_dir: resolve(config.journal_dir),
      checkpoint_path: resolve(config.checkpoint_path),
      quarantine_dir: resolve(config.quarantine_dir),
      journal_extension: config.journal_extension ?? DEFAULT_JOURNAL_EXTENSION,
      causation_buffer_capacity:
        config.causation_buffer_capacity ?? DEFAULT_CAUSATION_BUFFER_CAPACITY,
    };
    if (
      !Number.isSafeInteger(this.config.causation_buffer_capacity) ||
      this.config.causation_buffer_capacity < 1
    ) {
      throw new Error('journal transport causation_buffer_capacity must be a positive safe integer');
    }
    this.sink = sink;
  }

  getLastWatcherError(): unknown {
    return this.watcherError;
  }

  async start(): Promise<JournalTransportWatchHandle> {
    await this.ensureDirectories();
    this.watcher = watch(this.config.journal_dir, { persistent: false }, () => {
      void this.pollOnce().catch((error: unknown) => {
        this.watcherError = error;
      });
    });
    void this.pollOnce().catch((error: unknown) => {
      this.watcherError = error;
    });

    return {
      stop: async () => {
        this.watcher?.close();
        this.watcher = undefined;
        if (this.pollInFlight !== undefined) {
          await this.pollInFlight;
        }
      },
    };
  }

  async pollOnce(): Promise<JournalTransportPollResult> {
    if (this.pollInFlight !== undefined) {
      return this.pollInFlight;
    }

    this.pollInFlight = this.pollOnceInternal().finally(() => {
      this.pollInFlight = undefined;
    });
    return this.pollInFlight;
  }

  private async pollOnceInternal(): Promise<JournalTransportPollResult> {
    await this.ensureDirectories();
    const checkpoint = await this.readCheckpoint();
    const journalFiles = await this.listJournalFiles();
    let eventsIngested = 0;
    let malformedLines = 0;

    for (const fileName of journalFiles) {
      const fileResult = await this.ingestFile(fileName, checkpoint);
      eventsIngested += fileResult.events_ingested;
      malformedLines += fileResult.malformed_lines;
    }

    await this.writeCheckpoint(checkpoint);

    return {
      events_ingested: eventsIngested,
      malformed_lines: malformedLines,
      files_scanned: journalFiles,
      checkpoint: freezeCheckpoint(checkpoint),
    };
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      mkdir(this.config.journal_dir, { recursive: true }),
      mkdir(dirname(this.config.checkpoint_path), { recursive: true }),
      mkdir(this.config.quarantine_dir, { recursive: true }),
    ]);
  }

  private async listJournalFiles(): Promise<readonly string[]> {
    const entries = await readdir(this.config.journal_dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.endsWith(this.config.journal_extension))
      .filter((name) => !TEMP_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix)))
      .sort();
  }

  private async ingestFile(
    fileName: string,
    checkpoint: MutableCheckpoint,
  ): Promise<Pick<JournalTransportPollResult, 'events_ingested' | 'malformed_lines'>> {
    const filePath = join(this.config.journal_dir, fileName);
    const fileStat = await stat(filePath);
    const previousState = checkpoint.files[fileName] ?? { offset_bytes: 0, line_number: 0 };
    const state: MutableCheckpointFileState =
      previousState.offset_bytes > fileStat.size
        ? { offset_bytes: 0, line_number: 0 }
        : { ...previousState };

    if (state.offset_bytes === fileStat.size) {
      checkpoint.files[fileName] = state;
      return { events_ingested: 0, malformed_lines: 0 };
    }

    const fileBuffer = await readFile(filePath);
    const appended = fileBuffer.subarray(state.offset_bytes);
    let cursor = state.offset_bytes;
    let lineStart = 0;
    let eventsIngested = 0;
    let malformedLines = 0;

    for (let index = 0; index < appended.length; index += 1) {
      if (appended[index] !== 0x0a) {
        continue;
      }

      const absoluteLineStart = state.offset_bytes + lineStart;
      const absoluteLineEnd = state.offset_bytes + index + 1;
      const rawLineBuffer = stripTrailingCarriageReturn(appended.subarray(lineStart, index));
      const rawLine = rawLineBuffer.toString('utf8');
      state.line_number += 1;

      if (rawLine.trim() !== '') {
        try {
          const event = parseTransportJournalEvent(rawLine, {
            causationBuffer: checkpoint.causation_buffer,
          });
          await this.sink.onEvent({
            event,
            source_file: fileName,
            byte_offset_start: absoluteLineStart,
            byte_offset_end: absoluteLineEnd,
            line_number: state.line_number,
          });
          state.last_event_id = event.event_id;
          recordCausationEntry(
            checkpoint.causation_buffer,
            event,
            this.config.causation_buffer_capacity,
          );
          eventsIngested += 1;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const metadata = extractQuarantineMetadata(rawLine);
          const quarantinedLine: QuarantinedJournalLine = {
            schema_version: JOURNAL_TRANSPORT_QUARANTINE_SCHEMA_VERSION,
            source_file: fileName,
            byte_offset_start: absoluteLineStart,
            byte_offset_end: absoluteLineEnd,
            line_number: state.line_number,
            error_message: errorMessage,
            error: errorMessage,
            ...metadata,
            raw_line: rawLine,
          };
          await this.quarantineMalformedLine(quarantinedLine);
          malformedLines += 1;
        }
      }

      cursor = absoluteLineEnd;
      lineStart = index + 1;
    }

    state.offset_bytes = cursor;
    checkpoint.files[fileName] = state;

    return { events_ingested: eventsIngested, malformed_lines: malformedLines };
  }

  private async quarantineMalformedLine(line: QuarantinedJournalLine): Promise<void> {
    await appendFile(
      join(this.config.quarantine_dir, 'malformed-lines.jsonl'),
      `${stableJsonStringify(line as unknown as JsonValue)}\n`,
      'utf8',
    );
    await this.sink.onMalformedLine?.(line);
  }

  private async readCheckpoint(): Promise<MutableCheckpoint> {
    try {
      const raw = await readFile(this.config.checkpoint_path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return normalizeCheckpoint(parsed);
    } catch (error) {
      if (isNodeErrorWithCode(error, 'ENOENT')) {
        return {
          schema_version: JOURNAL_TRANSPORT_CHECKPOINT_SCHEMA_VERSION,
          files: {},
          causation_buffer: [],
        };
      }
      throw error;
    }
  }

  private async writeCheckpoint(checkpoint: MutableCheckpoint): Promise<void> {
    const tmpPath = `${this.config.checkpoint_path}.tmp`;
    await writeFile(tmpPath, `${stableJsonStringify(freezeCheckpoint(checkpoint) as unknown as JsonValue)}\n`, 'utf8');
    await rename(tmpPath, this.config.checkpoint_path);
  }
}

export interface TransportJournalEventValidationContext {
  readonly causationBuffer?: readonly RecentCausationEntry[];
}

export function parseTransportJournalEvent(
  line: string,
  context: TransportJournalEventValidationContext = {},
): JournalEventEnvelope {
  const event = journalEventFromJsonLine(line);
  assertTransportJournalEvent(event, context);
  return event;
}

export function assertTransportJournalEvent(
  event: JournalEventEnvelope,
  context: TransportJournalEventValidationContext = {},
): void {
  const schemaValidation = validateJournalEventEnvelope(event);
  if (!schemaValidation.ok) {
    throw new Error(formatJournalEventSchemaValidationErrors(schemaValidation.issues));
  }

  const category = categorizeRuntimeEventType(event.type);
  if (category === 'source_market_data') {
    assertCanonicalMarketDataTimestamp(event, true);
    return;
  }

  if (category === 'derived') {
    assertDerivedEventCausationTimestamp(event, context.causationBuffer ?? []);
    return;
  }

  if (event.payload !== null && typeof event.payload === 'object' && !Array.isArray(event.payload)) {
    assertCanonicalMarketDataTimestamp(event, false);
  }
}

function assertCanonicalMarketDataTimestamp(
  event: JournalEventEnvelope,
  requireExchangeTimestamp: boolean,
): void {
  if (event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    if (requireExchangeTimestamp) {
      throw new Error('source market-data event payload must be an object with exchange_event_ts_ns');
    }
    return;
  }

  const payload = event.payload as unknown as Record<string, unknown>;
  const exchangeEventTsNs = payload.exchange_event_ts_ns;
  if (exchangeEventTsNs === undefined) {
    if (requireExchangeTimestamp) {
      throw new Error('source market-data event payload.exchange_event_ts_ns is required');
    }
    return;
  }
  if (typeof exchangeEventTsNs !== 'bigint') {
    throw new Error('payload.exchange_event_ts_ns must revive to bigint when present');
  }
  if (BigInt(event.ts_ns) !== exchangeEventTsNs) {
    throw new Error('market-data event ts_ns must equal payload.exchange_event_ts_ns');
  }
}

function assertDerivedEventCausationTimestamp(
  event: JournalEventEnvelope,
  causationBuffer: readonly RecentCausationEntry[],
): void {
  if (event.causation_id === undefined) {
    throw new Error(`derived event ${event.type} requires causation_id`);
  }

  const cause = causationBuffer.find((entry) => entry.event_id === event.causation_id);
  if (cause === undefined) {
    throw new Error(`derived event ${event.type} causation_id ${event.causation_id} is not in recent causation buffer`);
  }

  if (BigInt(event.ts_ns) !== BigInt(cause.ts_ns)) {
    throw new Error(
      `derived event ${event.type} ts_ns must equal causation event ${cause.event_id} ts_ns`,
    );
  }
}

function recordCausationEntry(
  buffer: RecentCausationEntry[],
  event: JournalEventEnvelope,
  capacity: number,
): void {
  const existingIndex = buffer.findIndex((entry) => entry.event_id === event.event_id);
  if (existingIndex >= 0) {
    buffer.splice(existingIndex, 1);
  }

  buffer.push({
    event_id: event.event_id,
    ts_ns: event.ts_ns,
    type: event.type,
    ...(event.causation_id === undefined ? {} : { causation_id: event.causation_id }),
  });

  while (buffer.length > capacity) {
    buffer.shift();
  }
}

function extractQuarantineMetadata(
  rawLine: string,
): Pick<QuarantinedJournalLine, 'event_id' | 'causation_id' | 'event_type'> {
  try {
    const parsed = JSON.parse(rawLine) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.event_id === 'string' && record.event_id.trim() !== ''
        ? { event_id: record.event_id }
        : {}),
      ...(typeof record.causation_id === 'string' && record.causation_id.trim() !== ''
        ? { causation_id: record.causation_id }
        : {}),
      ...(typeof record.type === 'string' && record.type.trim() !== ''
        ? { event_type: record.type }
        : {}),
    };
  } catch {
    return {};
  }
}

function stripTrailingCarriageReturn(buffer: Buffer): Buffer {
  if (buffer.length > 0 && buffer[buffer.length - 1] === 0x0d) {
    return buffer.subarray(0, buffer.length - 1);
  }
  return buffer;
}

function normalizeCheckpoint(value: unknown): MutableCheckpoint {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('journal transport checkpoint must be a JSON object');
  }

  const record = value as Record<string, unknown>;
  if (record.schema_version !== JOURNAL_TRANSPORT_CHECKPOINT_SCHEMA_VERSION) {
    throw new Error(
      `journal transport checkpoint schema_version must be ${JOURNAL_TRANSPORT_CHECKPOINT_SCHEMA_VERSION}`,
    );
  }
  if (record.files === null || typeof record.files !== 'object' || Array.isArray(record.files)) {
    throw new Error('journal transport checkpoint files must be an object');
  }

  const files: Record<string, MutableCheckpointFileState> = {};
  for (const [fileName, fileState] of Object.entries(record.files as Record<string, unknown>)) {
    if (fileState === null || typeof fileState !== 'object' || Array.isArray(fileState)) {
      throw new Error(`journal transport checkpoint for ${fileName} must be an object`);
    }
    const state = fileState as Record<string, unknown>;
    if (!isSafeNonNegativeInteger(state.offset_bytes)) {
      throw new Error(`journal transport checkpoint ${fileName}.offset_bytes must be a safe non-negative integer`);
    }
    if (!isSafeNonNegativeInteger(state.line_number)) {
      throw new Error(`journal transport checkpoint ${fileName}.line_number must be a safe non-negative integer`);
    }
    const lastEventId = state.last_event_id;
    if (lastEventId !== undefined && (typeof lastEventId !== 'string' || lastEventId.trim() === '')) {
      throw new Error(`journal transport checkpoint ${fileName}.last_event_id must be non-empty when provided`);
    }
    files[fileName] = {
      offset_bytes: state.offset_bytes,
      line_number: state.line_number,
      ...(lastEventId === undefined ? {} : { last_event_id: lastEventId }),
    };
  }

  const causationBuffer = normalizeCausationBuffer(record.causation_buffer);

  return {
    schema_version: JOURNAL_TRANSPORT_CHECKPOINT_SCHEMA_VERSION,
    files,
    causation_buffer: causationBuffer,
  };
}

function freezeCheckpoint(checkpoint: MutableCheckpoint): JournalTransportCheckpoint {
  const files: Record<string, JournalTransportCheckpointFileState> = {};
  for (const fileName of Object.keys(checkpoint.files).sort()) {
    const state = checkpoint.files[fileName]!;
    files[fileName] = {
      offset_bytes: state.offset_bytes,
      line_number: state.line_number,
      ...(state.last_event_id === undefined ? {} : { last_event_id: state.last_event_id }),
    };
  }
  return {
    schema_version: JOURNAL_TRANSPORT_CHECKPOINT_SCHEMA_VERSION,
    files,
    causation_buffer: checkpoint.causation_buffer.map((entry) => ({
      event_id: entry.event_id,
      ts_ns: entry.ts_ns,
      type: entry.type,
      ...(entry.causation_id === undefined ? {} : { causation_id: entry.causation_id }),
    })),
  };
}

function normalizeCausationBuffer(value: unknown): RecentCausationEntry[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('journal transport checkpoint causation_buffer must be an array');
  }

  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`journal transport checkpoint causation_buffer[${index}] must be an object`);
    }

    const record = entry as Record<string, unknown>;
    if (typeof record.event_id !== 'string' || record.event_id.trim() === '') {
      throw new Error(`journal transport checkpoint causation_buffer[${index}].event_id must be non-empty`);
    }
    if (typeof record.type !== 'string' || !isRuntimeEventType(record.type)) {
      throw new Error(`journal transport checkpoint causation_buffer[${index}].type is unsupported`);
    }
    if (
      record.causation_id !== undefined &&
      (typeof record.causation_id !== 'string' || record.causation_id.trim() === '')
    ) {
      throw new Error(
        `journal transport checkpoint causation_buffer[${index}].causation_id must be non-empty when provided`,
      );
    }

    return {
      event_id: record.event_id,
      ts_ns: ns(record.ts_ns as Parameters<typeof ns>[0]),
      type: record.type,
      ...(record.causation_id === undefined ? {} : { causation_id: record.causation_id }),
    };
  });
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
