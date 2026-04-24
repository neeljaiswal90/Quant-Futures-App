import type { Direction } from '../contracts/market.js';
import {
  getContractSpec,
  priceDeltaUsd,
  round6,
  roundCurrency,
  type ContractRoot,
  type ContractSpec,
} from './contracts.js';

export const COST_MODEL_VERSION = 'mnq_sim_cost_model_v1' as const;

export type CostOrderType = 'market' | 'limit' | 'stop_market';

export interface VenueCostConfig {
  readonly root: ContractRoot;
  readonly commission_per_side_per_contract_usd: number;
  readonly exchange_fees_per_side_per_contract_usd: number;
  readonly effective_date: string;
  readonly assumption_source: string;
}

export interface TradeCostInput {
  readonly contract: ContractRoot | string | ContractSpec;
  readonly venue_cost: VenueCostConfig;
  readonly direction: Direction;
  readonly quantity: number;
  readonly planned_entry_price: number;
  readonly actual_entry_price: number;
  readonly planned_exit_price: number;
  readonly actual_exit_price: number;
  readonly entry_order_type: CostOrderType;
  readonly exit_order_type: CostOrderType;
  readonly planned_worst_case_loss_usd?: number;
}

export interface TradeCostBreakdown {
  readonly cost_model_version: typeof COST_MODEL_VERSION;
  readonly contract_root: ContractRoot;
  readonly quantity: number;
  readonly commission_usd: number;
  readonly exchange_fees_usd: number;
  readonly entry_slippage_points: number;
  readonly exit_slippage_points: number;
  readonly total_adverse_slippage_points: number;
  readonly slippage_usd: number;
  readonly total_cost_usd: number;
  readonly planned_gross_pnl_usd: number;
  readonly actual_gross_pnl_usd: number;
  readonly actual_net_pnl_usd: number;
  readonly r_gross?: number;
  readonly r_net?: number;
  readonly audit: {
    readonly entry_order_type: CostOrderType;
    readonly exit_order_type: CostOrderType;
    readonly effective_date: string;
    readonly assumption_source: string;
  };
}

export function computeRoundTripFees(input: {
  readonly quantity: number;
  readonly venue_cost: VenueCostConfig;
}): Pick<TradeCostBreakdown, 'commission_usd' | 'exchange_fees_usd'> {
  assertPositiveInteger(input.quantity, 'quantity');
  return {
    commission_usd: roundCurrency(
      input.venue_cost.commission_per_side_per_contract_usd * input.quantity * 2,
    ),
    exchange_fees_usd: roundCurrency(
      input.venue_cost.exchange_fees_per_side_per_contract_usd * input.quantity * 2,
    ),
  };
}

export function computeTradeCosts(input: TradeCostInput): TradeCostBreakdown {
  const contract = resolveContract(input.contract);
  assertPositiveInteger(input.quantity, 'quantity');
  const plannedEntryExitPoints = directionalPoints(
    input.direction,
    input.planned_entry_price,
    input.planned_exit_price,
  );
  const actualEntryExitPoints = directionalPoints(
    input.direction,
    input.actual_entry_price,
    input.actual_exit_price,
  );
  const entrySlippage = adverseEntrySlippagePoints(
    input.direction,
    input.planned_entry_price,
    input.actual_entry_price,
  );
  const exitSlippage = adverseExitSlippagePoints(
    input.direction,
    input.planned_exit_price,
    input.actual_exit_price,
  );
  const fees = computeRoundTripFees({
    quantity: input.quantity,
    venue_cost: input.venue_cost,
  });
  const plannedGross = priceDeltaUsd({
    points: plannedEntryExitPoints,
    quantity: input.quantity,
    contract,
  });
  const actualGross = priceDeltaUsd({
    points: actualEntryExitPoints,
    quantity: input.quantity,
    contract,
  });
  const slippageUsd = priceDeltaUsd({
    points: entrySlippage + exitSlippage,
    quantity: input.quantity,
    contract,
  });
  const totalCostUsd = roundCurrency(fees.commission_usd + fees.exchange_fees_usd + slippageUsd);
  const actualNet = roundCurrency(actualGross - fees.commission_usd - fees.exchange_fees_usd);
  const worstCaseLoss = input.planned_worst_case_loss_usd;

  return {
    cost_model_version: COST_MODEL_VERSION,
    contract_root: contract.root,
    quantity: input.quantity,
    commission_usd: fees.commission_usd,
    exchange_fees_usd: fees.exchange_fees_usd,
    entry_slippage_points: round6(entrySlippage),
    exit_slippage_points: round6(exitSlippage),
    total_adverse_slippage_points: round6(entrySlippage + exitSlippage),
    slippage_usd: slippageUsd,
    total_cost_usd: totalCostUsd,
    planned_gross_pnl_usd: plannedGross,
    actual_gross_pnl_usd: actualGross,
    actual_net_pnl_usd: actualNet,
    r_gross: worstCaseLoss === undefined ? undefined : round6(actualGross / worstCaseLoss),
    r_net: worstCaseLoss === undefined ? undefined : round6(actualNet / worstCaseLoss),
    audit: {
      entry_order_type: input.entry_order_type,
      exit_order_type: input.exit_order_type,
      effective_date: input.venue_cost.effective_date,
      assumption_source: input.venue_cost.assumption_source,
    },
  };
}

export function adverseEntrySlippagePoints(
  direction: Direction,
  plannedEntry: number,
  actualEntry: number,
): number {
  assertFiniteNumber(plannedEntry, 'planned entry');
  assertFiniteNumber(actualEntry, 'actual entry');
  const delta = direction === 'long' ? actualEntry - plannedEntry : plannedEntry - actualEntry;
  return Math.max(0, delta);
}

export function adverseExitSlippagePoints(
  direction: Direction,
  plannedExit: number,
  actualExit: number,
): number {
  assertFiniteNumber(plannedExit, 'planned exit');
  assertFiniteNumber(actualExit, 'actual exit');
  const delta = direction === 'long' ? plannedExit - actualExit : actualExit - plannedExit;
  return Math.max(0, delta);
}

function directionalPoints(direction: Direction, entry: number, exit: number): number {
  assertFiniteNumber(entry, 'entry');
  assertFiniteNumber(exit, 'exit');
  return direction === 'long' ? exit - entry : entry - exit;
}

function resolveContract(contract: ContractRoot | string | ContractSpec): ContractSpec {
  return typeof contract === 'object' ? contract : getContractSpec(contract);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
}
