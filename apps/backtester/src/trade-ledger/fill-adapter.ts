import type {
  JournalEventEnvelope,
  SimFillEventPayload,
} from '../../../strategy_runtime/src/contracts/events/index.js';
import type { StrategyId } from '../../../strategy_runtime/src/contracts/strategy-ids.js';
import {
  deriveLedgerExecutionId,
} from './ledger-ids.js';
import {
  TradeLedgerInputError,
  type TradeLedgerIssue,
} from './trade-ledger-error.js';
import type {
  InstrumentIdentitySource,
  LedgerExecution,
  LedgerExecutionSide,
  TradeLedgerInstrumentContext,
} from './types.js';

export interface FillAdapterContext {
  readonly instrument_context?: TradeLedgerInstrumentContext;
  readonly strategy_id?: StrategyId | null;
}

interface ResolvedInstrumentIdentity {
  readonly instrument_id: number;
  readonly raw_symbol: string | null;
  readonly instrument_identity_source: InstrumentIdentitySource;
}

export function adaptSimFillEvent(
  event: JournalEventEnvelope<'SIM_FILL', SimFillEventPayload>,
  context: FillAdapterContext = {},
): LedgerExecution {
  const issues: TradeLedgerIssue[] = [];
  const payload = event.payload;

  const side = validateSide(payload.side, '$.payload.side', issues);
  const price = validatePositiveNumber(payload.price, '$.payload.price', 'missing_price', issues);
  const quantity = validatePositiveNumber(
    payload.quantity,
    '$.payload.quantity',
    'missing_quantity',
    issues,
  );
  validateNonEmptyString(event.run_id, '$.run_id', 'malformed_fill', issues);
  validateNonEmptyString(event.event_id, '$.event_id', 'malformed_fill', issues);
  validateNonEmptyString(payload.fill_id, '$.payload.fill_id', 'malformed_fill', issues);
  validateNonEmptyString(
    payload.order_intent_id,
    '$.payload.order_intent_id',
    'malformed_fill',
    issues,
  );

  const identity = resolveInstrumentIdentity(payload, context.instrument_context, issues);

  if (issues.length > 0) {
    throw new TradeLedgerInputError(issues);
  }

  const executionBase = {
    execution_id: deriveLedgerExecutionId(event.event_id),
    run_id: event.run_id,
    event_id: event.event_id,
    ts_ns: event.ts_ns,
    strategy_id: context.strategy_id ?? null,
    instrument_id: identity.instrument_id,
    raw_symbol: identity.raw_symbol,
    instrument_identity_source: identity.instrument_identity_source,
    side: side!,
    price: price!,
    quantity: quantity!,
    source_event_type: 'SIM_FILL' as const,
    source_event_id: event.event_id,
    fill_id: payload.fill_id,
    order_intent_id: payload.order_intent_id,
  };

  return {
    ...executionBase,
    ...(payload.exchange_fee_usd === undefined
      ? {}
      : { exchange_fee_usd: payload.exchange_fee_usd }),
    ...(payload.commission_usd === undefined
      ? {}
      : { commission_usd: payload.commission_usd }),
  };
}

