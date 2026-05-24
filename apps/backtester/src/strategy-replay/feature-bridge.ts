import {
  makeConfigHash,
  makeEventId,
  makeFeatureSnapshotId,
  makeSessionId,
  type Bar,
  type ConfigLineageRef,
  type InstrumentIdentity,
} from '../../../strategy_runtime/src/contracts/index.js';
import type { BuiltBar } from '../../../strategy_runtime/src/data/bar-builder/index.js';
import type {
  StrategyFeatureSnapshot,
  StrategyScalarMap,
} from '../../../strategy_runtime/src/strategies/index.js';
import { createNullSignedShockMeasurement } from '../../../strategy_runtime/src/strategies/index.js';
import {
  REPLAY_SANITY_PLACEHOLDER_FIELDS,
  STRATEGY_REPLAY_FEATURE_SOURCE,
  type StrategyReplayFeatureSnapshot,
} from './types.js';

const DEFAULT_CONFIG: ConfigLineageRef = {
  config_hash: makeConfigHash('0'.repeat(64)),
  config_version: 1,
};

const DEFAULT_TICK_SIZE = 0.25;
const DEFAULT_POINT_VALUE = 2;

export function buildReplayFeatureSnapshot(
  bar: BuiltBar,
  history: readonly BuiltBar[],
): StrategyReplayFeatureSnapshot {
  const candidateHistory = history.some((candidate) => candidate.bar_id === bar.bar_id)
    ? history
    : [...history, bar];
  const orderedCandidates = sortBars(candidateHistory);
  const currentIndex = orderedCandidates.findIndex((candidate) => candidate.bar_id === bar.bar_id);
  if (currentIndex < 0) {
    throw new Error('feature bridge history must include the current bar');
  }
  const orderedHistory = orderedCandidates.slice(0, currentIndex + 1);

  const bars = orderedHistory.map(toStrategyBar);
  const currentBar = bars.at(-1);
  if (currentBar === undefined) {
    throw new Error('feature bridge requires a current strategy bar');
  }

  const closes = bars.map((strategyBar) => strategyBar.close);
  const previousClose = closes.length > 1 ? closes[closes.length - 2] : undefined;
  const trend = deriveTrend(currentBar.close, previousClose);
  const sigmaPts = deriveSigmaPts(bars);
  const ema9 = exponentialMovingAverage(closes, 9);
  const ema21 = exponentialMovingAverage(closes, 21);
  const ema50 = exponentialMovingAverage(closes, 50);
  const zEma9 = (currentBar.close - ema9) / sigmaPts;
  const recentHigh = Math.max(...bars.map((strategyBar) => strategyBar.high));
  const recentLow = Math.min(...bars.map((strategyBar) => strategyBar.low));
  const priorBars = bars.slice(0, -1);
  const priorHigh = priorBars.length === 0
    ? currentBar.high
    : Math.max(...priorBars.map((strategyBar) => strategyBar.high));
  const priorLow = priorBars.length === 0
    ? currentBar.low
    : Math.min(...priorBars.map((strategyBar) => strategyBar.low));

  const indicators: StrategyScalarMap = {
    ema_9: round4(ema9),
    ema_21: round4(ema21),
    ema_50: round4(ema50),
    adx_14: null,
    atr_14_pts: null,
    pullback_ratio: round4(Math.min(1, Math.abs(currentBar.close - ema9) / sigmaPts)),
    sigma_pts: round4(sigmaPts),
    supertrend_direction: trend === 'down' ? 'down' : 'up',
    z_ema9: round4(zEma9),
    z_ofi_blend: 0,
  };

  const structureValues: StrategyScalarMap = {
    breakout_level: roundToTick(priorHigh, currentBar.instrument.tick_size),
    broken_support: roundToTick(priorLow, currentBar.instrument.tick_size),
    choch_buy: roundToTick(recentLow - sigmaPts, currentBar.instrument.tick_size),
    choch_sell: roundToTick(recentHigh + sigmaPts, currentBar.instrument.tick_size),
    nearest_resistance: roundToTick(recentHigh + sigmaPts, currentBar.instrument.tick_size),
    nearest_support: roundToTick(recentLow - sigmaPts, currentBar.instrument.tick_size),
    pivot_resistance_1: roundToTick(recentHigh + sigmaPts * 2, currentBar.instrument.tick_size),
    pivot_support_1: roundToTick(recentLow - sigmaPts * 2, currentBar.instrument.tick_size),
    retest_hold: currentBar.close >= ema9,
    retest_reject: currentBar.close <= ema9,
  };

  const snapshot: StrategyFeatureSnapshot = {
    feature_snapshot_id: makeFeatureSnapshotId(`replay-feature-${bar.bar_id}`),
    source_event_id: makeEventId(`replay-bar-${bar.bar_id}`),
    created_ts_ns: bar.last_record_ts_ns,
    instrument: currentBar.instrument,
    session: {
      session_id: makeSessionId(`replay-sanity-${bar.bar_id}`),
      trading_date: 'replay-sanity',
      phase: 'rth',
      is_rth: true,
      is_halt: false,
      is_roll_block: false,
      opened_ts_ns: bar.bucket_start_ts_ns ?? bar.first_record_ts_ns,
      closes_ts_ns: bar.bucket_end_ts_ns ?? bar.last_record_ts_ns,
    },
    quote: {
      bid_px: roundToTick(currentBar.close - currentBar.instrument.tick_size / 2, currentBar.instrument.tick_size),
      ask_px: roundToTick(currentBar.close + currentBar.instrument.tick_size / 2, currentBar.instrument.tick_size),
      mid_px: currentBar.close,
    },
    last_trade_price: currentBar.close,
    bars,
    indicators,
    structure: {
      trend,
      values: structureValues,
    },
    microstructure: {
      l3_authority: 'unavailable',
      values: {
        feature_source: STRATEGY_REPLAY_FEATURE_SOURCE,
        ofi_z: 0,
      },
    },
    context: {
      prior_day_close: null,
      prior_day_high: null,
      prior_day_low: null,
      today_open: bars[0]?.open ?? null,
      vix_value: null,
      vix_fresh: false,
      vix_prior_close_percentile: null,
      regime_label: 'unknown',
      opening_range_high: null,
      opening_range_low: null,
      opening_range_minutes_elapsed: 0,
      session_vwap: null,
      session_vwap_band_sigma_pts: null,
      overnight_return_bps: null,
      signed_shock_vwap: createNullSignedShockMeasurement('vwap'),
      signed_shock_vwap_recent_values: null,
      signed_shock_prior_close: createNullSignedShockMeasurement('prior_close'),
    },
    config: DEFAULT_CONFIG,
  };

  return {
    feature_source: STRATEGY_REPLAY_FEATURE_SOURCE,
    placeholder_fields: REPLAY_SANITY_PLACEHOLDER_FIELDS,
    snapshot,
  };
}

