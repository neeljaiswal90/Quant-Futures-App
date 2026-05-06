import type {
  AnyJournalEventEnvelope,
  JournalEventEnvelope,
  JournalEventPayloadFor,
} from '../../../strategy_runtime/src/contracts/events/index.js';
import type { StrategyId } from '../../../strategy_runtime/src/contracts/strategy-ids.js';
import { isStrategyId } from '../../../strategy_runtime/src/contracts/strategy-ids.js';
import type { UnixNs } from '../../../strategy_runtime/src/contracts/time.js';
import { adaptSimFillEvent } from './fill-adapter.js';
import {
  deriveLedgerPositionId,
  deriveLedgerTradeId,
} from './ledger-ids.js';
import {
  TradeLedgerInputError,
  type TradeLedgerIssue,
} from './trade-ledger-error.js';
import type {
  ClosedTrade,
  LedgerExecution,
  LedgerPositionSide,
  OpenLedgerPosition,
  TradeLedger,
  TradeLedgerOptions,
} from './types.js';

interface MutableLedgerPosition {
  readonly position_id: string;
  readonly run_id: string;
  readonly strategy_id: StrategyId | null;
  readonly instrument_id: number;
  readonly raw_symbol: string | null;
  readonly instrument_identity_source: LedgerExecution['instrument_identity_source'];
  readonly side: LedgerPositionSide;
  readonly opened_at_ns: UnixNs;
  readonly execution_ids: string[];
  entry_quantity: number;
  exit_quantity: number;
  entry_notional: number;
  exit_notional: number;
  quantity_open: number;
  updated_at_ns: UnixNs;
}

interface StrategyRecoveryState {
  readonly candidateStrategyByCandidateId: Map<string, StrategyId>;
  readonly orderCandidateByOrderIntentId: Map<string, string>;
  readonly orderCandidateByEventId: Map<string, string>;
}

export function buildTradeLedger(
  events: readonly AnyJournalEventEnvelope[],
  options: TradeLedgerOptions = {},
): TradeLedger {
  const recovery: StrategyRecoveryState = {
    candidateStrategyByCandidateId: new Map(),
    orderCandidateByOrderIntentId: new Map(),
    orderCandidateByEventId: new Map(),
  };
  const executions: LedgerExecution[] = [];
  const closedTrades: ClosedTrade[] = [];
  const openPositions = new Map<string, MutableLedgerPosition>();
  let runId = options.run_id ?? '';
  let positionSequence = 0;
  let closedTradeSequence = 0;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    rememberRecoveryContext(event, recovery);

    if (event.type !== 'SIM_FILL') {
      continue;
    }

    runId = updateRunId(runId, event, index);
    const strategyId = recoverStrategyId(event, recovery);
    const adapterContext = options.instrument_context === undefined
      ? { strategy_id: strategyId }
      : { instrument_context: options.instrument_context, strategy_id: strategyId };
    const execution = adaptSimFillEvent(
      event as JournalEventEnvelope<'SIM_FILL', JournalEventPayloadFor<'SIM_FILL'>>,
      adapterContext,
    );
    executions.push(execution);

    const reducerResult = applyExecutionToPositions({
      execution,
      openPositions,
      positionSequence,
      closedTradeSequence,
      closedTrades,
    });
    positionSequence = reducerResult.positionSequence;
    closedTradeSequence = reducerResult.closedTradeSequence;
  }

  return {
    run_id: runId,
    executions,
    closed_trades: closedTrades,
    open_positions: Array.from(openPositions.values())
      .map(toOpenLedgerPosition)
      .sort(compareOpenPositions),
  };
}

function rememberRecoveryContext(
  event: AnyJournalEventEnvelope,
  recovery: StrategyRecoveryState,
): void {
  if (event.type === 'CANDIDATE') {
    const payload = event.payload as JournalEventPayloadFor<'CANDIDATE'>;
    if (isStrategyId(payload.strategy_id)) {
      recovery.candidateStrategyByCandidateId.set(payload.candidate_id, payload.strategy_id);
    }
    return;
  }

  if (event.type === 'ORDER_INTENT') {
    const payload = event.payload as JournalEventPayloadFor<'ORDER_INTENT'>;
    recovery.orderCandidateByOrderIntentId.set(payload.order_intent_id, payload.candidate_id);
    recovery.orderCandidateByEventId.set(event.event_id, payload.candidate_id);
  }
}

