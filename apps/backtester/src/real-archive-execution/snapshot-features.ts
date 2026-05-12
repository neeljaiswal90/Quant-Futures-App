import type { DbnLevel, DbnMbp1Record, DbnRecord, DbnTradesRecord } from '../../../strategy_runtime/src/data/dbn-types.js';
import {
  createNullSignedShockMeasurement,
  OPENING_RANGE_MINUTES,
  type SignedShockAnchorType,
  type SignedShockMeasurement,
  type SignedShockSigmaBasis,
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
  session_vwap_price_volume_sum: number;
  session_vwap_volume_sum: number;
  session_vwap_deviations: number[];
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
    readonly volume?: number;
  };
  readonly rth_start_ts_ns?: bigint | null;
}

export interface SupertrendSnapshot {
  readonly direction: Exclude<SnapshotTrend, 'range'>;
  readonly value: number | null;
}

const DEFAULT_OFI_Z_WINDOW = 30;
const DEFAULT_SESSION_VWAP_BAND_WINDOW = 30;
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
    session_vwap_price_volume_sum: 0,
    session_vwap_volume_sum: 0,
    session_vwap_deviations: [],
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

  if (elapsedNs >= 0n) {
    const volume = input.bar.volume ?? 0;
    if (volume > 0) {
      state.session_vwap_price_volume_sum += input.bar.close * volume;
      state.session_vwap_volume_sum += volume;
      const currentVwap = state.session_vwap_price_volume_sum / state.session_vwap_volume_sum;
      state.session_vwap_deviations.push(input.bar.close - currentVwap);
      if (state.session_vwap_deviations.length > DEFAULT_SESSION_VWAP_BAND_WINDOW) {
        state.session_vwap_deviations.shift();
      }
    }
  }

  const minuteNs = 60_000_000_000n;
  const openingRangeNs = BigInt(OPENING_RANGE_MINUTES) * minuteNs;
  const elapsedMinutes = elapsedNs <= 0n
    ? 0
      : Math.min(OPENING_RANGE_MINUTES, Number(elapsedNs / minuteNs));
  const sessionVwap = state.session_vwap_volume_sum > 0
    ? round4(state.session_vwap_price_volume_sum / state.session_vwap_volume_sum)
    : null;
  const sessionVwapBandSigmaPts = state.session_vwap_deviations.length < DEFAULT_SESSION_VWAP_BAND_WINDOW
    ? null
    : round4(populationStd(state.session_vwap_deviations));
  const overnightReturnBps = (
    state.today_open === null ||
    state.prior_day_close === null ||
    !(state.prior_day_close > 0)
  )
    ? null
    : round4(((state.today_open - state.prior_day_close) / state.prior_day_close) * 10_000);

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
    session_vwap: sessionVwap,
    session_vwap_band_sigma_pts: sessionVwapBandSigmaPts,
    overnight_return_bps: overnightReturnBps,
    signed_shock_vwap: createNullSignedShockMeasurement('vwap'),
    signed_shock_prior_close: createNullSignedShockMeasurement('prior_close'),
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

export function computeAtr14(
  bars: readonly SnapshotPriceBar[],
  period = DEFAULT_SUPERTREND_PERIOD,
): number | null {
  if (bars.length <= period) {
    return null;
  }

  let atr = 0;
  for (let index = 0; index < bars.length; index += 1) {
    const trueRange = computeTrueRange(bars, index);
    if (index < period) {
      atr += trueRange;
      if (index === period - 1) {
        atr /= period;
      }
      continue;
    }
    atr = ((atr * (period - 1)) + trueRange) / period;
  }
  return round4(atr);
}

export function computeAdx14(
  bars: readonly SnapshotPriceBar[],
  period = DEFAULT_SUPERTREND_PERIOD,
): number | null {
  if (bars.length <= period) {
    return null;
  }

  let smoothedTrueRange = 0;
  let smoothedPlusDm = 0;
  let smoothedMinusDm = 0;
  let adx: number | null = null;

  for (let index = 1; index < bars.length; index += 1) {
    const current = bars[index]!;
    const previous = bars[index - 1]!;
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
    const trueRange = computeTrueRange(bars, index);

    if (index <= period) {
      smoothedTrueRange += trueRange;
      smoothedPlusDm += plusDm;
      smoothedMinusDm += minusDm;
      if (index < period) {
        continue;
      }
    } else {
      smoothedTrueRange = smoothedTrueRange - (smoothedTrueRange / period) + trueRange;
      smoothedPlusDm = smoothedPlusDm - (smoothedPlusDm / period) + plusDm;
      smoothedMinusDm = smoothedMinusDm - (smoothedMinusDm / period) + minusDm;
    }

    if (!(smoothedTrueRange > 0)) {
      continue;
    }
    const plusDi = 100 * smoothedPlusDm / smoothedTrueRange;
    const minusDi = 100 * smoothedMinusDm / smoothedTrueRange;
    const denominator = plusDi + minusDi;
    const dx = denominator === 0 ? 0 : 100 * Math.abs(plusDi - minusDi) / denominator;
    adx = adx === null ? dx : ((adx * (period - 1)) + dx) / period;
  }

  return adx === null ? null : round4(adx);
}

export function createSignedShockMeasurement(input: {
  readonly price: number | null;
  readonly anchor_type: SignedShockAnchorType;
  readonly anchor_value: number | null;
  readonly sigma_basis: SignedShockSigmaBasis;
  readonly sigma_basis_value: number | null;
}): SignedShockMeasurement {
  const anchorValue = finiteOrNull(input.anchor_value);
  const sigmaBasisValue = positiveFiniteOrNull(input.sigma_basis_value);
  const price = finiteOrNull(input.price);
  if (anchorValue === null || sigmaBasisValue === null || price === null) {
    return {
      value: null,
      anchor_type: input.anchor_type,
      anchor_value: anchorValue,
      sigma_basis: input.sigma_basis,
      sigma_basis_value: sigmaBasisValue,
    };
  }
  return {
    value: round4((price - anchorValue) / sigmaBasisValue),
    anchor_type: input.anchor_type,
    anchor_value: round4(anchorValue),
    sigma_basis: input.sigma_basis,
    sigma_basis_value: round4(sigmaBasisValue),
  };
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

function computeTrueRange(bars: readonly SnapshotPriceBar[], index: number): number {
  const bar = bars[index]!;
  const previous = bars[index - 1];
  return previous === undefined
    ? bar.high - bar.low
    : Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previous.close),
      Math.abs(bar.low - previous.close),
    );
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function populationStd(values: readonly number[]): number {
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function finiteOrNull(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : value;
}

function positiveFiniteOrNull(value: number | null): number | null {
  return value === null || !Number.isFinite(value) || !(value > 0) ? null : value;
}

function isMbp1Record(record: DbnRecord): record is DbnMbp1Record {
  return record.schema === 'mbp-1';
}

function isTradesRecord(record: DbnRecord): record is DbnTradesRecord {
  return record.schema === 'trades';
}
