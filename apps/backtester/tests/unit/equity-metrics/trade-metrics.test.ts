import { describe, expect, it } from 'vitest';
import { ns } from '../../../../strategy_runtime/src/contracts/time.js';
import {
  analyzeTradeLedger,
  computeTradePnl,
  computeTradeMetrics,
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

describe('QFA-204 trade metrics', () => {
  it('counts win, loss, and flat trades with fixed-scale win_rate_ppm', () => {
    const summary = computeTradeMetrics(ledger([
      trade({ trade_id: 'win', entry: 100, exit: 100.5 }),
      trade({ trade_id: 'loss', entry: 100.5, exit: 100 }),
      trade({ trade_id: 'flat', entry: 100, exit: 100 }),
    ]), OPTIONS);

    expect(summary).toMatchObject({
      total_trades: 3,
      winning_trades: 1,
      losing_trades: 1,
      flat_trades: 1,
      gross_profit_cents: 100n,
      gross_loss_cents: -100n,
      net_pnl_cents: 0n,
      win_rate_ppm: 333333,
      profit_factor_ppm: 1_000_000,
      final_equity_cents: 100_000n,
      peak_equity_cents: 100_000n,
      max_drawdown_cents: 100n,
    });
  });

  it('returns profit_factor_ppm null when there is no gross loss', () => {
    const summary = computeTradeMetrics(ledger([
      trade({ trade_id: 'win', entry: 100, exit: 100.5 }),
    ]), OPTIONS);

    expect(summary.profit_factor_ppm).toBeNull();
  });

  it('returns null averages and initial-equity summary for an empty ledger', () => {
    const summary = computeTradeMetrics(ledger([]), OPTIONS);

    expect(summary).toMatchObject({
      total_trades: 0,
      winning_trades: 0,
      losing_trades: 0,
      flat_trades: 0,
      gross_profit_cents: 0n,
      gross_loss_cents: 0n,
      net_pnl_cents: 0n,
      average_trade_pnl_cents: null,
      average_win_cents: null,
      average_loss_cents: null,
      win_rate_ppm: 0,
      profit_factor_ppm: null,
      max_drawdown_cents: 0n,
      final_equity_cents: 100_000n,
      peak_equity_cents: 100_000n,
    });
  });

  it('computes deterministic integer average metrics', () => {
    const summary = computeTradeMetrics(ledger([
      trade({ trade_id: 'win-a', entry: 100, exit: 100.5 }),
      trade({ trade_id: 'win-b', entry: 100, exit: 100.25 }),
      trade({ trade_id: 'loss', entry: 100.5, exit: 100 }),
    ]), OPTIONS);

    expect(summary.average_trade_pnl_cents).toBe(16n);
    expect(summary.average_win_cents).toBe(75n);
    expect(summary.average_loss_cents).toBe(-100n);
  });

  it('is replay-deterministic for identical ledger input', () => {
    const input = ledger([
      trade({ trade_id: 'trade-2', closed_at_ns: 2n, entry: 100, exit: 100.5 }),
      trade({ trade_id: 'trade-1', closed_at_ns: 1n, entry: 100.5, exit: 100 }),
    ]);

    expect(analyzeTradeLedger(input, OPTIONS)).toEqual(analyzeTradeLedger(input, OPTIONS));
  });

  it('MEPNL-1 preserves single-exit aggregate equivalence', () => {
    const closedTrade = trade({
      trade_id: 'single-exit-equivalence',
      entry: 100,
      exit: 100.5,
      quantity: 2,
    });

    const pnl = computeTradePnl(closedTrade, OPTIONS, executionsForTrade(closedTrade));

    expect(pnl.entry_tick_quantity).toBe(800n);
    expect(pnl.exit_tick_quantity).toBe(804n);
    expect(pnl.gross_pnl_cents).toBe(200n);
  });

  it('MEPNL-2 computes long multi-exit PnL when average exit is not tick-aligned', () => {
    const closedTrade = trade({
      trade_id: 'long-non-tick-average',
      entry: 100,
      exit: 100.375,
      quantity: 2,
      execution_ids: [
        'long-non-tick-average-entry',
        'long-non-tick-average-pt1',
        'long-non-tick-average-pt2',
      ],
    });

    const pnl = computeTradePnl(closedTrade, OPTIONS, [
      execution({
        execution_id: 'long-non-tick-average-entry',
        side: 'buy',
        price: 100,
        quantity: 2,
      }),
      execution({
        execution_id: 'long-non-tick-average-pt1',
        side: 'sell',
        price: 100.25,
        quantity: 1,
      }),
      execution({
        execution_id: 'long-non-tick-average-pt2',
        side: 'sell',
        price: 100.5,
        quantity: 1,
      }),
    ]);

    expect(pnl.entry_tick_quantity).toBe(800n);
    expect(pnl.exit_tick_quantity).toBe(803n);
    expect(pnl.gross_pnl_cents).toBe(150n);
  });

  it('MEPNL-3 preserves tick-aligned aggregate average behavior', () => {
    const closedTrade = trade({
      trade_id: 'long-tick-average',
      entry: 100,
      exit: 100.5,
      quantity: 2,
      execution_ids: ['long-tick-average-entry', 'long-tick-average-pt1', 'long-tick-average-pt2'],
    });

    const pnl = computeTradePnl(closedTrade, OPTIONS, [
      execution({
        execution_id: 'long-tick-average-entry',
        side: 'buy',
        price: 100,
        quantity: 2,
      }),
      execution({
        execution_id: 'long-tick-average-pt1',
        side: 'sell',
        price: 100.25,
        quantity: 1,
      }),
      execution({
        execution_id: 'long-tick-average-pt2',
        side: 'sell',
        price: 100.75,
        quantity: 1,
      }),
    ]);

    expect(pnl.entry_tick_quantity).toBe(800n);
    expect(pnl.exit_tick_quantity).toBe(804n);
    expect(pnl.gross_pnl_cents).toBe(200n);
  });

  it('MEPNL-4 computes short multi-exit PnL when average exit is not tick-aligned', () => {
    const closedTrade = trade({
      trade_id: 'short-non-tick-average',
      side: 'short',
      entry: 100,
      exit: 99.625,
      quantity: 2,
      execution_ids: [
        'short-non-tick-average-entry',
        'short-non-tick-average-pt1',
        'short-non-tick-average-pt2',
      ],
    });

    const pnl = computeTradePnl(closedTrade, OPTIONS, [
      execution({
        execution_id: 'short-non-tick-average-entry',
        side: 'sell',
        price: 100,
        quantity: 2,
      }),
      execution({
        execution_id: 'short-non-tick-average-pt1',
        side: 'buy',
        price: 99.75,
        quantity: 1,
      }),
      execution({
        execution_id: 'short-non-tick-average-pt2',
        side: 'buy',
        price: 99.5,
        quantity: 1,
      }),
    ]);

    expect(pnl.entry_tick_quantity).toBe(800n);
    expect(pnl.exit_tick_quantity).toBe(797n);
    expect(pnl.gross_pnl_cents).toBe(150n);
  });

  it('MEPNL-5 handles asymmetric exit quantities by summing execution tick quantities', () => {
    const closedTrade = trade({
      trade_id: 'long-asymmetric-exits',
      entry: 100,
      exit: (100.25 * 2 + 100.75) / 3,
      quantity: 3,
      execution_ids: ['long-asymmetric-exits-entry', 'long-asymmetric-exits-pt1', 'long-asymmetric-exits-pt2'],
    });

    const pnl = computeTradePnl(closedTrade, OPTIONS, [
      execution({
        execution_id: 'long-asymmetric-exits-entry',
        side: 'buy',
        price: 100,
        quantity: 3,
      }),
      execution({
        execution_id: 'long-asymmetric-exits-pt1',
        side: 'sell',
        price: 100.25,
        quantity: 2,
      }),
      execution({
        execution_id: 'long-asymmetric-exits-pt2',
        side: 'sell',
        price: 100.75,
        quantity: 1,
      }),
    ]);

    expect(pnl.entry_tick_quantity).toBe(1200n);
    expect(pnl.exit_tick_quantity).toBe(1205n);
    expect(pnl.gross_pnl_cents).toBe(250n);
  });

  it('MEPNL-6 still rejects raw execution prices that are not tick-aligned', () => {
    const closedTrade = trade({
      trade_id: 'bad-component-price',
      entry: 100,
      exit: 100.5,
      execution_ids: ['bad-component-price-entry', 'bad-component-price-exit'],
    });

    expect(() =>
      computeTradePnl(closedTrade, OPTIONS, [
        execution({
          execution_id: 'bad-component-price-entry',
          side: 'buy',
          price: 100,
          quantity: 1,
        }),
        execution({
          execution_id: 'bad-component-price-exit',
          side: 'sell',
          price: 100.125,
          quantity: 1,
        }),
      ]),
    ).toThrow('price_not_tick_aligned');
  });
});

function ledger(
  closedTrades: readonly ClosedTrade[],
  executions: readonly LedgerExecution[] = closedTrades.flatMap((closedTrade) =>
    executionsForTrade(closedTrade),
  ),
): TradeLedger {
  return {
    run_id: 'run',
    executions,
    closed_trades: closedTrades,
    open_positions: [],
  };
}

function trade(input: {
  readonly trade_id: string;
  readonly side?: 'long' | 'short';
  readonly entry: number;
  readonly exit: number;
  readonly quantity?: number;
  readonly closed_at_ns?: bigint;
  readonly execution_ids?: readonly string[];
}): ClosedTrade {
  return {
    trade_id: input.trade_id,
    run_id: 'run',
    strategy_id: null,
    instrument_id: 1,
    raw_symbol: 'MNQH6',
    instrument_identity_source: 'ledger_options',
    opened_at_ns: ns(0n),
    closed_at_ns: ns(input.closed_at_ns ?? 1n),
    side: input.side ?? 'long',
    entry_quantity: input.quantity ?? 1,
    exit_quantity: input.quantity ?? 1,
    average_entry_price: input.entry,
    average_exit_price: input.exit,
    realized_pnl: null,
    execution_ids: input.execution_ids ?? [
      `${input.trade_id}-entry`,
      `${input.trade_id}-exit`,
    ],
  };
}

function executionsForTrade(trade: ClosedTrade): readonly LedgerExecution[] {
  const entrySide = trade.side === 'long' ? 'buy' : 'sell';
  const exitSide = trade.side === 'long' ? 'sell' : 'buy';
  const entryExecutionId = trade.execution_ids[0];
  const exitExecutionId = trade.execution_ids[1];
  if (entryExecutionId === undefined || exitExecutionId === undefined) {
    throw new Error('test trade must declare entry and exit execution ids');
  }
  return [
    execution({
      execution_id: entryExecutionId,
      side: entrySide,
      price: trade.average_entry_price,
      quantity: trade.entry_quantity,
    }),
    execution({
      execution_id: exitExecutionId,
      side: exitSide,
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
