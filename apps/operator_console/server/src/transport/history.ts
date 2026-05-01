import type { JsonValue } from './json-safe.js';
import { assertJsonSafe } from './json-safe.js';
import type { ConsoleSnapshot, UnixNsString } from '../types/snapshot.js';

export const CONSOLE_HISTORY_PANELS = [
  'data_pipeline',
  'strategies',
  'trades',
  'positions',
  'pnl',
  'risk',
  'latency',
  'alerts',
  'system_health',
  'feature_surface',
  'mbo_shadow',
] as const;

export type ConsoleHistoryPanel = (typeof CONSOLE_HISTORY_PANELS)[number];

export interface ConsoleHistoryEntry {
  readonly panel: ConsoleHistoryPanel;
  readonly ts_ns: UnixNsString;
  readonly last_event_id: string | null;
  readonly state: JsonValue;
}

export interface ConsoleHistoryQuery {
  readonly panel: ConsoleHistoryPanel;
  readonly limit: number;
  readonly range_ms?: number;
}

export interface ConsoleHistoryResponse {
  readonly panel: ConsoleHistoryPanel;
  readonly limit: number;
  readonly range_ms: number | null;
  readonly rows: readonly ConsoleHistoryEntry[];
}

export interface ParseHistoryQueryOptions {
  readonly default_limit?: number;
  readonly max_limit?: number;
  readonly max_range_ms?: number;
}

export const DEFAULT_HISTORY_LIMIT = 100;
export const MAX_HISTORY_LIMIT = 1000;
export const DEFAULT_MAX_HISTORY_RANGE_MS = 86_400_000;

export class ConsoleHistoryStore {
  private readonly rows: ConsoleHistoryEntry[] = [];
  private lastSnapshotKey: string | null = null;

  recordSnapshot(snapshot: ConsoleSnapshot): void {
    const key = `${snapshot.generated_from.last_event_id ?? 'none'}:${snapshot.generated_from.event_count}`;
    if (this.lastSnapshotKey === key) {
      return;
    }
    this.lastSnapshotKey = key;
    const tsNs = snapshot.generated_from.last_event_ts_ns ?? nowNsString();

    for (const panel of CONSOLE_HISTORY_PANELS) {
      const state = panelState(snapshot, panel);
      assertJsonSafe(state);
      this.rows.push({
        panel,
        ts_ns: tsNs,
        last_event_id: snapshot.generated_from.last_event_id,
        state,
      });
    }
  }

  query(query: ConsoleHistoryQuery): ConsoleHistoryResponse {
    const nowNs = latestTimestampNs(this.rows, query.panel);
    const minimumNs = query.range_ms === undefined
      ? undefined
      : nowNs - (BigInt(query.range_ms) * 1_000_000n);
    const panelRows = this.rows
      .filter((row) => row.panel === query.panel)
      .filter((row) => minimumNs === undefined || BigInt(row.ts_ns) >= minimumNs)
      .slice(-query.limit);

    return {
      panel: query.panel,
      limit: query.limit,
      range_ms: query.range_ms ?? null,
      rows: panelRows,
    };
  }
}

export function parseHistoryQuery(
  searchParams: URLSearchParams,
  options: ParseHistoryQueryOptions = {},
): ConsoleHistoryQuery {
  const defaultLimit = options.default_limit ?? DEFAULT_HISTORY_LIMIT;
  const maxLimit = options.max_limit ?? MAX_HISTORY_LIMIT;
  const maxRangeMs = options.max_range_ms ?? DEFAULT_MAX_HISTORY_RANGE_MS;
  const panel = parsePanel(searchParams.get('panel'));
  const limit = parseLimit(searchParams.get('limit'), defaultLimit, maxLimit);
  const range = searchParams.get('range');
  const rangeMs = range === null ? undefined : parseIsoDurationMs(range);
  if (rangeMs !== undefined && rangeMs > maxRangeMs) {
    throw new Error(`range must not exceed ${formatDurationMs(maxRangeMs)}`);
  }
  return {
    panel,
    limit,
    ...(rangeMs === undefined ? {} : { range_ms: rangeMs }),
  };
}

export function parseIsoDurationMs(value: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (match === null) {
    throw new Error('range must be an ISO-8601 duration such as PT5M, PT1H, or P1D');
  }
  const [, daysRaw, hoursRaw, minutesRaw, secondsRaw] = match;
  if (
    daysRaw === undefined &&
    hoursRaw === undefined &&
    minutesRaw === undefined &&
    secondsRaw === undefined
  ) {
    throw new Error('range must include at least one duration component');
  }

  const days = Number(daysRaw ?? 0);
  const hours = Number(hoursRaw ?? 0);
  const minutes = Number(minutesRaw ?? 0);
  const seconds = Number(secondsRaw ?? 0);
  const totalMs = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  if (!Number.isSafeInteger(totalMs) || totalMs <= 0) {
    throw new Error('range must be a positive safe duration');
  }
  return totalMs;
}

function parsePanel(value: string | null): ConsoleHistoryPanel {
  if (value === null || value.length === 0) {
    throw new Error('panel is required');
  }
  if (!CONSOLE_HISTORY_PANELS.includes(value as ConsoleHistoryPanel)) {
    throw new Error(`unsupported history panel: ${value}`);
  }
  return value as ConsoleHistoryPanel;
}

function parseLimit(value: string | null, defaultLimit: number, maxLimit: number): number {
  if (value === null || value.length === 0) {
    return defaultLimit;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('limit must be a positive safe integer');
  }
  return Math.min(parsed, maxLimit);
}

function panelState(snapshot: ConsoleSnapshot, panel: ConsoleHistoryPanel): JsonValue {
  switch (panel) {
    case 'data_pipeline':
      return snapshot.data_pipeline as unknown as JsonValue;
    case 'strategies':
      return snapshot.strategies as unknown as JsonValue;
    case 'trades':
      return snapshot.trades as unknown as JsonValue;
    case 'positions':
      return snapshot.positions as unknown as JsonValue;
    case 'pnl':
      return snapshot.pnl as unknown as JsonValue;
    case 'risk':
      return snapshot.risk as unknown as JsonValue;
    case 'latency':
      return snapshot.latency as unknown as JsonValue;
    case 'alerts':
      return snapshot.alerts as unknown as JsonValue;
    case 'system_health':
      return snapshot.system_health as unknown as JsonValue;
    case 'feature_surface':
      return snapshot.feature_surface as unknown as JsonValue;
    case 'mbo_shadow':
      return (snapshot.mbo_shadow ?? null) as unknown as JsonValue;
  }
}

function latestTimestampNs(rows: readonly ConsoleHistoryEntry[], panel: ConsoleHistoryPanel): bigint {
  const latest = [...rows].reverse().find((row) => row.panel === panel);
  return latest === undefined ? BigInt(nowNsString()) : BigInt(latest.ts_ns);
}

function nowNsString(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString(10);
}

function formatDurationMs(value: number): string {
  return value === DEFAULT_MAX_HISTORY_RANGE_MS ? 'P1D' : `${value}ms`;
}
