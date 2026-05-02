import type {
  JournalEventEnvelope,
  RuntimeEventType,
} from '../../../../strategy_runtime/src/contracts/events/index.js';
import {
  FEATURE_AVAILABILITY_MASK,
  type FeatureAvailabilityMask,
  type FeatureAvailabilityTier,
} from '../../../../strategy_runtime/src/features/availability-mask.js';
import type { EventNormalizerResult, NormalizedJournalEvent } from '../ingest/event-normalizer.js';
import {
  CONSOLE_SNAPSHOT_SCHEMA_VERSION,
  type AlertState,
  type ConsoleSnapshot,
  type FeatureSurfaceState,
  type MaybeAvailable,
  type MboShadowState,
  type PositionState,
  type StrategyGateState,
  type TradeBlotterRow,
  type UnixNsString,
} from '@quant-futures/operator-console-contracts';

export interface LiveStateSnapshotOptions {
  readonly journal_path: string;
  readonly journal_path_redacted?: boolean;
  readonly render_time_ns?: bigint | string;
  readonly server_status?: ConsoleSnapshot['system_health']['server_status'];
  readonly ws_client_count?: number;
  readonly ws_backpressure?: boolean;
  readonly dropped_critical_frame_count?: number;
  readonly checkpoint_status?: MaybeAvailable<string>;
  readonly max_trade_rows?: number;
  readonly max_alerts?: number;
}

export interface ConsoleLiveStateAccumulator {
  applyNormalizedResult: (normalized: EventNormalizerResult) => void;
  snapshot: (options?: LiveStateSnapshotRuntimeOptions) => ConsoleSnapshot;
  featureMask: () => FeatureAvailabilityMask | undefined;
}

export interface ConsoleLiveStateAccumulatorFromSnapshotOptions {
  readonly journal_path?: string;
  readonly journal_path_redacted?: boolean;
  readonly max_trade_rows?: number;
  readonly max_alerts?: number;
  readonly max_cached_alerts?: number;
  readonly feature_mask?: FeatureAvailabilityMask;
}

export interface ConsoleLiveStateAccumulatorOptions {
  readonly journal_path: string;
  readonly journal_path_redacted?: boolean;
  readonly max_trade_rows?: number;
  readonly max_alerts?: number;
  readonly max_cached_alerts?: number;
}

interface LiveStateSnapshotRuntimeOptions {
  readonly journal_path?: string;
  readonly journal_path_redacted?: boolean;
  readonly render_time_ns?: bigint | string;
  readonly server_status?: ConsoleSnapshot['system_health']['server_status'];
  readonly ws_client_count?: number;
  readonly ws_backpressure?: boolean;
  readonly dropped_critical_frame_count?: number;
  readonly checkpoint_status?: MaybeAvailable<string>;
  readonly max_trade_rows?: number;
  readonly max_alerts?: number;
}

interface MutablePosition {
  position_id: string;
  side: string;
  status: string;
  quantity_open: MaybeAvailable<number>;
  avg_entry_price: MaybeAvailable<number>;
  mark_price: MaybeAvailable<number>;
  realized_pnl_usd: MaybeAvailable<number>;
  unrealized_pnl_usd: MaybeAvailable<number>;
  last_management_action: string | null;
}

interface LatestRiskState {
  circuit_breaker_state: MaybeAvailable<string>;
  daily_loss_usage: MaybeAvailable<number>;
  open_trade_count: MaybeAvailable<number>;
  rejected_trade_count: MaybeAvailable<number>;
}

const DEFAULT_TRADE_ROWS = 200;
const DEFAULT_ALERT_ROWS = 100;
const DEFAULT_CACHED_ALERTS = 5000;

const TRADE_ROW_EVENT_TYPES = new Set<RuntimeEventType>([
  'ORDER_INTENT',
  'SIM_FILL',
  'EXEC_REJECT',
  'MGMT_ACTION',
  'POSITION',
]);

const FEATURE_SURFACE_EVENT_TYPES = new Set<RuntimeEventType>(['FEATURES', 'MICROSTRUCTURE']);

const EMPTY_TIER_COUNTS = {
  authoritative: 0,
  subscope: 0,
  diagnostic_only: 0,
  shadow_only: 0,
  advisory_only: 0,
  blocked: 0,
  available: 0,
} as const satisfies Readonly<Record<FeatureAvailabilityTier, number>>;

