import { describe, expect, it } from 'vitest';
import { ns } from '../../../../strategy_runtime/src/contracts/time.js';
import {
  buildEquityCurve,
  type EquityMetricsOptions,
} from '../../../src/equity-metrics/index.js';
import type {
  ClosedTrade,
  LedgerExecution,
  TradeLedger,
} from '../../../src/trade-ledger/index.js';

const OPTIONS: EquityMetricsOptions = {
  initial_equity_cents: 100_000n,
  valuation: {
    instrument_root: 'MNQ',
    tick_size: '0.25',
    tick_value_usd_cents: 50n,
  },
};

describe('QFA-204 equity curve', () => {
  it('starts from caller-supplied initial equity and updates after each closed trade', () => {
    const curve = buildEquityCurve(ledger([
      trade({ trade_id: 'trade-1', closed_at_ns: 2n, entry: 100, exit: 100.5 }),
      trade({ trade_id: 'trade-2', closed_at_ns: 3n, entry: 100.5, exit: 100 }),
    ]), OPTIONS);

    expect(curve).toMatchObject([
      {
        sequence: 1,
        trade_id: 'trade-1',
        realized_pnl_cents: 100n,
        equity_cents: 100_100n,
        peak_equity_cents: 100_100n,
        drawdown_cents: 0n,
      },
      {
        sequence: 2,
        trade_id: 'trade-2',
        realized_pnl_cents: -100n,
        equity_cents: 100_000n,
        peak_equity_cents: 100_100n,
        drawdown_cents: 100n,
      },
    ]);
  });

  it('sorts closed trades by closed_at_ns then trade_id', () => {
    const curve = buildEquityCurve(ledger([
      trade({ trade_id: 'trade-b', closed_at_ns: 2n, entry: 100, exit: 100.25 }),
      trade({ trade_id: 'trade-a', closed_at_ns: 2n, entry: 100, exit: 100.5 }),
      trade({ trade_id: 'trade-c', closed_at_ns: 1n, entry: 100, exit: 100.75 }),
    ]), OPTIONS);

    expect(curve.map((point) => point.trade_id)).toEqual(['trade-c', 'trade-a', 'trade-b']);
  });

  it('computes max drawdown deterministically through the curve points', () => {
    const curve = buildEquityCurve(ledger([
      trade({ trade_id: 'trade-1', closed_at_ns: 1n, entry: 100, exit: 101 }),
      trade({ trade_id: 'trade-2', closed_at_ns: 2n, entry: 101, exit: 100 }),
      trade({ trade_id: 'trade-3', closed_at_ns: 3n, entry: 100, exit: 100.25 }),
    ]), OPTIONS);

    expect(curve.map((point) => point.drawdown_cents)).toEqual([0n, 200n, 150n]);
  });
});

function ledger(closedTrades: readonly ClosedTrade[]): TradeLedger {
  return {
    run_id: 'run',
    executions: closedTrades.flatMap((closedTrade) => executionsForTrade(closedTrade)),
    closed_trades: closedTrades,
    open_positions: [],
  };
}

function trade(input: {
  readonly trade_id: string;
  readonly closed_at_ns: bigint;
  readonly entry: number;
  readonly exit: number;
}): ClosedTrade {
  return {
    trade_id: input.trade_id,
    run_id: 'run',
    strategy_id: null,
    instrument_id: 1,
    raw_symbol: 'MNQH6',
    instrument_identity_source: 'ledger_options',
    opened_at_ns: ns(0n),
    closed_at_ns: ns(input.closed_at_ns),
    side: 'long',
    entry_quantity: 1,
    exit_quantity: 1,
    average_entry_price: input.entry,
    average_exit_price: input.exit,
    realized_pnl: null,
    execution_ids: [`${input.trade_id}-entry`, `${input.trade_id}-exit`],
  };
}

function executionsForTrade(trade: ClosedTrade): readonly LedgerExecution[] {
  const entryExecutionId = trade.execution_ids[0];
  const exitExecutionId = trade.execution_ids[1];
  if (entryExecutionId === undefined || exitExecutionId === undefined) {
    throw new Error('test trade must declare entry and exit execution ids');
  }
  return [
    execution({
      execution_id: entryExecutionId,
      side: 'buy',
      price: trade.average_entry_price,
      quantity: trade.entry_quantity,
    }),
    execution({
      execution_id: exitExecutionId,
      side: 'sell',
      price: trade.average_exit_price,
      quantity: trade.exit_quantity,
    }),
  ];
}

function execution(input: {
  readonly execution_id: string;
  readonly side: 'buy' | 'sell';
  readonly price: number;
  readonly quantity: number;
}): LedgerExecution {
  return {
    execution_id: input.execution_id,
    run_id: 'run',
    event_id: input.execution_id,
    ts_ns: ns(1n),
    strategy_id: null,
    instrument_id: 1,
    raw_symbol: 'MNQH6',
    instrument_identity_source: 'ledger_options',
    side: input.side,
    price: input.price,
    quantity: input.quantity,
    source_event_type: 'SIM_FILL',
    source_event_id: input.execution_id,
    fill_id: input.execution_id,
    order_intent_id: input.execution_id,
  };
}
