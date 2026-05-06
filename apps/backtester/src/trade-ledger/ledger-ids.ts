import type { StrategyId } from '../../../strategy_runtime/src/contracts/strategy-ids.js';

export function deriveLedgerExecutionId(sourceEventId: string): string {
  assertNonEmptyString(sourceEventId, 'sourceEventId');
  return `execution-${sourceEventId}`;
}

export function deriveLedgerTradeId(runId: string, sequence: number): string {
  assertNonEmptyString(runId, 'runId');
  assertPositiveSafeInteger(sequence, 'sequence');
  return `trade-${runId}-${sequence}`;
}

export function deriveLedgerPositionId(
  instrumentId: number,
  strategyId: StrategyId | null,
  sequence: number,
): string {
  assertPositiveSafeInteger(instrumentId, 'instrumentId');
  assertPositiveSafeInteger(sequence, 'sequence');
  return `position-${instrumentId}-${strategyId ?? 'unknown_strategy'}-${sequence}`;
}

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}