export function buildConsoleSnapshotFromEvents(
  normalized: EventNormalizerResult,
  options: LiveStateSnapshotOptions,
): ConsoleSnapshot {
  const allEvents = normalized.events;
  const decisionEvents = allEvents.filter((event) => event.decision_grade);
  const lastEvent = allEvents.at(-1);
  const lastEventTsNs = lastEvent === undefined ? null : nsString(lastEvent.event.ts_ns);
  const renderTimeNs = nsString(options.render_time_ns ?? lastEvent?.event.ts_ns);
  const runId = lastEvent?.event.run_id ?? 'unavailable';
  const sessionId = lastEvent?.event.session_id ?? 'unavailable';
  const byType = countByType(allEvents);
  const positions = aggregatePositions(decisionEvents);
  const risk = aggregateRisk(decisionEvents);
  const explicitRealizedPnl = sumExplicitRealizedPnl(decisionEvents);
  const unrealizedPnl = sumAvailable(
    positions.map((position) => position.unrealized_pnl_usd),
  );
  const maskBinding = selectEmbeddedFeatureMask(allEvents);
  const alerts = aggregateAlerts(
    normalized,
    decisionEvents,
    options.max_alerts ?? 100,
    maskBinding.alerts,
  );
  const featureSurface = aggregateFeatureSurface(maskBinding.mask, alerts);

  return {
    schema_version: CONSOLE_SNAPSHOT_SCHEMA_VERSION,
    run_id: runId,
    session_id: sessionId,
    generated_from: {
      journal_path: options.journal_path,
      journal_path_redacted: options.journal_path_redacted ?? false,
      last_event_id: lastEvent?.event.event_id ?? null,
      last_event_ts_ns: lastEventTsNs,
      event_count: allEvents.length,
    },
    data_pipeline: {
      source_event_count: allEvents.length,
      by_type: byType,
      last_event_age_ms: lastEventTsNs === null || renderTimeNs === null
        ? unavailable('no events yet')
        : available(nsDeltaMs(renderTimeNs, lastEventTsNs)),
      malformed_or_schema_invalid_count: normalized.malformed_or_schema_invalid_count,
    },
    strategies: aggregateStrategies(decisionEvents),
    trades: {
      rows: aggregateTradeRows(decisionEvents, options.max_trade_rows ?? 200),
    },
    positions,
    pnl: {
      realized_pnl_usd: explicitRealizedPnl,
      unrealized_pnl_usd: unrealizedPnl,
      source: explicitRealizedPnl.status === 'available' ? 'explicit_lifecycle_fact' : 'unavailable',
    },
    risk,
    latency: {
      last_event_lag_ms: lastEventTsNs === null || renderTimeNs === null
        ? unavailable('no events yet')
        : available(nsDeltaMs(renderTimeNs, lastEventTsNs)),
      telemetry_only: true,
    },
    alerts,
    system_health: {
      server_status: options.server_status ?? 'running',
      ws_client_count: options.ws_client_count ?? 0,
      ws_backpressure: options.ws_backpressure ?? false,
      dropped_critical_frame_count: options.dropped_critical_frame_count ?? 0,
      checkpoint_status: options.checkpoint_status ?? unavailable('not connected to journal checkpoint'),
    },
    feature_surface: featureSurface,
    mbo_shadow: aggregateMboShadow(allEvents),
  };
}

export function createConsoleLiveStateAccumulator(
  options: ConsoleLiveStateAccumulatorOptions,
): ConsoleLiveStateAccumulator {
  const state: MutableLiveState = createEmptyLiveState(options);
  return createLiveStateAccumulator(state);
}

export function createConsoleLiveStateAccumulatorFromSnapshot(
  snapshot: ConsoleSnapshot,
  options: ConsoleLiveStateAccumulatorFromSnapshotOptions = {},
): ConsoleLiveStateAccumulator {
  const state = createEmptyLiveState({
    journal_path: options.journal_path ?? snapshot.generated_from.journal_path,
    journal_path_redacted:
      options.journal_path_redacted ?? snapshot.generated_from.journal_path_redacted,
    max_trade_rows: options.max_trade_rows,
    max_alerts: options.max_alerts,
    max_cached_alerts: options.max_cached_alerts,
  });
  restoreLiveStateFromSnapshot(state, snapshot, options.feature_mask);
  return createLiveStateAccumulator(state);
}

function createLiveStateAccumulator(state: MutableLiveState): ConsoleLiveStateAccumulator {
  return {
    applyNormalizedResult: (next) => {
      for (const alert of next.alerts) {
        appendAlert(state, {
          id: alert.id,
          severity: alert.severity,
          message: alert.message,
          ...(alert.event_id === undefined ? {} : { event_id: alert.event_id }),
        });
      }

      for (const normalizedEvent of next.events) {
        applyNormalizedEvent(state, normalizedEvent);
        state.source_event_count += 1;
      }

      state.malformed_or_schema_invalid_count += next.malformed_or_schema_invalid_count;
      state.feature_policy_violation_count += next.feature_policy_violation_count;
      state.blocked_feature_policy_violation_count += next.blocked_feature_policy_violation_count;
      state.missing_terminal_order_intent_count += next.missing_terminal_order_intent_count;
    },
    snapshot: (runtimeOptions) => {
      const runtime = runtimeOptions ?? {};
      const hasAnyEvent = state.last_event_id !== null;
      const runId = hasAnyEvent ? state.last_run_id : 'unavailable';
      const sessionId = hasAnyEvent ? state.session_id : 'unavailable';
      const lastEventTsNs = state.last_event_ts_ns;
      const renderTimeNs = nsString(runtime.render_time_ns ?? state.last_event_ts_ns);
      const maxTradeRows = runtime.max_trade_rows ?? state.max_trade_rows;
      const maxAlerts = runtime.max_alerts ?? state.max_alerts;
      const alerts = trimToMax([...state.alerts, ...state.feature_mask_alerts], maxAlerts);
      const featureSurface = aggregateFeatureSurface(state.feature_mask, alerts);

      return {
        schema_version: CONSOLE_SNAPSHOT_SCHEMA_VERSION,
        run_id: runId,
        session_id: sessionId,
        generated_from: {
          journal_path: runtime.journal_path ?? state.journal_path,
          journal_path_redacted: runtime.journal_path_redacted ?? state.journal_path_redacted,
          last_event_id: state.last_event_id,
          last_event_ts_ns: lastEventTsNs,
          event_count: state.source_event_count,
        },
        data_pipeline: {
          source_event_count: state.source_event_count,
          by_type: { ...state.by_type },
          last_event_age_ms: lastEventTsNs === null || renderTimeNs === null
            ? unavailable('no events yet')
            : available(nsDeltaMs(renderTimeNs, lastEventTsNs)),
          malformed_or_schema_invalid_count: state.malformed_or_schema_invalid_count,
        },
        strategies: [...state.strategies.values()]
          .map((strategy) => ({ ...strategy }))
          .sort((left, right) => left.strategy_id.localeCompare(right.strategy_id)),
        trades: {
          rows: trimToMax(state.trades, maxTradeRows),
        },
        positions: [...state.positions.values()].map((position) => ({ ...position })).sort((left, right) =>
          left.position_id.localeCompare(right.position_id)),
        pnl: {
          realized_pnl_usd: state.explicit_realized_pnl_count === 0
            ? unavailable('no explicit MGMT_ACTION.realized_pnl_usd lifecycle facts')
            : available(state.explicit_realized_pnl_value),
          unrealized_pnl_usd: sumAvailable(
            [...state.positions.values()].map((position) => position.unrealized_pnl_usd),
          ),
          source: state.explicit_realized_pnl_count === 0
            ? 'unavailable'
            : 'explicit_lifecycle_fact',
        },
        risk: state.risk ?? {
          circuit_breaker_state: unavailable('no RISK_GATE.session_risk fact'),
          daily_loss_usage: unavailable('no RISK_GATE.session_risk fact'),
          open_trade_count: unavailable('no RISK_GATE.session_risk fact'),
          rejected_trade_count: unavailable('no RISK_GATE.session_risk fact'),
        },
        latency: {
          last_event_lag_ms: lastEventTsNs === null || renderTimeNs === null
            ? unavailable('no events yet')
            : available(nsDeltaMs(renderTimeNs, lastEventTsNs)),
          telemetry_only: true,
        },
        alerts,
        system_health: {
          server_status: runtime.server_status ?? 'running',
          ws_client_count: runtime.ws_client_count ?? 0,
          ws_backpressure: runtime.ws_backpressure ?? false,
          dropped_critical_frame_count: runtime.dropped_critical_frame_count ?? 0,
          checkpoint_status: runtime.checkpoint_status ?? unavailable('not connected to journal checkpoint'),
        },
        feature_surface: featureSurface,
        mbo_shadow: {
          status: state.mbo_shadow.status,
          decision_use: false,
          last_event_id: state.mbo_shadow.last_event_id,
        },
      };
    },
    featureMask: () => state.feature_mask,
  };
}