function recoverStrategyId(
  event: AnyJournalEventEnvelope,
  recovery: StrategyRecoveryState,
): StrategyId | null {
  if (event.type !== 'SIM_FILL') {
    return null;
  }

  const payload = event.payload as JournalEventPayloadFor<'SIM_FILL'>;
  const candidateFromOrderIntent = recovery.orderCandidateByOrderIntentId.get(
    payload.order_intent_id,
  );
  if (candidateFromOrderIntent !== undefined) {
    return recovery.candidateStrategyByCandidateId.get(candidateFromOrderIntent) ?? null;
  }

  if (event.causation_id !== undefined) {
    const candidateFromCausation = recovery.orderCandidateByEventId.get(event.causation_id);
    if (candidateFromCausation !== undefined) {
      return recovery.candidateStrategyByCandidateId.get(candidateFromCausation) ?? null;
    }
  }

  return null;
}

function updateRunId(
  currentRunId: string,
  event: AnyJournalEventEnvelope,
  index: number,
): string {
  if (typeof event.run_id !== 'string' || event.run_id.trim() === '') {
    throw new TradeLedgerInputError([
      {
        path: `$.events[${index}].run_id`,
        code: 'malformed_fill',
        message: 'fill event run_id must be a non-empty string',
      },
    ]);
  }

  if (currentRunId === '') {
    return event.run_id;
  }

  if (currentRunId !== event.run_id) {
    throw new TradeLedgerInputError([
      {
        path: `$.events[${index}].run_id`,
        code: 'malformed_fill',
        message: 'trade ledger cannot mix run_id values',
      },
    ]);
  }

  return currentRunId;
}

function applyExecutionToPositions(input: {
  readonly execution: LedgerExecution;
  readonly openPositions: Map<string, MutableLedgerPosition>;
  readonly positionSequence: number;
  readonly closedTradeSequence: number;
  readonly closedTrades: ClosedTrade[];
}): {
  readonly positionSequence: number;
  readonly closedTradeSequence: number;
} {
  let remainingQuantity = input.execution.quantity;
  let positionSequence = input.positionSequence;
  let closedTradeSequence = input.closedTradeSequence;

  if (input.execution.side === 'buy') {
    const shortReduction = reduceOpenPosition({
      execution: input.execution,
      openPositions: input.openPositions,
      side: 'short',
      quantity: remainingQuantity,
      closedTradeSequence,
      closedTrades: input.closedTrades,
    });
    remainingQuantity = shortReduction.remainingQuantity;
    closedTradeSequence = shortReduction.closedTradeSequence;
    if (remainingQuantity > 0) {
      positionSequence = addToOpenPosition({
        execution: input.execution,
        openPositions: input.openPositions,
        side: 'long',
        quantity: remainingQuantity,
        positionSequence,
      });
    }
    return { positionSequence, closedTradeSequence };
  }

  const longReduction = reduceOpenPosition({
    execution: input.execution,
    openPositions: input.openPositions,
    side: 'long',
    quantity: remainingQuantity,
    closedTradeSequence,
    closedTrades: input.closedTrades,
  });
  remainingQuantity = longReduction.remainingQuantity;
  closedTradeSequence = longReduction.closedTradeSequence;
  if (remainingQuantity > 0) {
    positionSequence = addToOpenPosition({
      execution: input.execution,
      openPositions: input.openPositions,
      side: 'short',
      quantity: remainingQuantity,
      positionSequence,
    });
  }
  return { positionSequence, closedTradeSequence };
}

function addToOpenPosition(input: {
  readonly execution: LedgerExecution;
  readonly openPositions: Map<string, MutableLedgerPosition>;
  readonly side: LedgerPositionSide;
  readonly quantity: number;
  readonly positionSequence: number;
}): number {
  const key = positionKey(input.execution, input.side);
  const existing = input.openPositions.get(key);
  if (existing !== undefined) {
    existing.entry_quantity += input.quantity;
    existing.entry_notional += input.execution.price * input.quantity;
    existing.quantity_open += input.quantity;
    existing.updated_at_ns = input.execution.ts_ns;
    existing.execution_ids.push(input.execution.execution_id);
    return input.positionSequence;
  }

  const nextSequence = input.positionSequence + 1;
  input.openPositions.set(key, {
    position_id: deriveLedgerPositionId(
      input.execution.instrument_id,
      input.execution.strategy_id,
      nextSequence,
    ),
    run_id: input.execution.run_id,
    strategy_id: input.execution.strategy_id,
    instrument_id: input.execution.instrument_id,
    raw_symbol: input.execution.raw_symbol,
    instrument_identity_source: input.execution.instrument_identity_source,
    side: input.side,
    opened_at_ns: input.execution.ts_ns,
    updated_at_ns: input.execution.ts_ns,
    execution_ids: [input.execution.execution_id],
    entry_quantity: input.quantity,
    exit_quantity: 0,
    entry_notional: input.execution.price * input.quantity,
    exit_notional: 0,
    quantity_open: input.quantity,
  });
  return nextSequence;
}

