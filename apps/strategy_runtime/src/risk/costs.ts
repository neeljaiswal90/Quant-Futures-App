/**
 * Realistic cost ledger (MEAS-01, v3.1 §5.1, §6.2).
 *
 * Authority: trading_app_implementation_plan_v3_1_engineering_handoff.md
 *
 * Design constraints:
 *   - Additive only. This module does not overwrite the existing
 *     `pnl_realized` / `r_multiple` / `fee_estimate` / `fee_actual` /
 *     `slippage_estimate` / `slippage_actual` fields on TradeRecord.
 *   - Versioned. Every computed breakdown stamps `cost_model_version`,
 *     `commission_schedule_effective_date`, and `cost_assumption_source` so
 *     downstream analyses can reconstruct the exact assumption set.
 *   - Provider-neutral. Venue fees are passed in via VenueCostConfig; no
 *     broker-specific constants are embedded here.
 *
 * Scope of this slice (PR 1 of MEAS-01):
 *   - pure computation module + unit tests.
 *   - no edits to types.ts / trade-journal.ts / performance-tracker.ts yet.
 *     Those wiring edits land in the MEAS-01 PR 2 slice as additive fields
 *     on TradeRecord, with every field nullable/optional so pre-refactor
 *     records remain readable.
 */

import type { ContractSpec } from './contracts.js';
import { getContractSpec } from './contracts.js';
import type { TradeRecord } from '../contracts/position.js';

export const COST_MODEL_VERSION = 'meas01.v1';

/** Side of the position. Fee/slippage signs depend on side × role. */
export type TradeSide = 'long' | 'short';

/** Order type at fill. Different order types imply different slippage priors. */
export type CostOrderType = 'market' | 'limit' | 'stop' | 'stop_limit';

/**
 * Per-venue cost assumptions used by computeTradeCosts.
 *
 * The split between commission and exchange_fees matters: commissions are
 * broker-controlled and change with account tier; exchange fees are
 * CME-controlled and change with schedule effective date. MEAS-03 baseline
 * reports must be able to regenerate with a different commission assumption
 * without losing the exchange-fee history.
 */
export interface VenueCostConfig {
  /** Broker commission per side per contract, USD. */
  commission_per_side_per_contract_usd: number;
  /** Exchange fees per side per contract, USD (CME schedule). */
  exchange_fees_per_side_per_contract_usd: number;
  /**
   * Effective date of the commission schedule (ISO-8601 date).
   * Stamped into every cost breakdown for audit.
   */
  commission_schedule_effective_date: string;
  /**
   * Free-form source reference (e.g. "tradovate-2026-q1",
   * "cme-globex-fee-schedule-2026-01-01"). Stamped for reproducibility.
   */
  cost_assumption_source: string;
}

/** Input bundle for a single closed trade. */
export interface TradeCostInput {
  contract: ContractSpec;
  order_type_entry: CostOrderType;
  order_type_exit: CostOrderType;
  side: TradeSide;
  qty: number;
  /** Planned entry price at the moment the order was generated. */
  planned_entry_price: number;
  /** Actual entry fill price from the broker/sim. */
  actual_entry_fill_price: number;
  /** Planned exit price (stop or target) at the moment the exit decision fired. */
  planned_exit_price: number;
  /** Actual exit fill price from the broker/sim. */
  actual_exit_fill_price: number;
  /** Per-venue cost assumptions. */
  venue: VenueCostConfig;
  /**
   * Optional: planned worst-case loss at entry in USD (stop distance +
   * slippage stress + round-trip fees), used to compute r_gross / r_net.
   * When omitted, r_gross and r_net are null (caller had no stop snapshot).
   */
  planned_worst_case_loss_usd?: number;
}

/** Output bundle — every field v3.1 MEAS-01 requires. */
export interface TradeCostBreakdown {
  // Fees & commissions (round-trip, USD)
  commission_usd: number;
  exchange_fees_usd: number;

  // Slippage in ticks (signed: positive = adverse to the trader)
  entry_slippage_ticks: number;
  exit_slippage_ticks: number;

  // Slippage in USD (round-trip, signed adverse-positive)
  slippage_usd: number;

  // Total cost = commission + exchange_fees + slippage, USD
  total_cost_usd: number;

  // Gross and net PnL (USD)
  pnl_gross_usd: number;
  pnl_net_usd: number;

