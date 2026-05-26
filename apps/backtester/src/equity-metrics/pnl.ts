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
  const tickQuantities = computeExecutionTickQuantities(trade, options, executions);
  const tickDelta = trade.side === 'long'
    ? tickQuantities.exit_tick_quantity - tickQuantities.entry_tick_quantity
    : tickQuantities.entry_tick_quantity - tickQuantities.exit_tick_quantity;
  const grossPnlCents = tickDelta * options.valuation.tick_value_usd_cents;
  const costs = sumExecutionCosts(trade, executions);

  return {
    trade_id: trade.trade_id,
    run_id: trade.run_id,
    closed_at_ns: trade.closed_at_ns,
    side: trade.side,
    quantity,
    entry_tick_quantity: tickQuantities.entry_tick_quantity,
    exit_tick_quantity: tickQuantities.exit_tick_quantity,
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

function computeExecutionTickQuantities(
  trade: ClosedTrade,
  options: EquityMetricsOptions,
  executions: readonly LedgerExecution[],
): {
  readonly entry_tick_quantity: bigint;
  readonly exit_tick_quantity: bigint;
} {
  const executionIds = new Set(trade.execution_ids);
  if (executionIds.size === 0 || executionIds.size !== trade.execution_ids.length) {
    throwEquityMetricsIssue({
      path: '$.trade.execution_ids',
      code: 'invalid_quantity',
      message: 'closed trade must reference a non-empty unique set of component executions',
    });
  }

  const entrySide = trade.side === 'long' ? 'buy' : 'sell';
  const exitSide = trade.side === 'long' ? 'sell' : 'buy';
  let matchedExecutions = 0;
  let entryQuantity = 0;
  let exitQuantity = 0;
  let entryTickQuantity = 0n;
  let exitTickQuantity = 0n;

  for (const execution of executions) {
    if (!executionIds.has(execution.execution_id)) {
      continue;
    }

    matchedExecutions += 1;
    const executionQuantity = validateExecutionQuantity(execution);
    const executionTickQuantity =
      priceToTicks(execution.price, options.valuation.tick_size) * BigInt(executionQuantity);

    if (execution.side === entrySide) {
      entryQuantity += executionQuantity;
      entryTickQuantity += executionTickQuantity;
      continue;
    }

    if (execution.side === exitSide) {
      exitQuantity += executionQuantity;
      exitTickQuantity += executionTickQuantity;
      continue;
    }

    throwEquityMetricsIssue({
      path: `$.executions[${execution.execution_id}].side`,
      code: 'unsupported_trade_side',
      message: 'execution side must be buy or sell',
    });
  }

  if (matchedExecutions !== executionIds.size) {
    throwEquityMetricsIssue({
      path: '$.trade.execution_ids',
      code: 'invalid_quantity',
      message: 'closed trade references component executions missing from the ledger',
    });
  }

  if (entryQuantity !== trade.entry_quantity || exitQuantity !== trade.exit_quantity) {
    throwEquityMetricsIssue({
      path: '$.trade.quantity',
      code: 'invalid_quantity',
      message: 'component execution quantities must match closed trade entry and exit quantities',
    });
  }

  return {
    entry_tick_quantity: entryTickQuantity,
    exit_tick_quantity: exitTickQuantity,
  };
}

function validateExecutionQuantity(execution: LedgerExecution): number {
  if (!Number.isSafeInteger(execution.quantity) || execution.quantity <= 0) {
    throwEquityMetricsIssue({
      path: `$.executions[${execution.execution_id}].quantity`,
      code: 'invalid_quantity',
      message: 'execution quantity must be a positive safe integer',
    });
  }
  return execution.quantity;
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