function resolveInstrumentIdentity(
  payload: SimFillEventPayload,
  optionsIdentity: TradeLedgerInstrumentContext | undefined,
  issues: TradeLedgerIssue[],
): ResolvedInstrumentIdentity {
  const payloadRecord = payload as unknown as Record<string, unknown>;
  const eventInstrumentId = payloadRecord.instrument_id;
  const eventRawSymbol = payloadRecord.raw_symbol;
  const hasEventIdentity = eventInstrumentId !== undefined || eventRawSymbol !== undefined;
  const validatedOptionsIdentity = validateOptionsInstrumentContext(optionsIdentity, issues);

  if (hasEventIdentity) {
    const fillIdentity = validateEventInstrumentIdentity(
      eventInstrumentId,
      eventRawSymbol,
      issues,
    );
    if (fillIdentity !== undefined && validatedOptionsIdentity !== undefined) {
      const rawSymbolMismatch =
        fillIdentity.raw_symbol !== null &&
        validatedOptionsIdentity.raw_symbol !== null &&
        fillIdentity.raw_symbol !== validatedOptionsIdentity.raw_symbol;
      if (
        fillIdentity.instrument_id !== validatedOptionsIdentity.instrument_id ||
        rawSymbolMismatch
      ) {
        issues.push({
          path: '$.payload.instrument_id',
          code: 'instrument_identity_mismatch',
          message: 'fill event instrument identity conflicts with ledger options',
        });
      }
    }
    return {
      instrument_id: fillIdentity?.instrument_id ?? 0,
      raw_symbol: fillIdentity?.raw_symbol ?? null,
      instrument_identity_source: 'fill_event',
    };
  }

  if (validatedOptionsIdentity !== undefined) {
    return {
      ...validatedOptionsIdentity,
      instrument_identity_source: 'ledger_options',
    };
  }

  issues.push({
    path: '$.instrument_context',
    code: 'missing_instrument_identity',
    message: 'SIM_FILL does not carry instrument identity and no ledger instrument_context was supplied',
  });
  return {
    instrument_id: 0,
    raw_symbol: null,
    instrument_identity_source: 'ledger_options',
  };
}

function validateOptionsInstrumentContext(
  context: TradeLedgerInstrumentContext | undefined,
  issues: TradeLedgerIssue[],
): TradeLedgerInstrumentContext | undefined {
  if (context === undefined) {
    return undefined;
  }

  const instrumentIdValid = validateInstrumentId(
    context.instrument_id,
    '$.instrument_context.instrument_id',
    issues,
  );
  const rawSymbolValid = validateRawSymbol(
    context.raw_symbol,
    '$.instrument_context.raw_symbol',
    issues,
  );

  if (!instrumentIdValid || !rawSymbolValid) {
    return undefined;
  }

  return context;
}

function validateEventInstrumentIdentity(
  instrumentId: unknown,
  rawSymbol: unknown,
  issues: TradeLedgerIssue[],
): TradeLedgerInstrumentContext | undefined {
  const instrumentIdValid = validateInstrumentId(
    instrumentId,
    '$.payload.instrument_id',
    issues,
  );
  const rawSymbolValue = rawSymbol === undefined ? null : rawSymbol;
  const rawSymbolValid = validateRawSymbol(rawSymbolValue, '$.payload.raw_symbol', issues);

  if (!instrumentIdValid || !rawSymbolValid) {
    return undefined;
  }

  return {
    instrument_id: instrumentId as number,
    raw_symbol: rawSymbolValue as string | null,
  };
}

function validateInstrumentId(
  value: unknown,
  path: string,
  issues: TradeLedgerIssue[],
): boolean {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    issues.push({
      path,
      code: 'missing_instrument_identity',
      message: 'instrument_id must be a positive safe integer',
    });
    return false;
  }
  return true;
}

function validateRawSymbol(
  value: unknown,
  path: string,
  issues: TradeLedgerIssue[],
): boolean {
  if (value !== null && typeof value !== 'string') {
    issues.push({
      path,
      code: 'missing_instrument_identity',
      message: 'raw_symbol must be string or null',
    });
    return false;
  }
  if (typeof value === 'string' && value.trim() === '') {
    issues.push({
      path,
      code: 'missing_instrument_identity',
      message: 'raw_symbol must not be empty',
    });
    return false;
  }
  return true;
}

function validateSide(
  value: unknown,
  path: string,
  issues: TradeLedgerIssue[],
): LedgerExecutionSide | undefined {
  if (value !== 'buy' && value !== 'sell') {
    issues.push({
      path,
      code: 'invalid_side',
      message: 'SIM_FILL side must be buy or sell',
    });
    return undefined;
  }
  return value;
}

function validatePositiveNumber(
  value: unknown,
  path: string,
  code: 'missing_price' | 'missing_quantity',
  issues: TradeLedgerIssue[],
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    issues.push({
      path,
      code,
      message: `${path} must be a positive finite number`,
    });
    return undefined;
  }
  return value;
}

function validateNonEmptyString(
  value: unknown,
  path: string,
  code: 'malformed_fill',
  issues: TradeLedgerIssue[],
): void {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({
      path,
      code,
      message: `${path} must be a non-empty string`,
    });
  }
}
