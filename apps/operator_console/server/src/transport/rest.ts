import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  createConsoleLiveStateAccumulator,
  createConsoleLiveStateAccumulatorFromSnapshot,
  type ConsoleLiveStateAccumulator,
} from '../aggregator/live-state.js';
import { normalizeJournalTailResult } from '../ingest/event-normalizer.js';
import { ConsoleJournalPoller } from '../ingest/journal-poller.js';
import { selectJournalPath } from '../ingest/journal-discovery.js';
import { allowedCorsOrigin, authenticateRestRequest } from './auth.js';
import {
  ConsoleHistoryStore,
  DEFAULT_MAX_HISTORY_RANGE_MS,
  DEFAULT_MAX_HISTORY_ROWS_PER_PANEL,
  parseHistoryQuery,
  type ConsoleHistoryResponse,
} from './history.js';
import { assertJsonSafe, stableJsonStringify, type JsonValue } from './json-safe.js';
import type { JournalIngestOptions } from '../ingest/options.js';
import type { OperatorConsoleServerConfig } from '../runtime/config.js';
import { CONSOLE_SNAPSHOT_SCHEMA_VERSION, type ConsoleSnapshot } from '../types/snapshot.js';

export interface ConsoleRestDataSource {
  readonly refresh: () => Promise<ConsoleSnapshot> | ConsoleSnapshot;
  readonly history: (query: URLSearchParams) => ConsoleHistoryResponse;
}

export interface CreateOperatorConsoleRestServerOptions {
  readonly config: OperatorConsoleServerConfig;
  readonly data_source: ConsoleRestDataSource;
}

export interface JournalBackedDataSourceOptions {
  readonly journal_path?: string;
  readonly ingest_options: JournalIngestOptions;
  readonly redact_journal_path?: boolean;
  readonly max_history_range_ms?: number;
  readonly max_history_rows_per_panel?: number;
  readonly transport_health?: () => {
    readonly ws_client_count: number;
    readonly ws_backpressure: boolean;
    readonly dropped_critical_frame_count: number;
  };
}

