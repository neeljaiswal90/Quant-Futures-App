import { describe, expect, it } from 'vitest';
import { ns } from '../../../../strategy_runtime/src/contracts/time.js';
import {
  computeTradePnl,
  type EquityMetricsOptions,
} from '../../../src/equity-metrics/index.js';
import type {
  ClosedTrade,
  LedgerExecution,
} from '../../../src/trade-ledger/index.js';

const OPTIONS: EquityMetricsOptions = {
  initial_equity_cents: 100_000n,
  valuation: {
    instrument_root: 'MNQ',
    tick_size: '0.25',
    tick_value_usd_cents: 50n,
  },
};

describe('QFA-204 trade PnL', () => {
  it('computes positive long PnL when exit is above entry', () => {
    expect(
      computeTradePnl(trade({ side: 'long', entry: 100, exit: 100.5, quantity: 2 }), OPTIONS)
        .gross_pnl_cents,
    ).toBe(200n);
  });

  it('computes negative long PnL when exit is below entry', () => {
    expect(
      computeTradePnl(trade({ side: 'long', entry: 100.5, exit: 100, quantity: 2 }), OPTIONS)
        .gross_pnl_cents,
    ).toBe(-200n);
  });

  it('computes positive short PnL when exit is below entry', () => {
    expect(
      computeTradePnl(trade({ side: 'short', entry: 100.5, exit: 100, quantity: 2 }), OPTIONS)
        .gross_pnl_cents,
    ).toBe(200n);
  });

  it('computes negative short PnL when exit is above entry', () => {
    expect(
      computeTradePnl(trade({ side: 'short', entry: 100, exit: 100.5, quantity: 2 }), OPTIONS)
        .gross_pnl_cents,
    ).toBe(-200n);
  });

  it('subtracts exact fee and commission cents from net PnL', () => {
    const result = computeTradePnl(
      trade({ side: 'long', entry: 100, exit: 100.5, quantity: 2 }),
      OPTIONS,
      [
        execution({
          execution_id: 'execution-fill-1',
          exchange_fee_usd: 1.25,
          commission_usd: 0.75,
        }),
        execution({
          execution_id: 'execution-fill-2',
          exchange_fee_usd: 1,
          commission_usd: 1,
        }),
      ],
    );

    expect(result.gross_pnl_cents).toBe(200n);
    expect(result.fees_cents).toBe(225n);
    expect(result.commissions_cents).toBe(175n);
    expect(result.net_pnl_cents).toBe(-200n);
  });

  it('rejects missing closed-trade prices and invalid quantity', () => {
    expect(() =>
      computeTradePnl(trade({ side: 'long', entry: Number.NaN, exit: 100.5, quantity: 2 }), OPTIONS),
    ).toThrow('missing_closed_trade_price');

    expect(() =>
      computeTradePnl(trade({ side: 'long', entry: 100, exit: 100.5, quantity: 1.5 }), OPTIONS),
    ).toThrow('invalid_quantity');
  });
});

function trade(input: {
  readonly side: 'long' | 'short';
  readonly entry: number;
  readonly exit: number;
  readonly quantity: number;
}): ClosedTrade {
  return {
    trade_id: 'trade-run-1',
    run_id: 'run',
    strategy_id: null,
    instrument_id: 1,
    raw_symbol: 'MNQH6',
    instrument_identity_source: 'ledger_options',
    opened_at_ns: ns(1n),
    closed_at_ns: ns(2n),
    side: input.side,
    entry_quantity: input.quantity,
    exit_quantity: input.quantity,
    average_entry_price: input.entry,
    average_exit_price: input.exit,
    realized_pnl: null,
    execution_ids: ['execution-fill-1', 'execution-fill-2'],
  };
}

function execution(input: {
  readonly execution_id: string;
  readonly exchange_fee_usd?: number;
  readonly commission_usd?: number;
}): LedgerExecution {
  return {
    execution_id: input.execution_id,
    run_id: 'run',
    event_id: input.execution_id.replace('execution-', ''),
    ts_ns: ns(1n),
    strategy_id: null,
    instrument_id: 1,
    raw_symbol: 'MNQH6',
    instrument_identity_source: 'ledger_options',
    side: 'buy',
    price: 100,
    quantity: 1,
    ...(input.exchange_fee_usd === undefined ? {} : { exchange_fee_usd: input.exchange_fee_usd }),
    ...(input.commission_usd === undefined ? {} : { commission_usd: input.commission_usd }),
    source_event_type: 'SIM_FILL',
    source_event_id: input.execution_id.replace('execution-', ''),
    fill_id: input.execution_id,
    order_intent_id: 'order-1',
  };
}
