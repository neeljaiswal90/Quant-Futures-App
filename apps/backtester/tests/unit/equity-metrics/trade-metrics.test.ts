import { describe, expect, it } from 'vitest';
import { ns } from '../../../../strategy_runtime/src/contracts/time.js';
import {
  analyzeTradeLedger,
  computeTradeMetrics,
  type EquityMetricsOptions,
} from '../../../src/equity-metrics/index.js';
import type {
  ClosedTrade,
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
});

function ledger(closedTrades: readonly ClosedTrade[]): TradeLedger {
  return {
    run_id: 'run',
    executions: [],
    closed_trades: closedTrades,
    open_positions: [],
  };
}

function trade(input: {
  readonly trade_id: string;
  readonly entry: number;
  readonly exit: number;
  readonly closed_at_ns?: bigint;
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
    side: 'long',
    entry_quantity: 1,
    exit_quantity: 1,
    average_entry_price: input.entry,
    average_exit_price: input.exit,
    realized_pnl: null,
    execution_ids: [],
  };
}