function createEmptyLiveState(options: ConsoleLiveStateAccumulatorOptions): MutableLiveState {
  return {
    journal_path: options.journal_path,
    journal_path_redacted: options.journal_path_redacted ?? false,
    max_trade_rows: options.max_trade_rows ?? DEFAULT_TRADE_ROWS,
    max_alerts: options.max_alerts ?? DEFAULT_ALERT_ROWS,
    max_cached_alerts: Math.max(options.max_cached_alerts ?? DEFAULT_CACHED_ALERTS, 100),
    source_event_count: 0,
    by_type: {},
    trades: [],
    positions: new Map(),
    strategies: new Map(),
    risk: null,
    feature_mask: undefined,
    feature_mask_alerts: [],
    explicit_realized_pnl_value: 0,
    explicit_realized_pnl_count: 0,
    explicit_realized_pnl_by_position: new Map(),
    mbo_shadow: { status: 'absent', last_event_id: null },
    alerts: [],
    malformed_or_schema_invalid_count: 0,
    feature_policy_violation_count: 0,
    blocked_feature_policy_violation_count: 0,
    missing_terminal_order_intent_count: 0,
    last_event_id: null,
    last_event_ts_ns: null,
    last_run_id: 'unavailable',
    session_id: 'unavailable',
  };
}

function restoreLiveStateFromSnapshot(
  state: MutableLiveState,
  snapshot: ConsoleSnapshot,
  featureMask?: FeatureAvailabilityMask,
): void {
  state.source_event_count = snapshot.generated_from.event_count;
  state.by_type = { ...snapshot.data_pipeline.by_type };
  state.trades = [...snapshot.trades.rows];

  state.positions.clear();
  state.strategies.clear();
  state.explicit_realized_pnl_by_position = new Map();
  state.explicit_realized_pnl_value = 0;
  state.explicit_realized_pnl_count = 0;
  for (const position of snapshot.positions) {
    const restoredPosition: MutablePosition = {
      position_id: position.position_id,
      side: position.side,
      status: position.status,
      quantity_open: { ...position.quantity_open },
      avg_entry_price: { ...position.avg_entry_price },
      mark_price: { ...position.mark_price },
      realized_pnl_usd: { ...position.realized_pnl_usd },
      unrealized_pnl_usd: { ...position.unrealized_pnl_usd },
      last_management_action: position.last_management_action,
    };
    state.positions.set(position.position_id, restoredPosition);
    if (position.realized_pnl_usd.status === 'available') {
      state.explicit_realized_pnl_by_position.set(position.position_id, position.realized_pnl_usd.value);
      state.explicit_realized_pnl_value += position.realized_pnl_usd.value;
      state.explicit_realized_pnl_count += 1;
    }
  }

  for (const strategy of snapshot.strategies) {
    state.strategies.set(strategy.strategy_id, {
      strategy_id: strategy.strategy_id,
      status: strategy.status,
      last_event_id: strategy.last_event_id,
      last_event_ts_ns: strategy.last_event_ts_ns,
    });
  }

  state.risk = {
    circuit_breaker_state: { ...snapshot.risk.circuit_breaker_state },
    daily_loss_usage: { ...snapshot.risk.daily_loss_usage },
    open_trade_count: { ...snapshot.risk.open_trade_count },
    rejected_trade_count: { ...snapshot.risk.rejected_trade_count },
  };

  state.feature_mask = featureMask ?? createFeatureMaskFromSnapshot(snapshot.feature_surface);
  state.feature_mask_alerts = [...snapshot.feature_surface.recent_violations];
  state.alerts = [...snapshot.alerts];
  if (state.alerts.length > state.max_cached_alerts) {
    state.alerts = state.alerts.slice(state.alerts.length - state.max_cached_alerts);
  }

  state.malformed_or_schema_invalid_count = snapshot.data_pipeline.malformed_or_schema_invalid_count;
  state.feature_policy_violation_count = snapshot.feature_surface.recent_violations.length;
  state.blocked_feature_policy_violation_count = snapshot.feature_surface.recent_violations
    .filter((alert) => alert.severity === 'critical')
    .length;
  state.missing_terminal_order_intent_count = snapshot.alerts
    .filter((alert) => alert.id.startsWith('missing-terminal-order-intent:'))
    .length;

  state.last_event_id = snapshot.generated_from.last_event_id;
  state.last_event_ts_ns = snapshot.generated_from.last_event_ts_ns;
  state.last_run_id = snapshot.run_id;
  state.session_id = snapshot.session_id;
  state.mbo_shadow = {
    status: snapshot.mbo_shadow?.status ?? 'absent',
    last_event_id: snapshot.mbo_shadow?.last_event_id ?? null,
  };
}