function toStrategyBar(bar: BuiltBar): Bar {
  const instrument = toInstrumentIdentity(bar);
  return {
    instrument,
    timeframe: toTimeframe(bar.bar_spec),
    start_ts_ns: bar.bucket_start_ts_ns ?? bar.first_record_ts_ns,
    end_ts_ns: bar.bucket_end_ts_ns ?? bar.last_record_ts_ns,
    open: toSafeNumber(bar.open, 'bar.open'),
    high: toSafeNumber(bar.high, 'bar.high'),
    low: toSafeNumber(bar.low, 'bar.low'),
    close: toSafeNumber(bar.close, 'bar.close'),
    volume: toSafeNumber(bar.volume, 'bar.volume'),
  };
}

function toInstrumentIdentity(bar: BuiltBar): InstrumentIdentity {
  return {
    root: 'MNQ',
    symbol: bar.raw_symbol ?? `iid${String(bar.instrument_id ?? 'unknown')}`,
    exchange: 'CME',
    currency: 'USD',
    tick_size: DEFAULT_TICK_SIZE,
    point_value: DEFAULT_POINT_VALUE,
    price_decimals: 2,
  };
}

function sortBars(bars: readonly BuiltBar[]): readonly BuiltBar[] {
  return [...bars].sort((left, right) => {
    if (left.last_record_ts_ns < right.last_record_ts_ns) return -1;
    if (left.last_record_ts_ns > right.last_record_ts_ns) return 1;
    return left.bar_id.localeCompare(right.bar_id);
  });
}

function deriveTrend(currentClose: number, previousClose: number | undefined): 'up' | 'down' | 'range' | 'unknown' {
  if (previousClose === undefined) {
    return 'unknown';
  }
  if (currentClose > previousClose) {
    return 'up';
  }
  if (currentClose < previousClose) {
    return 'down';
  }
  return 'range';
}

function deriveSigmaPts(bars: readonly Bar[]): number {
  const ranges = bars.map((bar) => Math.max(DEFAULT_TICK_SIZE, bar.high - bar.low));
  const averageRange = ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
  return Math.max(DEFAULT_TICK_SIZE, averageRange / 2);
}

function exponentialMovingAverage(values: readonly number[], period: number): number {
  const smoothing = 2 / (period + 1);
  let ema = values[0] ?? 0;
  for (const value of values.slice(1)) {
    ema = value * smoothing + ema * (1 - smoothing);
  }
  return ema;
}

function toTimeframe(barSpec: string): Bar['timeframe'] {
  switch (barSpec) {
    case '1m':
      return '1m';
    case '5m':
      return '5m';
    case '15m':
      return '15m';
    case '1h':
      return '60m';
    case '1d':
      return '1d';
    default:
      return '1m';
  }
}

function toSafeNumber(value: bigint, path: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) {
    throw new Error(`${path} cannot be represented as a safe integer number for replay sanity`);
  }
  return converted;
}

function roundToTick(value: number, tickSize: number): number {
  return round4(Math.round(value / tickSize) * tickSize);
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
