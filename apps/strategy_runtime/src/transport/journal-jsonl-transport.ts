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
  isRuntimeEventType,
  JOURNAL_EVENT_SCHEMA_VERSION,
  journalEventFromJsonLine,
  type JournalEventEnvelope,
} from '../contracts/events/index.js';
import { stableJsonStringify, type JsonValue } from '../contracts/index.js';
import type { PublicRuntimeConfig } from '../config/types.js';

export const JOURNAL_TRANSPORT_CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const JOURNAL_TRANSPORT_QUARANTINE_SCHEMA_VERSION = 1 as const;

export interface JournalTransportConfig {
  readonly journal_dir: string;
  readonly checkpoint_path: string;
  readonly quarantine_dir: string;
  readonly journal_extension?: string;
}

export interface JournalTransportCheckpointFileState {
  readonly offset_bytes: number;
  readonly line_number: number;
  readonly last_event_id?: string;
}

export interface JournalTransportCheckpoint {
  readonly schema_version: typeof JOURNAL_TRANSPORT_CHECKPOINT_SCHEMA_VERSION;
  readonly files: Readonly<Record<string, JournalTransportCheckpointFileState>>;
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
}

const DEFAULT_JOURNAL_EXTENSION = '.jsonl';
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
    };
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
          const event = parseTransportJournalEvent(rawLine);
          await this.sink.onEvent({
            event,
            source_file: fileName,
            byte_offset_start: absoluteLineStart,
            byte_offset_end: absoluteLineEnd,
            line_number: state.line_number,
          });
          state.last_event_id = event.event_id;
          eventsIngested += 1;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const quarantinedLine: QuarantinedJournalLine = {
            schema_version: JOURNAL_TRANSPORT_QUARANTINE_SCHEMA_VERSION,
            source_file: fileName,
            byte_offset_start: absoluteLineStart,
            byte_offset_end: absoluteLineEnd,
            line_number: state.line_number,
            error_message: errorMessage,
            error: errorMessage,
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
        return { schema_version: JOURNAL_TRANSPORT_CHECKPOINT_SCHEMA_VERSION, files: {} };
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

export function parseTransportJournalEvent(line: string): JournalEventEnvelope {
  const event = journalEventFromJsonLine(line);
  assertTransportJournalEvent(event);
  return event;
}

export function assertTransportJournalEvent(event: JournalEventEnvelope): void {
  if (event.schema_version !== JOURNAL_EVENT_SCHEMA_VERSION) {
    throw new Error(`journal event schema_version must be ${JOURNAL_EVENT_SCHEMA_VERSION}`);
  }
  if (typeof event.event_id !== 'string' || event.event_id.trim() === '') {
    throw new Error('journal event event_id must be a non-empty string');
  }
  if (typeof event.type !== 'string' || !isRuntimeEventType(event.type)) {
    throw new Error(`journal event type is unsupported: ${String(event.type)}`);
  }
  if (typeof event.run_id !== 'string' || event.run_id.trim() === '') {
    throw new Error('journal event run_id must be a non-empty string');
  }
  if (typeof event.session_id !== 'string' || event.session_id.trim() === '') {
    throw new Error('journal event session_id must be a non-empty string');
  }
  if (typeof event.ts_ns !== 'bigint') {
    throw new Error('journal event ts_ns must revive to bigint');
  }
  if (event.causation_id !== undefined && String(event.causation_id).trim() === '') {
    throw new Error('journal event causation_id must be non-empty when provided');
  }

  assertCanonicalMarketDataTimestamp(event);
}

function assertCanonicalMarketDataTimestamp(event: JournalEventEnvelope): void {
  if (event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    return;
  }

  const payload = event.payload as Record<string, unknown>;
  const exchangeEventTsNs = payload.exchange_event_ts_ns;
  if (exchangeEventTsNs === undefined) {
    return;
  }
  if (typeof exchangeEventTsNs !== 'bigint') {
    throw new Error('payload.exchange_event_ts_ns must revive to bigint when present');
  }
  if (BigInt(event.ts_ns) !== exchangeEventTsNs) {
    throw new Error('market-data event ts_ns must equal payload.exchange_event_ts_ns');
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

  return { schema_version: JOURNAL_TRANSPORT_CHECKPOINT_SCHEMA_VERSION, files };
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
  };
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
