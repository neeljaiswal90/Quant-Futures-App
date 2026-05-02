import type { ConsoleDelta, ConsoleStreamFrame } from '../../../server/src/types/delta.js';
import {
  CONSOLE_SNAPSHOT_SCHEMA_VERSION,
  type AlertState,
  type ConsoleSnapshot,
  type FeatureSurfaceState,
  type PositionState,
  type StrategyGateState,
} from '../../../server/src/types/snapshot.js';

export interface StreamApplyResult {
  readonly snapshot: ConsoleSnapshot;
  readonly last_seq: string | null;
  readonly resync_required: boolean;
}

export function createUnavailableSnapshot(reason: string): ConsoleSnapshot {
  return {
    schema_version: CONSOLE_SNAPSHOT_SCHEMA_VERSION,
    run_id: 'unavailable',
    session_id: 'unavailable',
    generated_from: {
      journal_path: 'unavailable',
      journal_path_redacted: true,
      last_event_id: null,
      last_event_ts_ns: null,
      event_count: 0,
    },
    data_pipeline: {
      source_event_count: 0,
      by_type: {},
      last_event_age_ms: { status: 'unavailable', reason },
      malformed_or_schema_invalid_count: 0,
    },
    strategies: [],
    trades: { rows: [] },
    positions: [],
    pnl: {
      realized_pnl_usd: { status: 'unavailable', reason },
      unrealized_pnl_usd: { status: 'unavailable', reason },
      source: 'unavailable',
    },
    risk: {
      circuit_breaker_state: { status: 'unavailable', reason },
      daily_loss_usage: { status: 'unavailable', reason },
      open_trade_count: { status: 'unavailable', reason },
      rejected_trade_count: { status: 'unavailable', reason },
    },
    latency: {
      last_event_lag_ms: { status: 'unavailable', reason },
      telemetry_only: true,
    },
    alerts: [],
    system_health: {
      server_status: 'degraded',
      ws_client_count: 0,
      ws_backpressure: false,
      dropped_critical_frame_count: 0,
      checkpoint_status: { status: 'unavailable', reason },
    },
    feature_surface: {
      mask_version: 0,
      mask_id: 'unavailable',
      mask_hash: 'unavailable',
      mask_source: 'fallback',
      field_tiers: {},
      partition_counts: {
        authoritative: 0,
        subscope: 0,
        diagnostic_only: 0,
        shadow_only: 0,
        advisory_only: 0,
        blocked: 0,
        available: 0,
      },
      recent_violations: [],
    },
    mbo_shadow: {
      status: 'absent',
      decision_use: false,
      last_event_id: null,
    },
  };
}

export function applyConsoleStreamFrame(
  snapshot: ConsoleSnapshot,
  lastSeq: string | null,
  frame: ConsoleStreamFrame,
): StreamApplyResult {
  if (frame.kind === 'snapshot') {
    return {
      snapshot: frame.snapshot,
      last_seq: frame.seq,
      resync_required: false,
    };
  }

  if (frame.kind === 'resync_required') {
    return {
      snapshot,
      last_seq: frame.seq,
      resync_required: true,
    };
  }

  if (lastSeq !== null && frame.base_seq !== lastSeq) {
    return {
      snapshot,
      last_seq: lastSeq,
      resync_required: true,
    };
  }

  return {
    snapshot: applyConsoleDelta(snapshot, frame.delta),
    last_seq: frame.seq,
    resync_required: false,
  };
}

export function applyConsoleDelta(snapshot: ConsoleSnapshot, delta: ConsoleDelta): ConsoleSnapshot {
  switch (delta.kind) {
    case 'data_pipeline':
      return { ...snapshot, data_pipeline: { ...snapshot.data_pipeline, ...delta.patch } };
    case 'strategy':
      return { ...snapshot, strategies: upsertStrategy(snapshot.strategies, delta.id, delta.patch) };
    case 'trade':
      return {
        ...snapshot,
        trades: {
          rows: appendUnique(snapshot.trades.rows, delta.row, (row) => row.event_id),
        },
      };
    case 'position':
      return { ...snapshot, positions: upsertPosition(snapshot.positions, delta.id, delta.patch) };
    case 'pnl':
      return { ...snapshot, pnl: { ...snapshot.pnl, ...delta.patch } };
    case 'risk':
      return { ...snapshot, risk: { ...snapshot.risk, ...delta.patch } };
    case 'latency':
      return { ...snapshot, latency: { ...snapshot.latency, ...delta.patch } };
    case 'alert':
      return { ...snapshot, alerts: appendUnique(snapshot.alerts, delta.alert, (alert) => alert.id) };
    case 'system_health':
      return { ...snapshot, system_health: { ...snapshot.system_health, ...delta.patch } };
    case 'feature_surface':
      return {
        ...snapshot,
        feature_surface: { ...snapshot.feature_surface, ...delta.patch } as FeatureSurfaceState,
      };
    case 'mbo_shadow':
      return {
        ...snapshot,
        mbo_shadow: {
          ...(snapshot.mbo_shadow ?? { status: 'absent', decision_use: false, last_event_id: null }),
          ...delta.patch,
        },
      };
  }
}

export function isConsoleStreamFrame(value: unknown): value is ConsoleStreamFrame {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.kind === 'snapshot' || record.kind === 'delta' || record.kind === 'resync_required';
}

function upsertPosition(
  values: readonly PositionState[],
  id: string,
  patch: Partial<PositionState>,
): readonly PositionState[] {
  let found = false;
  const next = values.map((value) => {
    if (value.position_id !== id) {
      return value;
    }
    found = true;
    return { ...value, ...patch };
  });

  if (found) {
    return next;
  }
  return [...next, { position_id: id, ...patch } as PositionState];
}

function upsertStrategy(
  values: readonly StrategyGateState[],
  id: string,
  patch: Partial<StrategyGateState>,
): readonly StrategyGateState[] {
  let found = false;
  const next = values.map((value) => {
    if (value.strategy_id !== id) {
      return value;
    }
    found = true;
    return { ...value, ...patch };
  });

  if (found) {
    return next;
  }
  return [...next, { strategy_id: id, ...patch } as StrategyGateState];
}

function appendUnique<T extends AlertState | ConsoleSnapshot['trades']['rows'][number]>(
  values: readonly T[],
  next: T,
  id: (value: T) => string,
): readonly T[] {
  if (values.some((value) => id(value) === id(next))) {
    return values;
  }
  return [...values, next];
}
