import type { Direction, InstrumentIdentity } from '../contracts/market.js';

export type ContractRoot = 'MNQ' | 'NQ' | 'MES' | 'ES';

export interface ContractSpec {
  readonly root: ContractRoot;
  readonly display_name: string;
  readonly venue: 'CME';
  readonly currency: 'USD';
  readonly tick_size: number;
  readonly point_value: number;
  readonly tick_value: number;
  readonly price_decimals: number;
  readonly is_micro: boolean;
  readonly default_symbol: string;
  readonly parent_root?: ContractRoot;
  readonly fees_per_round_trip_usd: number;
  readonly slippage_points_per_side: number;
  readonly live_order_routing_allowed: false;
}

export const CONTRACT_SPECS = {
  MNQ: {
    root: 'MNQ',
    display_name: 'Micro E-mini Nasdaq-100 Futures',
    venue: 'CME',
    currency: 'USD',
    tick_size: 0.25,
    point_value: 2,
    tick_value: 0.5,
    price_decimals: 2,
    is_micro: true,
    default_symbol: 'MNQM6',
    parent_root: 'NQ',
    fees_per_round_trip_usd: 1.5,
    slippage_points_per_side: 0.75,
    live_order_routing_allowed: false,
  },
  NQ: {
    root: 'NQ',
    display_name: 'E-mini Nasdaq-100 Futures',
    venue: 'CME',
    currency: 'USD',
    tick_size: 0.25,
    point_value: 20,
    tick_value: 5,
    price_decimals: 2,
    is_micro: false,
    default_symbol: 'NQM6',
    fees_per_round_trip_usd: 4.46,
    slippage_points_per_side: 0.5,
    live_order_routing_allowed: false,
  },
  MES: {
    root: 'MES',
    display_name: 'Micro E-mini S&P 500 Futures',
    venue: 'CME',
    currency: 'USD',
    tick_size: 0.25,
    point_value: 5,
    tick_value: 1.25,
    price_decimals: 2,
    is_micro: true,
    default_symbol: 'MESM6',
    parent_root: 'ES',
    fees_per_round_trip_usd: 1.5,
    slippage_points_per_side: 0.5,
    live_order_routing_allowed: false,
  },
  ES: {
    root: 'ES',
    display_name: 'E-mini S&P 500 Futures',
    venue: 'CME',
    currency: 'USD',
    tick_size: 0.25,
    point_value: 50,
    tick_value: 12.5,
    price_decimals: 2,
    is_micro: false,
    default_symbol: 'ESM6',
    fees_per_round_trip_usd: 4.46,
    slippage_points_per_side: 0.25,
    live_order_routing_allowed: false,
  },
} as const satisfies Record<ContractRoot, ContractSpec>;

export const SUPPORTED_CONTRACT_ROOTS = ['MNQ', 'NQ', 'MES', 'ES'] as const;

export type TickRoundMode = 'nearest' | 'down' | 'up';

export function isContractRoot(value: string): value is ContractRoot {
  return (SUPPORTED_CONTRACT_ROOTS as readonly string[]).includes(value);
}

export function parseContractRoot(rootOrSymbol: string): ContractRoot {
  const normalized = rootOrSymbol.trim().toUpperCase();
  const direct = SUPPORTED_CONTRACT_ROOTS.find((root) => root === normalized);
  if (direct !== undefined) {
    return direct;
  }

  const symbolRoot = [...SUPPORTED_CONTRACT_ROOTS]
    .sort((a, b) => b.length - a.length)
    .find((root) => normalized.startsWith(root));
  if (symbolRoot !== undefined) {
    return symbolRoot;
  }

  throw new Error(`Unsupported contract root or symbol: ${rootOrSymbol}`);
}

export function contractRootFromInstrument(instrument: InstrumentIdentity): ContractRoot {
  return parseContractRoot(instrument.root);
}

export function getContractSpec(rootOrSymbol: ContractRoot | string): ContractSpec {
  return CONTRACT_SPECS[parseContractRoot(rootOrSymbol)];
}

export function tryGetContractSpec(rootOrSymbol: string): ContractSpec | undefined {
  try {
    return getContractSpec(rootOrSymbol);
  } catch {
    return undefined;
  }
}

export function listContractSpecs(): readonly ContractSpec[] {
  return SUPPORTED_CONTRACT_ROOTS.map((root) => CONTRACT_SPECS[root]);
}

export function roundToTick(
  price: number,
  contract: ContractSpec,
  mode: TickRoundMode = 'nearest',
): number {
  assertFiniteNumber(price, 'price');
  const rawTicks = price / contract.tick_size;
  const roundedTicks =
    mode === 'up' ? Math.ceil(rawTicks - Number.EPSILON)
      : mode === 'down' ? Math.floor(rawTicks + Number.EPSILON)
        : Math.round(rawTicks);
  return roundToDecimals(roundedTicks * contract.tick_size, contract.price_decimals);
}

export function roundStopAwayFromEntry(input: {
  readonly entry_price: number;
  readonly raw_stop_price: number;
  readonly direction: Direction;
  readonly contract: ContractSpec;
}): number {
  const mode = input.direction === 'long' ? 'down' : 'up';
  let stop = roundToTick(input.raw_stop_price, input.contract, mode);
  if (input.direction === 'long' && stop >= input.entry_price) {
    stop = roundToTick(input.entry_price - input.contract.tick_size, input.contract, 'down');
  }
  if (input.direction === 'short' && stop <= input.entry_price) {
    stop = roundToTick(input.entry_price + input.contract.tick_size, input.contract, 'up');
  }
  return stop;
}

export function pointsToTicks(points: number, contract: ContractSpec): number {
  assertFiniteNumber(points, 'points');
  return Math.round(points / contract.tick_size);
}

export function ticksToPoints(ticks: number, contract: ContractSpec): number {
  assertFiniteNumber(ticks, 'ticks');
  return roundToDecimals(ticks * contract.tick_size, contract.price_decimals);
}

export function normalizeStopDistance(points: number, contract: ContractSpec): number {
  assertFiniteNumber(points, 'stop distance');
  const minPoints = contract.tick_size * 2;
  const bounded = Math.max(Math.abs(points), minPoints);
  return ticksToPoints(Math.ceil(bounded / contract.tick_size), contract);
}

export function riskPerContractUsd(input: {
  readonly stop_points: number;
  readonly contract: ContractSpec;
  readonly slippage_points_per_side?: number;
  readonly round_trip_fees_usd?: number;
}): number {
  const stopPoints = normalizeStopDistance(input.stop_points, input.contract);
  const slippage = Math.max(
    0,
    input.slippage_points_per_side ?? input.contract.slippage_points_per_side,
  );
  const fees = Math.max(0, input.round_trip_fees_usd ?? input.contract.fees_per_round_trip_usd);
  const raw = (stopPoints + slippage) * input.contract.point_value + fees;
  const floor = 2 * input.contract.tick_value + fees;
  return roundCurrency(Math.max(raw, floor));
}

export function priceDeltaUsd(input: {
  readonly points: number;
  readonly quantity: number;
  readonly contract: ContractSpec;
}): number {
  assertFiniteNumber(input.points, 'points');
  assertFiniteNumber(input.quantity, 'quantity');
  return roundCurrency(input.points * input.quantity * input.contract.point_value);
}

export function roundCurrency(value: number): number {
  assertFiniteNumber(value, 'currency value');
  return Math.round(value * 100) / 100;
}

export function round6(value: number): number {
  assertFiniteNumber(value, 'value');
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function assertFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
}
