import { describe, expect, it } from 'vitest';
import {
  createJournalEventEnvelope,
  type JournalEventEnvelope,
  type SimFillEventPayload,
} from '../../../../strategy_runtime/src/contracts/events/index.js';
import {
  makeEventId,
  makeFillId,
  makeOrderIntentId,
  makeRunId,
  makeSessionId,
} from '../../../../strategy_runtime/src/contracts/ids.js';
import { ns } from '../../../../strategy_runtime/src/contracts/time.js';
import {
  adaptSimFillEvent,
  TradeLedgerInputError,
} from '../../../src/trade-ledger/index.js';

describe('QFA-203 SIM_FILL adapter', () => {
  it('maps SIM_FILL to LedgerExecution with ledger-supplied instrument context', () => {
    const execution = adaptSimFillEvent(simFillEvent(), {
      instrument_context: { instrument_id: 42, raw_symbol: 'MNQH6' },
      strategy_id: 'breakout_retest_long',
    });

    expect(execution).toMatchObject({
      execution_id: 'execution-sim-fill-fill-1',
      run_id: 'run-ledger',
      event_id: 'sim-fill-fill-1',
      strategy_id: 'breakout_retest_long',
      instrument_id: 42,
      raw_symbol: 'MNQH6',
      instrument_identity_source: 'ledger_options',
      side: 'buy',
      price: 100,
      quantity: 2,
      source_event_type: 'SIM_FILL',
      source_event_id: 'sim-fill-fill-1',
      fill_id: 'fill-1',
      order_intent_id: 'order-1',
    });
  });

  it('fails closed when SIM_FILL lacks instrument identity and options context is absent', () => {
    expect(() => adaptSimFillEvent(simFillEvent())).toThrow(TradeLedgerInputError);
    expect(() => adaptSimFillEvent(simFillEvent())).toThrow('missing_instrument_identity');
  });

  it('rejects invalid instrument_context.instrument_id', () => {
    expect(() =>
      adaptSimFillEvent(simFillEvent(), {
        instrument_context: { instrument_id: 0, raw_symbol: 'MNQH6' },
      }),
    ).toThrow('missing_instrument_identity');
  });

  it('rejects empty raw_symbol in instrument_context', () => {
    expect(() =>
      adaptSimFillEvent(simFillEvent(), {
        instrument_context: { instrument_id: 42, raw_symbol: '' },
      }),
    ).toThrow('raw_symbol must not be empty');
  });

  it('fails closed when future event identity conflicts with ledger options', () => {
    const eventWithIdentity = {
      ...simFillEvent(),
      payload: {
        ...simFillEvent().payload,
        instrument_id: 43,
        raw_symbol: 'MNQM6',
      },
    } as JournalEventEnvelope<'SIM_FILL', SimFillEventPayload>;

    expect(() =>
      adaptSimFillEvent(eventWithIdentity, {
        instrument_context: { instrument_id: 42, raw_symbol: 'MNQH6' },
      }),
    ).toThrow('instrument_identity_mismatch');
  });

  it('rejects malformed fill price, quantity, and side fields', () => {
    expect(() =>
      adaptSimFillEvent(simFillEvent({ price: undefined as unknown as number }), {
        instrument_context: { instrument_id: 42, raw_symbol: null },
      }),
    ).toThrow('missing_price');

    expect(() =>
      adaptSimFillEvent(simFillEvent({ quantity: 0 }), {
        instrument_context: { instrument_id: 42, raw_symbol: null },
      }),
    ).toThrow('missing_quantity');

    expect(() =>
      adaptSimFillEvent(simFillEvent({ side: 'hold' as SimFillEventPayload['side'] }), {
        instrument_context: { instrument_id: 42, raw_symbol: null },
      }),
    ).toThrow('invalid_side');
  });
});

function simFillEvent(
  payload: Partial<SimFillEventPayload> = {},
): JournalEventEnvelope<'SIM_FILL', SimFillEventPayload> {
  return createJournalEventEnvelope({
    event_id: makeEventId('sim-fill-fill-1'),
    type: 'SIM_FILL',
    ts_ns: ns(10n),
    run_id: makeRunId('run-ledger'),
    session_id: makeSessionId('session-ledger'),
    payload: {
      fill_id: makeFillId('fill-1'),
      order_intent_id: makeOrderIntentId('order-1'),
      side: 'buy',
      quantity: 2,
      price: 100,
      liquidity: 'taker',
      ...payload,
    },
  });
}
