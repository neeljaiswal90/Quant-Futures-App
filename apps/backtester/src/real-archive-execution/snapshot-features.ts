import type { DbnLevel, DbnMbp1Record, DbnRecord, DbnTradesRecord } from '../../../strategy_runtime/src/data/dbn-types.js';
import {
  OPENING_RANGE_MINUTES,
  type StrategyFeatureSnapshotContext,
  type StrategyFeatureSnapshotRegime,
} from '../../../strategy_runtime/src/strategies/index.js';
import { computeLevelOfiContribution } from '../fidelity/ofi/index.js';

export type SnapshotTrend = 'up' | 'down' | 'range' | 'unknown';

export interface SnapshotPriceBar {
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface SnapshotFeatureState {
  readonly previous_mbp1_by_instrument: Map<number, DbnLevel>;
  readonly bar_ofi_values: number[];
}

export interface SnapshotContextSeed {
  readonly prior_day_close?: number | null;
  readonly prior_day_high?: number | null;
  readonly prior_day_low?: number | null;
  readonly vix_value?: number | null;
  readonly vix_fresh?: boolean;
  readonly regime_label?: StrategyFeatureSnapshotRegime;
}

export interface SnapshotContextState {
  today_open: number | null;
  opening_range_high: number | null;
  opening_range_low: number | null;
  readonly prior_day_close: number | null;
  readonly prior_day_high: number | null;
  readonly prior_day_low: number | null;
  readonly vix_value: number | null;
  readonly vix_fresh: boolean;
  readonly regime_label: StrategyFeatureSnapshotRegime;
  effective_rth_start_ts_ns: bigint | null;
}

export interface SnapshotContextBarInput {
  readonly bar: SnapshotPriceBar & {
    readonly open: number;
    readonly start_ts_ns: bigint;
  };
  readonly rth_start_ts_ns?: bigint | null;
}

export interface SupertrendSnapshot {
  readonly direction: Exclude<SnapshotTrend, 'range'>;
  readonly value: number | null;
}

const DEFAULT_OFI_Z_WINDOW = 30;
const DEFAULT_SUPERTREND_PERIOD = 14;
const DEFAULT_SUPERTREND_MULTIPLIER = 3;
const DEFAULT_STRUCTURAL_TREND_WINDOW = 20;

export function createSnapshotFeatureState(): SnapshotFeatureState {
  return {
    previous_mbp1_by_instrument: new Map(),
    bar_ofi_values: [],
  };
}

export function createSnapshotContextState(seed: SnapshotContextSeed = {}): SnapshotContextState {
  return {
    today_open: null,
    opening_range_high: null,
    opening_range_low: null,
    prior_day_close: seed.prior_day_close ?? null,
    prior_day_high: seed.prior_day_high ?? null,
    prior_day_low: seed.prior_day_low ?? null,
    vix_value: seed.vix_value ?? null,
    vix_fresh: seed.vix_value === null || seed.vix_value === undefined ? false : (seed.vix_fresh ?? false),
    regime_label: seed.regime_label ?? 'unknown',
    effective_rth_start_ts_ns: null,
  };
}

export function updateSnapshotContextForBar(
  state: SnapshotContextState,
  input: SnapshotContextBarInput,
): StrategyFeatureSnapshotContext {
  const rthStart = input.rth_start_ts_ns ?? state.effective_rth_start_ts_ns ?? input.bar.start_ts_ns;
  state.effective_rth_start_ts_ns ??= rthStart;

  const elapsedNs = input.bar.start_ts_ns - rthStart;
  if (elapsedNs >= 0n && state.today_open === null) {
    state.today_open = input.bar.open;
  }

  const minuteNs = 60_000_000_000n;
  const openingRangeNs = BigInt(OPENING_RANGE_MINUTES) * minuteNs;
  const elapsedMinutes = elapsedNs <= 0n
    ? 0
    : Math.min(OPENING_RANGE_MINUTES, Number(elapsedNs / minuteNs));

  if (elapsedNs >= 0n && elapsedNs < openingRangeNs) {
    state.opening_range_high = state.opening_range_high === null
      ? input.bar.high
      : Math.max(state.opening_range_high, input.bar.high);
    state.opening_range_low = state.opening_range_low === null
      ? input.bar.low
      : Math.min(state.opening_range_low, input.bar.low);
  }

  return {
    prior_day_close: state.prior_day_close,
    prior_day_high: state.prior_day_high,
    prior_day_low: state.prior_day_low,
    today_open: state.today_open,
    vix_value: state.vix_value,
    vix_fresh: state.vix_fresh,
    regime_label: state.regime_label,
    opening_range_high: state.opening_range_high,
    opening_range_low: state.opening_range_low,
    opening_range_minutes_elapsed: elapsedMinutes,
  };
}

export function updateOfiZForBar(
  state: SnapshotFeatureState,
  records: readonly DbnRecord[],
  windowLength = DEFAULT_OFI_Z_WINDOW,
): number | null {
  const barOfi = computeBarOfi(state, records);
  if (state.bar_ofi_values.length < windowLength) {
    state.bar_ofi_values.push(barOfi);
    return null;
  }

  const window = state.bar_ofi_values.slice(-windowLength);
  const mean = average(window);
  const variance = average(window.map((value) => (value - mean) ** 2));
  state.bar_ofi_values.push(barOfi);
  if (!(variance > 0)) {
    return null;
  }
  return round4((barOfi - mean) / Math.sqrt(variance));
}

export function computeAtrSupertrend(
  bars: readonly SnapshotPriceBar[],
  period = DEFAULT_SUPERTREND_PERIOD,
  multiplier = DEFAULT_SUPERTREND_MULTIPLIER,
): SupertrendSnapshot {
  if (bars.length < period) {
    return { direction: 'unknown', value: null };
  }

  let atr = 0;
  let direction: SupertrendSnapshot['direction'] = 'unknown';
  let priorUpper: number | null = null;
  let priorLower: number | null = null;
  let value: number | null = null;

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    const previous = bars[index - 1];
    const trueRange = previous === undefined
      ? bar.high - bar.low
      : Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - previous.close),
        Math.abs(bar.low - previous.close),
      );

    if (index < period) {
      atr += trueRange;
      if (index < period - 1) {
        continue;
      }
      atr /= period;
    } else {
      atr = ((atr * (period - 1)) + trueRange) / period;
    }

    const middle = (bar.high + bar.low) / 2;
    const upper = middle + multiplier * atr;
    const lower = middle - multiplier * atr;

    if (direction === 'unknown') {
      const firstClose = bars[0]?.close ?? bar.close;
      direction = bar.close >= firstClose ? 'up' : 'down';
    } else if (priorUpper !== null && bar.close > priorUpper) {
      direction = 'up';
    } else if (priorLower !== null && bar.close < priorLower) {
      direction = 'down';
    }

    value = direction === 'up' ? lower : upper;
    priorUpper = upper;
    priorLower = lower;
  }

  return { direction, value: value === null ? null : round4(value) };
}