function reduceOpenPosition(input: {
  readonly execution: LedgerExecution;
  readonly openPositions: Map<string, MutableLedgerPosition>;
  readonly side: LedgerPositionSide;
  readonly quantity: number;
  readonly closedTradeSequence: number;
  readonly closedTrades: ClosedTrade[];
}): {
  readonly remainingQuantity: number;
  readonly closedTradeSequence: number;
} {
  const key = positionKey(input.execution, input.side);
  const existing = input.openPositions.get(key);
  if (existing === undefined) {
    return {
      remainingQuantity: input.quantity,
      closedTradeSequence: input.closedTradeSequence,
    };
  }

  const reductionQuantity = Math.min(existing.quantity_open, input.quantity);
  existing.quantity_open -= reductionQuantity;
  existing.exit_quantity += reductionQuantity;
  existing.exit_notional += input.execution.price * reductionQuantity;
  existing.updated_at_ns = input.execution.ts_ns;
  existing.execution_ids.push(input.execution.execution_id);

  let closedTradeSequence = input.closedTradeSequence;
  if (existing.quantity_open === 0) {
    closedTradeSequence += 1;
    input.closedTrades.push(toClosedTrade(existing, closedTradeSequence));
    input.openPositions.delete(key);
  }

  return {
    remainingQuantity: input.quantity - reductionQuantity,
    closedTradeSequence,
  };
}

function toClosedTrade(
  position: MutableLedgerPosition,
  sequence: number,
): ClosedTrade {
  return {
    trade_id: deriveLedgerTradeId(position.run_id, sequence),
    run_id: position.run_id,
    strategy_id: position.strategy_id,
    instrument_id: position.instrument_id,
    raw_symbol: position.raw_symbol,
    instrument_identity_source: position.instrument_identity_source,
    opened_at_ns: position.opened_at_ns,
    closed_at_ns: position.updated_at_ns,
    side: position.side,
    entry_quantity: position.entry_quantity,
    exit_quantity: position.exit_quantity,
    average_entry_price: position.entry_notional / position.entry_quantity,
    average_exit_price: position.exit_notional / position.exit_quantity,
    realized_pnl: null,
    execution_ids: [...position.execution_ids],
  };
}

function toOpenLedgerPosition(position: MutableLedgerPosition): OpenLedgerPosition {
  return {
    position_id: position.position_id,
    run_id: position.run_id,
    strategy_id: position.strategy_id,
    instrument_id: position.instrument_id,
    raw_symbol: position.raw_symbol,
    instrument_identity_source: position.instrument_identity_source,
    side: position.side,
    quantity_open: position.quantity_open,
    entry_quantity: position.entry_quantity,
    average_entry_price: position.entry_notional / position.entry_quantity,
    opened_at_ns: position.opened_at_ns,
    updated_at_ns: position.updated_at_ns,
    execution_ids: [...position.execution_ids],
  };
}

function positionKey(execution: LedgerExecution, side: LedgerPositionSide): string {
  return [
    execution.run_id,
    execution.strategy_id ?? 'unknown_strategy',
    execution.instrument_id.toString(),
    side,
  ].join('|');
}

function compareOpenPositions(left: OpenLedgerPosition, right: OpenLedgerPosition): number {
  if (left.opened_at_ns < right.opened_at_ns) return -1;
  if (left.opened_at_ns > right.opened_at_ns) return 1;
  return left.position_id.localeCompare(right.position_id);
}

export function assertNoTradeLedgerIssues(issues: readonly TradeLedgerIssue[]): void {
  if (issues.length > 0) {
    throw new TradeLedgerInputError(issues);
  }
}