function createFeatureMaskFromSnapshot(featureSurface: FeatureSurfaceState): FeatureAvailabilityMask {
  if (featureSurface.mask_source === 'fallback') {
    return featureSurface.fallback_mask ?? FEATURE_AVAILABILITY_MASK;
  }

  return {
    ...FEATURE_AVAILABILITY_MASK,
    schema_version: FEATURE_AVAILABILITY_MASK.schema_version,
    mask_version: featureSurface.mask_version as FeatureAvailabilityMask['mask_version'],
    mask_id: featureSurface.mask_id as FeatureAvailabilityMask['mask_id'],
    mask_hash: featureSurface.mask_hash,
    field_tiers: featureSurface.field_tiers as FeatureAvailabilityMask['field_tiers'],
  };
}

interface MutableLiveState {
  journal_path: string;
  journal_path_redacted: boolean;
  max_trade_rows: number;
  max_alerts: number;
  max_cached_alerts: number;
  source_event_count: number;
  by_type: Partial<Record<RuntimeEventType, number>>;
  trades: TradeBlotterRow[];
  positions: Map<string, MutablePosition>;
  strategies: Map<string, StrategyGateState>;
  risk: LatestRiskState | null;
  feature_mask: FeatureAvailabilityMask | undefined;
  feature_mask_alerts: readonly AlertState[];
  explicit_realized_pnl_value: number;
  explicit_realized_pnl_count: number;
  explicit_realized_pnl_by_position: Map<string, number>;
  mbo_shadow: { status: MboShadowState['status']; last_event_id: string | null };
  alerts: AlertState[];
  malformed_or_schema_invalid_count: number;
  feature_policy_violation_count: number;
  blocked_feature_policy_violation_count: number;
  missing_terminal_order_intent_count: number;
  last_event_id: string | null;
  last_event_ts_ns: UnixNsString | null;
  last_run_id: string;
  session_id: string;
}

function applyNormalizedEvent(state: MutableLiveState, normalizedEvent: { readonly event: JournalEventEnvelope; readonly decision_grade: boolean }): void {
  const event = normalizedEvent.event;
  const payload = payloadRecord(event);
  state.by_type[event.type] = (state.by_type[event.type] ?? 0) + 1;
  state.last_event_id = event.event_id;
  state.last_event_ts_ns = nsString(event.ts_ns);
  state.last_run_id = event.run_id;
  state.session_id = event.session_id;

  if (FEATURE_SURFACE_EVENT_TYPES.has(event.type)) {
    applyMboShadowEvent(state, event);
    applyEmbeddedFeatureMask(state, event, payload);
  }

  if (!normalizedEvent.decision_grade) {
    return;
  }

  if (TRADE_ROW_EVENT_TYPES.has(event.type)) {
    applyTradeRow(state, event, payload);
  }

  if (event.type === 'STRAT_EVAL') {
    const strategyId = stringValue(payload.strategy_id);
    if (strategyId !== undefined) {
      state.strategies.set(strategyId, {
        strategy_id: strategyId,
        status: 'available',
        last_event_id: event.event_id,
        last_event_ts_ns: nsString(event.ts_ns),
      });
    }
    return;
  }

  if (event.type === 'POSITION' || event.type === 'MGMT_TICK' || event.type === 'MGMT_ACTION') {
    const positionId = stringValue(payload.position_id);
    if (positionId === undefined) {
      return;
    }
    const position = ensurePosition(state.positions, positionId);

    if (event.type === 'POSITION') {
      position.side = stringValue(payload.side) ?? position.side;
      position.status = stringValue(payload.status) ?? position.status;
      position.quantity_open = maybeNumber(payload.quantity_open, 'POSITION.quantity_open unavailable');
      position.avg_entry_price = maybeNumber(payload.avg_entry_price, 'POSITION.avg_entry_price unavailable');
      return;
    }

    if (event.type === 'MGMT_TICK') {
      position.mark_price = maybeNumber(payload.mark_price, 'MGMT_TICK.mark_price unavailable');
      position.unrealized_pnl_usd = maybeNumber(
        payload.unrealized_pnl_usd,
        'MGMT_TICK.unrealized_pnl_usd unavailable',
      );
      return;
    }

    position.last_management_action = stringValue(payload.action_type) ?? event.event_id;
    const realizedPnl = numberValue(payload.realized_pnl_usd);
    if (realizedPnl !== undefined) {
      state.explicit_realized_pnl_value += realizedPnl;
      state.explicit_realized_pnl_count += 1;
      const previousPositionPnl = state.explicit_realized_pnl_by_position.get(positionId) ?? 0;
      const nextPositionPnl = previousPositionPnl + realizedPnl;
      state.explicit_realized_pnl_by_position.set(positionId, nextPositionPnl);
      position.realized_pnl_usd = available(nextPositionPnl);
      return;
    }
    return;
  }

  if (event.type === 'RISK_GATE') {
    const sessionRisk = jsonObject(payload.session_risk);
    if (sessionRisk === null) {
      return;
    }
    state.risk = {
      circuit_breaker_state: maybeString(
        sessionRisk.circuit_breaker_state,
        'RISK_GATE.session_risk.circuit_breaker_state unavailable',
      ),
      daily_loss_usage: unavailable('no daily_loss_usage fact in RISK_GATE.session_risk'),
      open_trade_count: maybeNumber(
        sessionRisk.open_trade_count,
        'RISK_GATE.session_risk.open_trade_count unavailable',
      ),
      rejected_trade_count: maybeNumber(
        sessionRisk.rejected_trade_count,
        'RISK_GATE.session_risk.rejected_trade_count unavailable',
      ),
    };
    return;
  }

  applyDecisionEventAlert(state, event, payload);
}