export function computeStructuralTrend(
  bars: readonly SnapshotPriceBar[],
  sigmaPts: number,
  windowLength = DEFAULT_STRUCTURAL_TREND_WINDOW,
): SnapshotTrend {
  if (bars.length < windowLength || !(sigmaPts > 0)) {
    return 'unknown';
  }
  const window = bars.slice(-windowLength);
  const slope = linearRegressionSlope(window.map((bar) => bar.close));
  const epsilon = sigmaPts * 0.05;
  if (slope > epsilon) {
    return 'up';
  }
  if (slope < -epsilon) {
    return 'down';
  }
  return 'range';
}

function computeBarOfi(state: SnapshotFeatureState, records: readonly DbnRecord[]): number {
  let ofi = 0n;
  for (const record of stableSortRecords(records)) {
    if (isMbp1Record(record)) {
      const current = record.levels[0];
      const previous = state.previous_mbp1_by_instrument.get(record.instrument_id);
      if (current !== undefined) {
        ofi += computeLevelOfiContribution(previous, current).ofi;
        state.previous_mbp1_by_instrument.set(record.instrument_id, current);
      }
      continue;
    }
    if (isTradesRecord(record)) {
      ofi += tradeOfi(record);
    }
  }
  return Number(ofi);
}

function tradeOfi(record: DbnTradesRecord): bigint {
  if (record.aggressor_side === 'B') {
    return BigInt(record.size);
  }
  if (record.aggressor_side === 'A') {
    return -BigInt(record.size);
  }
  return 0n;
}

function stableSortRecords(records: readonly DbnRecord[]): readonly DbnRecord[] {
  return [...records]
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      if (left.record.ts_event < right.record.ts_event) return -1;
      if (left.record.ts_event > right.record.ts_event) return 1;
      return left.index - right.index;
    })
    .map((entry) => entry.record);
}

function linearRegressionSlope(values: readonly number[]): number {
  const xMean = (values.length - 1) / 2;
  const yMean = average(values);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const xDelta = index - xMean;
    numerator += xDelta * (values[index]! - yMean);
    denominator += xDelta ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function isMbp1Record(record: DbnRecord): record is DbnMbp1Record {
  return record.schema === 'mbp-1';
}

function isTradesRecord(record: DbnRecord): record is DbnTradesRecord {
  return record.schema === 'trades';
}