export function createOperatorConsoleRestServer(
  options: CreateOperatorConsoleRestServerOptions,
): Server {
  return createServer(async (request, response) => {
    try {
      await handleRequest(options, request, response);
    } catch (error) {
      sendJson(response, 500, {
        error: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export function createJournalBackedRestDataSource(
  options: JournalBackedDataSourceOptions,
): ConsoleRestDataSource {
  const history = new ConsoleHistoryStore({
    max_rows_per_panel: options.max_history_rows_per_panel ?? DEFAULT_MAX_HISTORY_ROWS_PER_PANEL,
  });
  const resolvedJournalPath = options.journal_path ?? selectJournalPath(options.ingest_options).journal_path;
  const snapshotCachePath = checkpointSnapshotPath(options.ingest_options.checkpoint_dir);
  const resolvedJournalPathRedacted = options.redact_journal_path
    ? redactedJournalPath(resolvedJournalPath)
    : resolvedJournalPath;
  const resolvedJournalPathRedactedFlag = options.redact_journal_path ?? false;
  const restoredSnapshot = readCachedSnapshot(snapshotCachePath);
  const snapshotBuilder: ConsoleLiveStateAccumulator = restoredSnapshot === null
    ? createConsoleLiveStateAccumulator({
      journal_path: resolvedJournalPathRedacted,
      journal_path_redacted: resolvedJournalPathRedactedFlag,
    })
    : createConsoleLiveStateAccumulatorFromSnapshot(restoredSnapshot, {
      journal_path: resolvedJournalPathRedacted,
      journal_path_redacted: resolvedJournalPathRedactedFlag,
    });
  let latestSnapshot: ConsoleSnapshot | null = restoredSnapshot;
  let lastPersistedSnapshot: ConsoleSnapshot | null = latestSnapshot;
  const poller = new ConsoleJournalPoller(options.ingest_options);

  const refresh = (): ConsoleSnapshot => {
    const tailed = poller.pollOnce();
    const normalized = normalizeJournalTailResult(tailed);
    snapshotBuilder.applyNormalizedResult(normalized);
    const nextSnapshot = snapshotBuilder.snapshot({
      ...options.transport_health?.(),
      checkpoint_status: {
        status: 'available',
        value: `checkpointed files=${Object.keys(tailed.checkpoint.files).length}`,
      },
    });
    latestSnapshot = nextSnapshot;
    history.recordSnapshot(nextSnapshot);
    if (shouldPersistSnapshot(lastPersistedSnapshot, nextSnapshot)) {
      writeCachedSnapshot(snapshotCachePath, nextSnapshot);
      lastPersistedSnapshot = nextSnapshot;
    }
    return nextSnapshot;
  };

  return {
    refresh,
    history: (params) => {
      if (latestSnapshot === null) {
        refresh();
      }
      return history.query(parseHistoryQuery(params, {
        max_range_ms: options.max_history_range_ms ?? DEFAULT_MAX_HISTORY_RANGE_MS,
      }));
    },
  };
}

async function handleRequest(
  options: CreateOperatorConsoleRestServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? 'GET';
  if (method === 'OPTIONS') {
    handleOptionsRequest(options.config, request, response);
    return;
  }

  if (method !== 'GET') {
    sendJson(response, 405, { error: 'method_not_allowed', message: 'only GET is supported' });
    return;
  }

  const url = new URL(request.url ?? '/', 'http://operator-console.local');
  if (url.pathname === '/healthz') {
    applyCorsHeaders(response, allowedCorsOrigin(options.config, request));
    sendJson(response, 200, healthResponse());
    return;
  }

  const auth = authenticateRestRequest(options.config, request);
  if (!auth.ok) {
    applyCorsHeaders(response, allowedCorsOrigin(options.config, request));
    sendJson(response, auth.status_code ?? 403, {
      error: auth.status_code === 401 ? 'unauthorized' : 'forbidden',
      message: auth.message ?? 'request is not authorized',
    });
    return;
  }

  applyCorsHeaders(response, auth.allow_origin);

  if (url.pathname === '/snapshot') {
    sendJson(response, 200, await options.data_source.refresh());
    return;
  }

  if (url.pathname === '/history') {
    await options.data_source.refresh();
    try {
      sendJson(response, 200, options.data_source.history(url.searchParams));
    } catch (error) {
      sendJson(response, 400, {
        error: 'bad_history_query',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  sendJson(response, 404, { error: 'not_found', message: 'unknown operator console endpoint' });
}

function handleOptionsRequest(
  config: OperatorConsoleServerConfig,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const origin = request.headers.origin;
  const allowOrigin = allowedCorsOrigin(config, request);
  if (origin !== undefined && allowOrigin === undefined) {
    sendJson(response, 403, { error: 'forbidden', message: 'origin is not allowed' });
    return;
  }

  applyCorsHeaders(response, allowOrigin);
  response.statusCode = 204;
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.setHeader('Access-Control-Max-Age', '600');
  response.end();
}

function applyCorsHeaders(response: ServerResponse, allowOrigin: string | undefined): void {
  if (allowOrigin === undefined) {
    return;
  }
  response.setHeader('Access-Control-Allow-Origin', allowOrigin);
  response.setHeader('Vary', 'Origin');
}

function healthResponse(): JsonValue {
  return {
    status: 'ok',
    schema_version: CONSOLE_SNAPSHOT_SCHEMA_VERSION,
    server_status: 'running',
    uptime_ms: Math.floor(process.uptime() * 1000),
  };
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  assertJsonSafe(value);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(`${stableJsonStringify(value)}\n`);
}

function redactedJournalPath(journalPath: string): string {
  const hash = createHash('sha256').update(journalPath).digest('hex').slice(0, 12);
  return `journal:${basename(journalPath)}:${hash}`;
}

function checkpointSnapshotPath(checkpointDir: string): string {
  return join(resolve(checkpointDir), 'checkpoints', 'console-snapshot.json');
}

function readCachedSnapshot(path: string): ConsoleSnapshot | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!looksLikeConsoleSnapshot(raw)) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

function writeCachedSnapshot(path: string, snapshot: ConsoleSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, `${stableJsonStringify(snapshot)}\n`, 'utf8');
  renameSync(tmpPath, path);
}

function shouldPersistSnapshot(
  previous: ConsoleSnapshot | null,
  next: ConsoleSnapshot,
): boolean {
  if (previous === null) {
    return true;
  }
  return (
    previous.generated_from.last_event_id !== next.generated_from.last_event_id ||
    previous.generated_from.event_count !== next.generated_from.event_count ||
    previous.system_health.ws_client_count !== next.system_health.ws_client_count ||
    previous.system_health.ws_backpressure !== next.system_health.ws_backpressure ||
    previous.system_health.dropped_critical_frame_count !== next.system_health.dropped_critical_frame_count
  );
}

function looksLikeConsoleSnapshot(value: unknown): value is ConsoleSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const snapshot = value as Record<string, unknown>;
  return (
    snapshot.schema_version === CONSOLE_SNAPSHOT_SCHEMA_VERSION &&
    snapshot.generated_from !== undefined &&
    typeof snapshot.generated_from === 'object' &&
    snapshot.generated_from !== null &&
    !Array.isArray(snapshot.generated_from) &&
    typeof (snapshot.generated_from as Record<string, unknown>).event_count === 'number'
  );
}
