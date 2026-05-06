import type { TradeLedger } from '../trade-ledger/index.js';
import {
  computeTradePnls,
} from './pnl.js';
import {
  validateEquityMetricsOptions,
} from './price-units.js';
import type {
  EquityCurvePoint,
  EquityMetricsOptions,
  TradePnl,
} from './types.js';

export function buildEquityCurve(
  ledger: TradeLedger,
  options: EquityMetricsOptions,
): readonly EquityCurvePoint[] {
  validateEquityMetricsOptions(options);
  return buildEquityCurveFromTradePnl(computeTradePnls(ledger, options), options);
}

export function buildEquityCurveFromTradePnl(
  tradePnl: readonly TradePnl[],
  options: EquityMetricsOptions,
): readonly EquityCurvePoint[] {
  validateEquityMetricsOptions(options);
  let equity = options.initial_equity_cents;
  let peak = options.initial_equity_cents;

  return tradePnl.map((pnl, index) => {
    equity += pnl.net_pnl_cents;
    if (equity > peak) {
      peak = equity;
    }
    return {
      sequence: index + 1,
      ts_ns: pnl.closed_at_ns,
      trade_id: pnl.trade_id,
      realized_pnl_cents: pnl.net_pnl_cents,
      equity_cents: equity,
      peak_equity_cents: peak,
      drawdown_cents: peak - equity,
    };
  });
}
