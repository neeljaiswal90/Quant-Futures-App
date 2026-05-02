import { stableJsonStringify } from './json-safe.js';
import type {
  AlertState,
  ConsoleDelta,
  ConsoleSnapshot,
  PositionState,
  StrategyGateState,
  TradeBlotterRow,
} from '@quant-futures/operator-console-contracts';

export interface SnapshotDeltaBatch {
  readonly immediate: readonly ConsoleDelta[];
  readonly telemetry: readonly ConsoleDelta[];
}

export function diffConsoleSnapshots(
  previous: ConsoleSnapshot,
  next: ConsoleSnapshot,
): SnapshotDeltaBatch {
  const immediate: ConsoleDelta[] = [];
  const telemetry: ConsoleDelta[] = [];

  if (changed(previous.data_pipeline, next.data_pipeline)) {
    telemetry.push({ kind: 'data_pipeline', patch: next.data_pipeline });
  }
  if (changed(previous.latency, next.latency)) {
    telemetry.push({ kind: 'latency', patch: next.latency });
  }

  for (const row of newTrades(previous.trades.rows, next.trades.rows)) {
    immediate.push({ kind: 'trade', row });
  }
  for (const position of changedPositions(previous.positions, next.positions)) {
    immediate.push({ kind: 'position', id: position.position_id, patch: position });
  }
  for (const strategy of changedStrategies(previous.strategies, next.strategies)) {
    immediate.push({ kind: 'strategy', id: strategy.strategy_id, patch: strategy });
  }
  for (const alert of newAlerts(previous.alerts, next.alerts)) {
    immediate.push({ kind: 'alert', alert });
  }

  if (changed(previous.pnl, next.pnl)) {
    immediate.push({ kind: 'pnl', patch: next.pnl });
  }
  if (changed(previous.risk, next.risk)) {
    immediate.push({ kind: 'risk', patch: next.risk });
  }
  if (changed(previous.system_health, next.system_health)) {
    immediate.push({ kind: 'system_health', patch: next.system_health });
  }
  if (changed(previous.feature_surface, next.feature_surface)) {
    immediate.push({ kind: 'feature_surface', patch: next.feature_surface });
  }
  if (changed(previous.mbo_shadow ?? null, next.mbo_shadow ?? null) && next.mbo_shadow !== undefined) {
    immediate.push({ kind: 'mbo_shadow', patch: next.mbo_shadow });
  }

  return { immediate, telemetry };
}

export function coalesceTelemetryDeltas(
  pending: readonly ConsoleDelta[],
  next: readonly ConsoleDelta[],
): readonly ConsoleDelta[] {
  const byKind = new Map<ConsoleDelta['kind'], ConsoleDelta>();
  for (const delta of [...pending, ...next]) {
    byKind.set(delta.kind, delta);
  }
  return [...byKind.values()];
}

function newTrades(
  previous: readonly TradeBlotterRow[],
  next: readonly TradeBlotterRow[],
): readonly TradeBlotterRow[] {
  const previousIds = new Set(previous.map((row) => row.event_id));
  return next.filter((row) => !previousIds.has(row.event_id));
}

function changedPositions(
  previous: readonly PositionState[],
  next: readonly PositionState[],
): readonly PositionState[] {
  const previousById = new Map(previous.map((position) => [position.position_id, position]));
  return next.filter((position) => changed(previousById.get(position.position_id) ?? null, position));
}

function changedStrategies(
  previous: readonly StrategyGateState[],
  next: readonly StrategyGateState[],
): readonly StrategyGateState[] {
  const previousById = new Map(previous.map((strategy) => [strategy.strategy_id, strategy]));
  return next.filter((strategy) => changed(previousById.get(strategy.strategy_id) ?? null, strategy));
}

function newAlerts(
  previous: readonly AlertState[],
  next: readonly AlertState[],
): readonly AlertState[] {
  const previousIds = new Set(previous.map((alert) => alert.id));
  return next.filter((alert) => !previousIds.has(alert.id));
}

function changed(previous: unknown, next: unknown): boolean {
  return stableJsonStringify(previous) !== stableJsonStringify(next);
}