function applyTradeRow(
  state: MutableLiveState,
  event: JournalEventEnvelope,
  payload: Record<string, unknown>,
): void {
  const row: TradeBlotterRow = {
    event_id: event.event_id,
    type: event.type as TradeBlotterRow['type'],
    ts_ns: nsString(event.ts_ns) ?? '0',
    summary: summarizeTradeEvent(event),
  };
  state.trades.push(row);
  if (state.trades.length > state.max_trade_rows) {
    state.trades.splice(0, state.trades.length - state.max_trade_rows);
  }
}

function applyMboShadowEvent(
  state: MutableLiveState,
  event: JournalEventEnvelope,
): void {
  const payload = payloadRecord(event);
  const shadowValues = jsonObject(payload.shadow_values);
  const diagnosticValues = jsonObject(payload.diagnostic_values);
  if (shadowValues !== null && Object.keys(shadowValues).length > 0) {
    state.mbo_shadow = {
      status: 'shadow',
      last_event_id: event.event_id,
    };
    return;
  }
  if (state.mbo_shadow.status === 'absent' && diagnosticValues !== null && Object.keys(diagnosticValues).length > 0) {
    state.mbo_shadow = {
      status: 'diagnostic',
      last_event_id: event.event_id,
    };
  }
}

function applyEmbeddedFeatureMask(
  state: MutableLiveState,
  event: JournalEventEnvelope,
  payload: Record<string, unknown>,
): void {
  const rawMask = payload.feature_availability_mask;
  if (rawMask === undefined) {
    return;
  }
  const mask = jsonObject(rawMask);
  if (isFeatureAvailabilityMask(mask)) {
    state.feature_mask = mask;
    state.feature_mask_alerts = [];
  } else {
    state.feature_mask = undefined;
    state.feature_mask_alerts = embeddedMaskAlerts(mask, event);
  }
}

function applyDecisionEventAlert(
  state: MutableLiveState,
  event: JournalEventEnvelope,
  payload: Record<string, unknown>,
): void {
  if (event.type === 'EXEC_REJECT') {
    appendAlert(state, {
      id: `exec-reject:${event.event_id}`,
      severity: 'warning',
      message: `Simulated execution ${stringValue(payload.status) ?? 'rejected'}: ${
        stringValue(payload.reason) ?? event.event_id
      }`,
      event_id: event.event_id,
    });
  }
  if (event.type === 'GAP') {
    appendAlert(state, {
      id: `gap:${event.event_id}`,
      severity: 'warning',
      message: `Feed gap on ${stringValue(payload.stream) ?? 'unknown stream'}`,
      event_id: event.event_id,
    });
  }
  if (event.type === 'FEED') {
    const stateValue = stringValue(payload.state);
    if (stateValue === 'stale' || stateValue === 'gap' || stateValue === 'closed') {
      appendAlert(state, {
        id: `feed:${event.event_id}`,
        severity: stateValue === 'closed' ? 'critical' : 'warning',
        message: `Feed state is ${stateValue}${
          stringValue(payload.stream) === undefined ? '' : ` for ${stringValue(payload.stream)}`
        }`,
        event_id: event.event_id,
      });
    }
  }
  if (event.type === 'HALT' && stringValue(payload.state) === 'halted') {
    appendAlert(state, {
      id: `halt:${event.event_id}`,
      severity: 'critical',
      message: `Runtime halt: ${stringValue(payload.reason) ?? 'no reason provided'}`,
      event_id: event.event_id,
    });
  }
}

function appendAlert(state: MutableLiveState, alert: AlertState): void {
  state.alerts.push(alert);
  if (state.alerts.length > state.max_cached_alerts) {
    state.alerts.splice(0, state.alerts.length - state.max_cached_alerts);
  }
}

function trimToMax<T>(items: readonly T[], maxItems: number): readonly T[] {
  return items.length <= maxItems ? [...items] : items.slice(items.length - maxItems);
}

