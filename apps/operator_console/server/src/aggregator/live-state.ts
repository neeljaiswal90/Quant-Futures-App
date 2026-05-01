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
} from '../types/snapshot.js';

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
  const alerts = aggregateAlerts(normalized, decisionEvents, options.max_alerts ?? 100);
  const featureSurface = aggregateFeatureSurface(allEvents, alerts);

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
      daily_loss_usage: maybeNumber(
        sessionRisk.realized_pnl_usd,
        'RISK_GATE.session_risk.realized_pnl_usd unavailable',
      ),
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

  return alerts.slice(Math.max(0, alerts.length - maxAlerts));
}

function aggregateFeatureSurface(
  events: readonly NormalizedJournalEvent[],
  alerts: readonly AlertState[],
): FeatureSurfaceState {
  const embeddedMask = latestEmbeddedMask(events);
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

function latestEmbeddedMask(events: readonly NormalizedJournalEvent[]): FeatureAvailabilityMask | undefined {
  for (const { event } of [...events].reverse()) {
    if (!FEATURE_SURFACE_EVENT_TYPES.has(event.type)) {
      continue;
    }
    const mask = jsonObject(payloadRecord(event).feature_availability_mask);
    if (isFeatureAvailabilityMask(mask)) {
      return mask;
    }
  }
  return undefined;
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

function isFeatureAvailabilityMask(value: unknown): value is FeatureAvailabilityMask {
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
