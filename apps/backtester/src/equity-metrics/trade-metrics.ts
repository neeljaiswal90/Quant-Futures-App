import type { TradeLedger } from '../trade-ledger/index.js';
import {
  buildEquityCurveFromTradePnl,
} from './equity-curve.js';
import {
  computeTradePnls,
} from './pnl.js';
import {
  validateEquityMetricsOptions,
} from './price-units.js';
import type {
  EquityMetricsOptions,
  TradeLedgerAnalysis,
  TradeMetricsSummary,
  TradePnl,
} from './types.js';

const PPM = 1_000_000n;

export function computeTradeMetrics(
  ledger: TradeLedger,
  options: EquityMetricsOptions,
): TradeMetricsSummary {
  validateEquityMetricsOptions(options);
  const tradePnl = computeTradePnls(ledger, options);
  const equityCurve = buildEquityCurveFromTradePnl(tradePnl, options);
  return summarizeTradePnl(tradePnl, equityCurve, options);
}

export function analyzeTradeLedger(
  ledger: TradeLedger,
  options: EquityMetricsOptions,
): TradeLedgerAnalysis {
  validateEquityMetricsOptions(options);
  const tradePnl = computeTradePnls(ledger, options);
  const equityCurve = buildEquityCurveFromTradePnl(tradePnl, options);
  return {
    trade_pnl: tradePnl,
    equity_curve: equityCurve,
    summary: summarizeTradePnl(tradePnl, equityCurve, options),
  };
}

function summarizeTradePnl(
  tradePnl: readonly TradePnl[],
  equityCurve: readonly {
    readonly drawdown_cents: bigint;
    readonly equity_cents: bigint;
    readonly peak_equity_cents: bigint;
  }[],
  options: EquityMetricsOptions,
): TradeMetricsSummary {
  const totalTrades = tradePnl.length;
  const winningTrades = tradePnl.filter((pnl) => pnl.net_pnl_cents > 0n);
  const losingTrades = tradePnl.filter((pnl) => pnl.net_pnl_cents < 0n);
  const flatTrades = totalTrades - winningTrades.length - losingTrades.length;
  const grossProfit = sumBigint(winningTrades.map((pnl) => pnl.net_pnl_cents));
  const grossLoss = sumBigint(losingTrades.map((pnl) => pnl.net_pnl_cents));
  const netPnl = sumBigint(tradePnl.map((pnl) => pnl.net_pnl_cents));
  const lastCurvePoint = equityCurve[equityCurve.length - 1];

  return {
    total_trades: totalTrades,
    winning_trades: winningTrades.length,
    losing_trades: losingTrades.length,
    flat_trades: flatTrades,
    gross_profit_cents: grossProfit,
    gross_loss_cents: grossLoss,
    net_pnl_cents: netPnl,
    average_trade_pnl_cents: totalTrades === 0 ? null : netPnl / BigInt(totalTrades),
    average_win_cents: winningTrades.length === 0
      ? null
      : grossProfit / BigInt(winningTrades.length),
    average_loss_cents: losingTrades.length === 0
      ? null
      : grossLoss / BigInt(losingTrades.length),
    win_rate_ppm: totalTrades === 0
      ? 0
      : bigintToSafeNumber((BigInt(winningTrades.length) * PPM) / BigInt(totalTrades)),
    profit_factor_ppm: grossLoss === 0n
      ? null
      : bigintToSafeNumber((grossProfit * PPM) / absBigint(grossLoss)),
    max_drawdown_cents: maxBigint(equityCurve.map((point) => point.drawdown_cents)),
    final_equity_cents: lastCurvePoint?.equity_cents ?? options.initial_equity_cents,
    peak_equity_cents:
      lastCurvePoint?.peak_equity_cents ?? options.initial_equity_cents,
  };
}

function sumBigint(values: readonly bigint[]): bigint {
  return values.reduce((sum, value) => sum + value, 0n);
}

function maxBigint(values: readonly bigint[]): bigint {
  return values.reduce((max, value) => (value > max ? value : max), 0n);
}

function absBigint(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function bigintToSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('ratio ppm exceeds Number.MAX_SAFE_INTEGER');
  }
  return Number(value);
}