  // R units (null when planned_worst_case_loss_usd not supplied)
  r_gross: number | null;
  r_net: number | null;

  // Audit stamps (v3.1 §4.4 schema-evolution policy)
  cost_model_version: string;
  commission_schedule_effective_date: string;
  cost_assumption_source: string;
}

/**
 * Compute the MEAS-01 cost breakdown for a single completed round-trip trade.
 *
 * Sign convention for slippage (v3.1 §5.1):
 *   - adverse slippage is positive (it reduces pnl_net).
 *   - For a long entry, adverse = actual > planned.
 *   - For a short entry, adverse = actual < planned.
 *   - For a long exit, adverse = actual < planned.
 *   - For a short exit, adverse = actual > planned.
 */
export function computeTradeCosts(input: TradeCostInput): TradeCostBreakdownResult {
  validate(input);

  const {
    contract,
    side,
    qty,
    planned_entry_price,
    actual_entry_fill_price,
    planned_exit_price,
    actual_exit_fill_price,
    venue,
    planned_worst_case_loss_usd,
  } = input;

  // Fees — per contract, round trip (2 sides).
  const commission_usd =
    venue.commission_per_side_per_contract_usd * 2 * qty;
  const exchange_fees_usd =
    venue.exchange_fees_per_side_per_contract_usd * 2 * qty;

  // Slippage in price points, signed adverse-positive.
  const entry_slippage_points = signedAdversePoints(
    'entry',
    side,
    planned_entry_price,
    actual_entry_fill_price,
  );
  const exit_slippage_points = signedAdversePoints(
    'exit',
    side,
    planned_exit_price,
    actual_exit_fill_price,
  );

  // Convert to ticks (signed).
  const entry_slippage_ticks = pointsToTicks(entry_slippage_points, contract.tick_size);
  const exit_slippage_ticks = pointsToTicks(exit_slippage_points, contract.tick_size);

  // Convert to USD using point_value × qty.
  const slippage_usd =
    (entry_slippage_points + exit_slippage_points) * contract.point_value * qty;

  const total_cost_usd = commission_usd + exchange_fees_usd + slippage_usd;

  // Gross PnL uses PLANNED prices (what the strategy intended).
  // Net PnL uses ACTUAL fills minus fees.
  // Both expressed as round-trip PnL for qty contracts.
  const directionSign = side === 'long' ? 1 : -1;
  const pnl_gross_usd =
    directionSign *
    (planned_exit_price - planned_entry_price) *
    contract.point_value *
    qty;
  const pnl_net_usd =
    directionSign *
    (actual_exit_fill_price - actual_entry_fill_price) *
    contract.point_value *
    qty -
    commission_usd -
    exchange_fees_usd;

  // R units (null if caller did not supply a stop snapshot).
  let r_gross: number | null = null;
  let r_net: number | null = null;
  if (
    planned_worst_case_loss_usd !== undefined &&
    planned_worst_case_loss_usd > 0
  ) {
    r_gross = pnl_gross_usd / planned_worst_case_loss_usd;
    r_net = pnl_net_usd / planned_worst_case_loss_usd;
  }

  return {
    commission_usd,
    exchange_fees_usd,
    entry_slippage_ticks,
    exit_slippage_ticks,
    slippage_usd,
    total_cost_usd,
    pnl_gross_usd,
    pnl_net_usd,
    r_gross,
    r_net,
    cost_model_version: COST_MODEL_VERSION,
    commission_schedule_effective_date: venue.commission_schedule_effective_date,
    cost_assumption_source: venue.cost_assumption_source,
  };
}

/** Alias so the public type name reads cleanly at call sites. */
export type TradeCostBreakdownResult = TradeCostBreakdown;

// ─── Trade-record enrichment (MEAS-01 slice 3) ──────────────────────────────

/**
 * Return a new TradeRecord with the 13 MEAS-01 cost fields populated.
 * Pure — does not mutate `trade`. On missing venue config or missing
 * planned/actual prices, returns `trade` unchanged (cost fields remain
 * undefined). Callers that require fail-closed behavior should validate
 * upstream.
 *
 * The worst-case-loss denominator for r_gross / r_net is derived from
 * stop_price_initial and entry_price_planned plus the round-trip cost,
 * so r_net has the same denominator semantics as v3.1 §5.1.
 */