function countByType(
  events: readonly NormalizedJournalEvent[],
): Partial<Record<RuntimeEventType, number>> {
  const counts: Partial<Record<RuntimeEventType, number>> = {};
  for (const { event } of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
}

function aggregateStrategies(events: readonly NormalizedJournalEvent[]): readonly StrategyGateState[] {
  const strategies = new Map<string, StrategyGateState>();
  for (const { event } of events) {
    if (event.type !== 'STRAT_EVAL') {
      continue;
    }
    const payload = payloadRecord(event);
    const strategyId = stringValue(payload.strategy_id);
    if (strategyId === undefined) {
      continue;
    }
    strategies.set(strategyId, {
      strategy_id: strategyId,
      status: 'available',
      last_event_id: event.event_id,
      last_event_ts_ns: nsString(event.ts_ns),
    });
  }
  return [...strategies.values()].sort((left, right) => left.strategy_id.localeCompare(right.strategy_id));
}

function aggregateTradeRows(
  events: readonly NormalizedJournalEvent[],
  maxRows: number,
): readonly TradeBlotterRow[] {
  const rows = events
    .filter(({ event }) => TRADE_ROW_EVENT_TYPES.has(event.type))
    .map(({ event }) => ({
      event_id: event.event_id,
      type: event.type as TradeBlotterRow['type'],
      ts_ns: nsString(event.ts_ns) ?? '0',
      summary: summarizeTradeEvent(event),
    }));
  return rows.slice(Math.max(0, rows.length - maxRows));
}

function aggregatePositions(events: readonly NormalizedJournalEvent[]): readonly PositionState[] {
  const positions = new Map<string, MutablePosition>();

  for (const { event } of events) {
    const payload = payloadRecord(event);
    const positionId = stringValue(payload.position_id);
    if (positionId === undefined) {
      continue;
    }
    const position = ensurePosition(positions, positionId);

    if (event.type === 'POSITION') {
      position.side = stringValue(payload.side) ?? position.side;
      position.status = stringValue(payload.status) ?? position.status;
      position.quantity_open = maybeNumber(payload.quantity_open, 'POSITION.quantity_open unavailable');
      position.avg_entry_price = maybeNumber(payload.avg_entry_price, 'POSITION.avg_entry_price unavailable');
      continue;
    }

    if (event.type === 'MGMT_TICK') {
      position.mark_price = maybeNumber(payload.mark_price, 'MGMT_TICK.mark_price unavailable');
      position.unrealized_pnl_usd = maybeNumber(
        payload.unrealized_pnl_usd,
        'MGMT_TICK.unrealized_pnl_usd unavailable',
      );
      continue;
    }

    if (event.type === 'MGMT_ACTION') {
      position.last_management_action = stringValue(payload.action_type) ?? event.event_id;
      const realizedPnl = numberValue(payload.realized_pnl_usd);
      if (realizedPnl !== undefined) {
        const previous = position.realized_pnl_usd.status === 'available'
          ? position.realized_pnl_usd.value
          : 0;
        position.realized_pnl_usd = available(previous + realizedPnl);
      }
    }
  }

  return [...positions.values()]
    .map((position) => ({ ...position }))
    .sort((left, right) => left.position_id.localeCompare(right.position_id));
}

function aggregateRisk(events: readonly NormalizedJournalEvent[]): LatestRiskState {
  let latest: LatestRiskState | undefined;
  for (const { event } of events) {
    if (event.type !== 'RISK_GATE') {
      continue;
    }
    const sessionRisk = jsonObject(payloadRecord(event).session_risk);
    if (sessionRisk === null) {
      continue;
    }
    latest = {
      circuit_breaker_state: maybeString(
        sessionRisk.circuit_breaker_state,
        'RISK_GATE.session_risk.circuit_breaker_state unavailable',
      ),
      daily_loss_usage: unavailable('no daily_loss_usage fact in RISK_GATE.session_risk'),
      open_trade_count: maybeNumber(
        sessionRisk.open_trade_count,
        'RISK_GATE.session_risk.open_trade_count unavailable',
      ),
      rejected_trade_count: maybeNumber(
        sessionRisk.rejected_trade_count,
        'RISK_GATE.session_risk.rejected_trade_count unavailable',
      ),
    };
  }

  return latest ?? {
    circuit_breaker_state: unavailable('no RISK_GATE.session_risk fact'),
    daily_loss_usage: unavailable('no RISK_GATE.session_risk fact'),
    open_trade_count: unavailable('no RISK_GATE.session_risk fact'),
    rejected_trade_count: unavailable('no RISK_GATE.session_risk fact'),
  };
}

function sumExplicitRealizedPnl(events: readonly NormalizedJournalEvent[]): MaybeAvailable<number> {
  let total = 0;
  let count = 0;
  for (const { event } of events) {
    if (event.type !== 'MGMT_ACTION') {
      continue;
    }
    const realizedPnl = numberValue(payloadRecord(event).realized_pnl_usd);
    if (realizedPnl !== undefined) {
      total += realizedPnl;
      count += 1;
    }
  }
  return count === 0
    ? unavailable('no explicit MGMT_ACTION.realized_pnl_usd lifecycle facts')
    : available(total);
}

function aggregateAlerts(
  normalized: EventNormalizerResult,
  events: readonly NormalizedJournalEvent[],
  maxAlerts: number,
  extraAlerts: readonly AlertState[] = [],
): readonly AlertState[] {
  const alerts: AlertState[] = normalized.alerts.map((alert) => ({
    id: alert.id,
    severity: alert.severity,
    message: alert.message,
    ...(alert.event_id === undefined ? {} : { event_id: alert.event_id }),
  }));

  for (const { event } of events) {
    const payload = payloadRecord(event);
    if (event.type === 'EXEC_REJECT') {
      alerts.push({
        id: `exec-reject:${event.event_id}`,
        severity: 'warning',
        message: `Simulated execution ${stringValue(payload.status) ?? 'rejected'}: ${
          stringValue(payload.reason) ?? event.event_id
        }`,
        event_id: event.event_id,
      });
    }
    if (event.type === 'GAP') {
      alerts.push({
        id: `gap:${event.event_id}`,
        severity: 'warning',
        message: `Feed gap on ${stringValue(payload.stream) ?? 'unknown stream'}`,
        event_id: event.event_id,
      });
    }
    if (event.type === 'FEED') {
      const state = stringValue(payload.state);
      if (state === 'stale' || state === 'gap' || state === 'closed') {
        alerts.push({
          id: `feed:${event.event_id}`,
          severity: state === 'closed' ? 'critical' : 'warning',
          message: `Feed state is ${state}${stringValue(payload.stream) === undefined ? '' : ` for ${stringValue(payload.stream)}`}`,
          event_id: event.event_id,
        });
      }
    }
    if (event.type === 'HALT' && stringValue(payload.state) === 'halted') {
      alerts.push({
        id: `halt:${event.event_id}`,
        severity: 'critical',
        message: `Runtime halt: ${stringValue(payload.reason) ?? 'no reason provided'}`,
        event_id: event.event_id,
      });
    }
  }

  alerts.push(...extraAlerts);
  return alerts.slice(Math.max(0, alerts.length - maxAlerts));
}

function aggregateFeatureSurface(
  embeddedMask: FeatureAvailabilityMask | undefined,
  alerts: readonly AlertState[],
): FeatureSurfaceState {
  const mask = embeddedMask ?? FEATURE_AVAILABILITY_MASK;
  const fieldTiers = { ...mask.field_tiers };
  return {
    mask_version: mask.mask_version,
    mask_id: mask.mask_id,
    mask_hash: mask.mask_hash,
    mask_source: embeddedMask === undefined ? 'fallback' : 'embedded',
    field_tiers: fieldTiers,
    partition_counts: countMaskTiers(mask),
    recent_violations: alerts.filter((alert) => alert.id.startsWith('feature-policy-')).slice(-20),
    ...(embeddedMask === undefined ? { fallback_mask: FEATURE_AVAILABILITY_MASK } : {}),
  };
}

function aggregateMboShadow(events: readonly NormalizedJournalEvent[]): MboShadowState {
  let status: MboShadowState['status'] = 'absent';
  let lastEventId: string | null = null;
  for (const { event } of events) {
    if (!FEATURE_SURFACE_EVENT_TYPES.has(event.type)) {
      continue;
    }
    const payload = payloadRecord(event);
    const shadowValues = jsonObject(payload.shadow_values);
    const diagnosticValues = jsonObject(payload.diagnostic_values);
    if (shadowValues !== null && Object.keys(shadowValues).length > 0) {
      status = 'shadow';
      lastEventId = event.event_id;
    } else if (status === 'absent' && diagnosticValues !== null && Object.keys(diagnosticValues).length > 0) {
      status = 'diagnostic';
      lastEventId = event.event_id;
    }
  }
  return {
    status,
    decision_use: false,
    last_event_id: lastEventId,
  };
}

interface EmbeddedFeatureMaskSelection {
  readonly mask?: FeatureAvailabilityMask;
  readonly alerts: readonly AlertState[];
}

function selectEmbeddedFeatureMask(events: readonly NormalizedJournalEvent[]): EmbeddedFeatureMaskSelection {
  for (const { event } of [...events].reverse()) {
    if (!FEATURE_SURFACE_EVENT_TYPES.has(event.type)) {
      continue;
    }
    const rawMask = payloadRecord(event).feature_availability_mask;
    if (rawMask === undefined) {
      continue;
    }
    const mask = jsonObject(rawMask);
    if (isFeatureAvailabilityMask(mask)) {
      return { mask, alerts: [] };
    }
    return { alerts: embeddedMaskAlerts(mask, event) };
  }
  return { alerts: [] };
}

function embeddedMaskAlerts(
  mask: Record<string, unknown> | null,
  event: JournalEventEnvelope,
): readonly AlertState[] {
  if (mask === null) {
    return [{
      id: `feature-policy-mask-invalid:${event.event_id}`,
      severity: 'critical',
      message: 'Embedded feature_availability_mask is not a JSON object; using fallback v5 mask',
      event_id: event.event_id,
    }];
  }

  if (mask.schema_version !== FEATURE_AVAILABILITY_MASK.schema_version) {
    return [{
      id: `feature-policy-mask-schema-mismatch:${event.event_id}`,
      severity: 'critical',
      message: `Embedded feature mask schema_version ${String(mask.schema_version)} does not match expected ${FEATURE_AVAILABILITY_MASK.schema_version}; using fallback v5 mask`,
      event_id: event.event_id,
    }];
  }

  if (mask.mask_version !== FEATURE_AVAILABILITY_MASK.mask_version) {
    return [{
      id: `feature-policy-mask-version-mismatch:${event.event_id}`,
      severity: 'critical',
      message: `Embedded feature mask version ${String(mask.mask_version)} does not match expected ${FEATURE_AVAILABILITY_MASK.mask_version}; using fallback v5 mask`,
      event_id: event.event_id,
    }];
  }

  if (
    typeof mask.mask_id !== 'string' ||
    typeof mask.mask_hash !== 'string' ||
    jsonObject(mask.field_tiers) === null
  ) {
    return [{
      id: `feature-policy-mask-invalid:${event.event_id}`,
      severity: 'critical',
      message: 'Embedded feature mask is missing mask_id, mask_hash, or field_tiers; using fallback v5 mask',
      event_id: event.event_id,
    }];
  }

  if (
    mask.mask_id !== FEATURE_AVAILABILITY_MASK.mask_id ||
    mask.mask_hash !== FEATURE_AVAILABILITY_MASK.mask_hash
  ) {
    return [{
      id: `feature-policy-mask-identity-mismatch:${event.event_id}`,
      severity: 'warning',
      message: 'Embedded feature mask identity does not match the fallback v5 audit mask; using fallback v5 mask',
      event_id: event.event_id,
    }];
  }

  return [];
}

function countMaskTiers(
  mask: FeatureAvailabilityMask,
): Readonly<Record<FeatureAvailabilityTier, number>> {
  const counts: Record<FeatureAvailabilityTier, number> = { ...EMPTY_TIER_COUNTS };
  for (const tier of Object.values(mask.field_tiers)) {
    counts[tier] += 1;
  }
  return counts;
}

function ensurePosition(
  positions: Map<string, MutablePosition>,
  positionId: string,
): MutablePosition {
  const existing = positions.get(positionId);
  if (existing !== undefined) {
    return existing;
  }
  const created: MutablePosition = {
    position_id: positionId,
    side: 'unavailable',
    status: 'unavailable',
    quantity_open: unavailable('no POSITION.quantity_open fact'),
    avg_entry_price: unavailable('no POSITION.avg_entry_price fact'),
    mark_price: unavailable('no MGMT_TICK.mark_price fact'),
    realized_pnl_usd: unavailable('no explicit MGMT_ACTION.realized_pnl_usd lifecycle facts'),
    unrealized_pnl_usd: unavailable('no MGMT_TICK.unrealized_pnl_usd fact'),
    last_management_action: null,
  };
  positions.set(positionId, created);
  return created;
}

function summarizeTradeEvent(event: JournalEventEnvelope): string {
  const payload = payloadRecord(event);
  switch (event.type) {
    case 'ORDER_INTENT':
      return `order=${stringValue(payload.order_intent_id) ?? '--'} type=${
        stringValue(payload.order_type) ?? '--'
      } side=${stringValue(payload.side) ?? '--'} qty=${numberText(payload.quantity)}`;
    case 'SIM_FILL':
      return `fill=${stringValue(payload.fill_id) ?? '--'} order=${
        stringValue(payload.order_intent_id) ?? '--'
      } px=${numberText(payload.price)} qty=${numberText(payload.quantity)} liq=${
        stringValue(payload.liquidity) ?? '--'
      }`;
    case 'EXEC_REJECT':
      return `reject=${stringValue(payload.execution_reject_id) ?? '--'} order=${
        stringValue(payload.order_intent_id) ?? '--'
      } status=${stringValue(payload.status) ?? '--'} reason=${stringValue(payload.reason) ?? '--'}`;
    case 'POSITION':
      return `position=${stringValue(payload.position_id) ?? '--'} status=${
        stringValue(payload.status) ?? '--'
      } side=${stringValue(payload.side) ?? '--'} qty_open=${numberText(payload.quantity_open)}`;
    case 'MGMT_ACTION':
      return `mgmt=${stringValue(payload.management_action_id) ?? '--'} position=${
        stringValue(payload.position_id) ?? '--'
      } action=${stringValue(payload.action_type) ?? '--'} realized_pnl_usd=${
        numberText(payload.realized_pnl_usd)
      }`;
    default:
      return event.type;
  }
}

function sumAvailable(values: readonly MaybeAvailable<number>[]): MaybeAvailable<number> {
  const availableValues = values.filter((value): value is { status: 'available'; value: number } =>
    value.status === 'available'
  );
  if (availableValues.length === 0) {
    return unavailable('no explicit unrealized P&L mark facts');
  }
  return available(availableValues.reduce((sum, item) => sum + item.value, 0));
}

export function isFeatureAvailabilityMask(value: unknown): value is FeatureAvailabilityMask {
  const record = jsonObject(value);
  return (
    record !== null &&
    record.schema_version === FEATURE_AVAILABILITY_MASK.schema_version &&
    record.mask_version === FEATURE_AVAILABILITY_MASK.mask_version &&
    typeof record.mask_id === 'string' &&
    typeof record.mask_hash === 'string' &&
    jsonObject(record.field_tiers) !== null
  );
}

function payloadRecord(event: JournalEventEnvelope): Record<string, unknown> {
  return jsonObject(event.payload) ?? {};
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function available<T>(value: T): MaybeAvailable<T> {
  return { status: 'available', value };
}

function unavailable(reason: string): MaybeAvailable<never> {
  return { status: 'unavailable', reason };
}

function maybeNumber(value: unknown, reason: string): MaybeAvailable<number> {
  const number = numberValue(value);
  return number === undefined ? unavailable(reason) : available(number);
}

function maybeString(value: unknown, reason: string): MaybeAvailable<string> {
  const string = stringValue(value);
  return string === undefined ? unavailable(reason) : available(string);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberText(value: unknown): string {
  const number = numberValue(value);
  return number === undefined ? '--' : `${number}`;
}

function nsString(value: unknown): UnixNsString | null {
  if (typeof value === 'bigint') {
    return value.toString(10);
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value.toString(10);
  }
  return null;
}

function nsDeltaMs(leftNs: string, rightNs: string): number {
  const diff = BigInt(leftNs) - BigInt(rightNs);
  return Number(diff < 0n ? 0n : diff / 1_000_000n);
}
