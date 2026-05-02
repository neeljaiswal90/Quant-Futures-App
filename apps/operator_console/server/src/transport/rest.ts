import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename } from 'node:path';
import { buildConsoleSnapshotFromEvents } from '../aggregator/live-state.js';
import { normalizeJournalTailResult, type EventNormalizerResult } from '../ingest/event-normalizer.js';
import { ingestJournalOnce } from '../ingest/journal-tail.js';
import { allowedCorsOrigin, authenticateRestRequest } from './auth.js';
import {
  ConsoleHistoryStore,
  DEFAULT_MAX_HISTORY_RANGE_MS,
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
  readonly journal_path: string;
  readonly ingest_options: JournalIngestOptions;
  readonly redact_journal_path?: boolean;
  readonly max_history_range_ms?: number;
  readonly transport_health?: () => {
    readonly ws_client_count: number;
    readonly ws_backpressure: boolean;
    readonly dropped_critical_frame_count: number;
  };
}

interface MergedNormalizerResult {
  events: EventNormalizerResult['events'];
  alerts: EventNormalizerResult['alerts'];
  malformed_or_schema_invalid_count: number;
  feature_policy_violation_count: number;
  blocked_feature_policy_violation_count: number;
  missing_terminal_order_intent_count: number;
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
  const history = new ConsoleHistoryStore();
  const merged: MergedNormalizerResult = {
    events: [],
    alerts: [],
    malformed_or_schema_invalid_count: 0,
    feature_policy_violation_count: 0,
    blocked_feature_policy_violation_count: 0,
    missing_terminal_order_intent_count: 0,
  };
  let latestSnapshot: ConsoleSnapshot | null = null;

  const refresh = (): ConsoleSnapshot => {
    const tailed = ingestJournalOnce({
      journal_path: options.journal_path,
      checkpoint_dir: options.ingest_options.checkpoint_dir,
    });
    const normalized = normalizeJournalTailResult(tailed);
    appendNormalizedResult(merged, normalized);
    latestSnapshot = buildConsoleSnapshotFromEvents(merged, {
      journal_path: options.redact_journal_path
        ? redactedJournalPath(options.journal_path)
        : options.journal_path,
      journal_path_redacted: options.redact_journal_path ?? false,
      ...options.transport_health?.(),
      checkpoint_status: {
        status: 'available',
        value: `checkpointed files=${Object.keys(tailed.checkpoint.files).length}`,
      },
    });
    history.recordSnapshot(latestSnapshot);
    return latestSnapshot;
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

function appendNormalizedResult(
  target: MergedNormalizerResult,
  next: EventNormalizerResult,
): void {
  target.events = [...target.events, ...next.events];
  target.alerts = [...target.alerts, ...next.alerts];
  target.malformed_or_schema_invalid_count += next.malformed_or_schema_invalid_count;
  target.feature_policy_violation_count += next.feature_policy_violation_count;
  target.blocked_feature_policy_violation_count += next.blocked_feature_policy_violation_count;
  target.missing_terminal_order_intent_count += next.missing_terminal_order_intent_count;
}

function redactedJournalPath(journalPath: string): string {
  const hash = createHash('sha256').update(journalPath).digest('hex').slice(0, 12);
  return `journal:${basename(journalPath)}:${hash}`;
}
