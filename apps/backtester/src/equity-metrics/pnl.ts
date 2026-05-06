import type {
  ClosedTrade,
  LedgerExecution,
} from '../trade-ledger/index.js';
import {
  throwEquityMetricsIssue,
} from './equity-metrics-error.js';
import {
  priceToTicks,
  usdNumberToCents,
  validateEquityMetricsOptions,
} from './price-units.js';
import type {
  EquityMetricsOptions,
  TradePnl,
} from './types.js';

export function computeTradePnl(
  trade: ClosedTrade,
  options: EquityMetricsOptions,
  executions: readonly LedgerExecution[] = [],
): TradePnl {
  validateEquityMetricsOptions(options);
  validateClosedTrade(trade);

  const quantity = quantityToBigint(trade.exit_quantity);
  const entryTicks = priceToTicks(trade.average_entry_price, options.valuation.tick_size);
  const exitTicks = priceToTicks(trade.average_exit_price, options.valuation.tick_size);
  const tickDelta = trade.side === 'long'
    ? exitTicks - entryTicks
    : entryTicks - exitTicks;
  const grossPnlCents = tickDelta * options.valuation.tick_value_usd_cents * quantity;
  const costs = sumExecutionCosts(trade, executions);

  return {
    trade_id: trade.trade_id,
    run_id: trade.run_id,
    closed_at_ns: trade.closed_at_ns,
    side: trade.side,
    quantity,
    entry_ticks: entryTicks,
    exit_ticks: exitTicks,
    gross_pnl_cents: grossPnlCents,
    fees_cents: costs.fees_cents,
    commissions_cents: costs.commissions_cents,
    net_pnl_cents: grossPnlCents - costs.fees_cents - costs.commissions_cents,
  };
}

export function computeTradePnls(
  ledger: {
    readonly closed_trades: readonly ClosedTrade[];
    readonly executions: readonly LedgerExecution[];
  },
  options: EquityMetricsOptions,
): readonly TradePnl[] {
  return sortClosedTrades(ledger.closed_trades).map((trade) =>
    computeTradePnl(trade, options, ledger.executions),
  );
}

export function sortClosedTrades(
  trades: readonly ClosedTrade[],
): readonly ClosedTrade[] {
  return [...trades].sort((left, right) => {
    if (left.closed_at_ns < right.closed_at_ns) return -1;
    if (left.closed_at_ns > right.closed_at_ns) return 1;
    return left.trade_id.localeCompare(right.trade_id);
  });
}

function validateClosedTrade(trade: ClosedTrade): void {
  if (trade.side !== 'long' && trade.side !== 'short') {
    throwEquityMetricsIssue({
      path: '$.trade.side',
      code: 'unsupported_trade_side',
      message: 'trade side must be long or short',
    });
  }
  validatePrice(trade.average_entry_price, '$.trade.average_entry_price');
  validatePrice(trade.average_exit_price, '$.trade.average_exit_price');
  if (
    !Number.isSafeInteger(trade.entry_quantity) ||
    !Number.isSafeInteger(trade.exit_quantity) ||
    trade.entry_quantity <= 0 ||
    trade.exit_quantity <= 0 ||
    trade.entry_quantity !== trade.exit_quantity
  ) {
    throwEquityMetricsIssue({
      path: '$.trade.quantity',
      code: 'invalid_quantity',
      message: 'closed trade entry and exit quantities must match positive safe integers',
    });
  }
}

function validatePrice(price: number, path: string): void {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    throwEquityMetricsIssue({
      path,
      code: 'missing_closed_trade_price',
      message: 'closed trade average price must be a positive finite number',
    });
  }
}

function quantityToBigint(quantity: number): bigint {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throwEquityMetricsIssue({
      path: '$.trade.quantity',
      code: 'invalid_quantity',
      message: 'quantity must be a positive safe integer',
    });
  }
  return BigInt(quantity);
}

function sumExecutionCosts(
  trade: ClosedTrade,
  executions: readonly LedgerExecution[],
): {
  readonly fees_cents: bigint;
  readonly commissions_cents: bigint;
} {
  const executionIds = new Set(trade.execution_ids);
  let feesCents = 0n;
  let commissionsCents = 0n;
  for (const execution of executions) {
    if (!executionIds.has(execution.execution_id)) {
      continue;
    }
    if (execution.exchange_fee_usd !== undefined) {
      feesCents += usdNumberToCents(execution.exchange_fee_usd);
    }
    if (execution.commission_usd !== undefined) {
      commissionsCents += usdNumberToCents(execution.commission_usd);
    }
  }
  return {
    fees_cents: feesCents,
    commissions_cents: commissionsCents,
  };
}