export function enrichTradeRecordWithCosts(
  trade: TradeRecord,
  venue: VenueCostConfig | null,
): TradeRecord {
  if (!venue) return trade;
  const spec = (() => {
    try {
      return getContractSpec(trade.symbol);
    } catch {
      return null;
    }
  })();
  if (!spec) return trade;

  const qty = trade.quantity;
  const plannedEntry = trade.entry_price_planned;
  const actualEntry = trade.entry_price_filled;
  const plannedExit = trade.exit_price_planned;
  const actualExit = trade.exit_price_actual;
  if (
    !(qty > 0) ||
    !isFinitePositive(plannedEntry) ||
    !isFinitePositive(actualEntry) ||
    !isFinitePositive(plannedExit) ||
    !isFinitePositive(actualExit)
  ) {
    return trade;
  }

  // Worst-case loss at entry = |entry_planned - stop_initial| * point_value * qty
  //                          + round-trip fees (v3.1 §5.1 definition of L_init).
  const roundTripFeesUsd =
    (venue.commission_per_side_per_contract_usd +
      venue.exchange_fees_per_side_per_contract_usd) *
    2 *
    qty;
  const stopDistancePts = isFinitePositive(trade.stop_price_initial)
    ? Math.abs(plannedEntry - trade.stop_price_initial)
    : 0;
  const plannedWorstCaseLossUsd =
    stopDistancePts > 0
      ? stopDistancePts * spec.point_value * qty + roundTripFeesUsd
      : undefined;

  const breakdown = computeTradeCosts({
    contract: spec,
    order_type_entry: 'market',
    order_type_exit: 'market',
    side: trade.side,
    qty,
    planned_entry_price: plannedEntry,
    actual_entry_fill_price: actualEntry,
    planned_exit_price: plannedExit,
    actual_exit_fill_price: actualExit,
    venue,
    planned_worst_case_loss_usd: plannedWorstCaseLossUsd,
  });

  return {
    ...trade,
    commission_usd: breakdown.commission_usd,
    exchange_fees_usd: breakdown.exchange_fees_usd,
    entry_slippage_ticks: breakdown.entry_slippage_ticks,
    exit_slippage_ticks: breakdown.exit_slippage_ticks,
    slippage_usd: breakdown.slippage_usd,
    total_cost_usd: breakdown.total_cost_usd,
    pnl_gross_usd: breakdown.pnl_gross_usd,
    pnl_net_usd: breakdown.pnl_net_usd,
    r_gross: breakdown.r_gross,
    r_net: breakdown.r_net,
    cost_model_version: breakdown.cost_model_version,
    commission_schedule_effective_date: breakdown.commission_schedule_effective_date,
    cost_assumption_source: breakdown.cost_assumption_source,
  };
}

function isFinitePositive(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

// ─── internals ──────────────────────────────────────────────────────────────

function signedAdversePoints(
  role: 'entry' | 'exit',
  side: TradeSide,
  planned: number,
  actual: number,
): number {
  const raw = actual - planned;
  if (role === 'entry') {
    return side === 'long' ? raw : -raw;
  }
  return side === 'long' ? -raw : raw;
}

function pointsToTicks(points: number, tick_size: number): number {
  if (!(tick_size > 0)) {
    throw new Error(`costs: invalid tick_size=${tick_size}`);
  }
  return points / tick_size;
}

function validate(input: TradeCostInput): void {
  if (!(input.qty > 0) || !Number.isFinite(input.qty)) {
    throw new Error(`costs: qty must be a positive finite number, got ${input.qty}`);
  }
  if (!input.contract || !(input.contract.point_value > 0)) {
    throw new Error('costs: contract.point_value must be > 0');
  }
  const prices = [
    input.planned_entry_price,
    input.actual_entry_fill_price,
    input.planned_exit_price,
    input.actual_exit_fill_price,
  ];
  for (const p of prices) {
    if (!Number.isFinite(p) || p <= 0) {
      throw new Error(`costs: non-positive or non-finite price in input: ${p}`);
    }
  }
  if (input.venue.commission_per_side_per_contract_usd < 0) {
    throw new Error('costs: commission cannot be negative');
  }
  if (input.venue.exchange_fees_per_side_per_contract_usd < 0) {
    throw new Error('costs: exchange fees cannot be negative');
  }
  if (!input.venue.commission_schedule_effective_date) {
    throw new Error('costs: commission_schedule_effective_date is required');
  }
  if (!input.venue.cost_assumption_source) {
    throw new Error('costs: cost_assumption_source is required');
  }
}
