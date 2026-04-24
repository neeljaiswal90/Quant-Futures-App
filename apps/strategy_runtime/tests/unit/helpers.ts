import type { IndicatorConfig } from '../../src/contracts/config.js';
import type { IndicatorSnapshot, KeyLevels, MarketSnapshot, OhlcvBar } from '../../src/contracts/market.js';
import { DEFAULT_POSITION_TARGET_CONFIG } from '../../src/management/target-position.js';
import { computeIndicators } from '../../src/features/indicators.js';

export function makeBar(
  close: number,
  index = 0,
  high = close + 1,
  low = close - 1,
  volume = 100,
): OhlcvBar {
  return {
    time: 1_700_000_000 + index * 60,
    open: close - 0.5,
    high,
    low,
    close,
    volume,
  };
}

export function makeBars(closes: number[]): OhlcvBar[] {
  return closes.map((close, index) => makeBar(close, index));
}

export function aggregateBars(source: OhlcvBar[], width: number): OhlcvBar[] {
  const out: OhlcvBar[] = [];
  for (let start = 0; start < source.length; start += width) {
    const chunk = source.slice(start, start + width);
    if (chunk.length === 0) continue;
    out.push({
      time: chunk[0]!.time,
      open: chunk[0]!.open,
      high: Math.max(...chunk.map((bar) => bar.high)),
      low: Math.min(...chunk.map((bar) => bar.low)),
      close: chunk[chunk.length - 1]!.close,
      volume: chunk.reduce((sum, bar) => sum + bar.volume, 0),
    });
  }
  return out;
}

export function makeKeyLevels(overrides: Partial<KeyLevels> = {}): KeyLevels {
  return {
    daily_open: 20_000,
    weekly_open: 19_960,
    session_high: 20_120,
    session_low: 19_900,
    opening_range_high: 20_030,
    opening_range_low: 19_980,
    prior_rth_high: 20_150,
    prior_rth_low: 19_880,
    bos_buy: 20_010,
    bos_sell: 19_995,
    choch_buy: 19_980,
    choch_sell: 20_040,
    pivot_resistance: [20_080, 20_140],
    pivot_support: [19_940, 19_900],
    ...overrides,
  };
}

export function makeIndicators(
  bars1m: OhlcvBar[],
  overrides: Partial<IndicatorSnapshot> = {},
): IndicatorSnapshot {
  const computed = computeIndicators(bars1m);
  return {
    ema_9: computed.ema_9,
    ema_21: computed.ema_21,
    ema_50: computed.ema_50,
    ema_200: computed.ema_200,
    rsi_14: computed.rsi_14,
    atr_14: computed.atr_14,
    vwap: computed.vwap,
    adx: computed.adx,
    di_plus: computed.di_plus,
    di_minus: computed.di_minus,
    volume_sma_20: computed.volume_sma_20,
    supertrend_direction: computed.supertrend_direction,
    ttm_squeeze_firing: false,
    smart_money_bos_buy: 20_010,
    smart_money_bos_sell: 19_995,
    smart_money_choch_buy: 19_980,
    smart_money_choch_sell: 20_040,
    ...overrides,
  };
}

export function makeSnapshot(options: {
  bars1m?: OhlcvBar[];
  bars5m?: OhlcvBar[];
  indicators?: Partial<IndicatorSnapshot>;
  keyLevels?: Partial<KeyLevels>;
  price?: number;
  symbol?: string;
  isRth?: boolean;
  isEth?: boolean;
  sessionBucket?: string | null;
} = {}): MarketSnapshot {
  const bars1m = options.bars1m ?? makeBars(Array.from({ length: 80 }, (_, index) => 20_000 + index * 1.5));
  const bars5m = options.bars5m ?? aggregateBars(bars1m, 5);
  const indicators = makeIndicators(bars1m, options.indicators);
  return {
    symbol: options.symbol ?? 'MNQ1!',
    timestamp_unix: bars1m[bars1m.length - 1]!.time,
    price: options.price ?? bars1m[bars1m.length - 1]!.close,
    bars_1m: bars1m,
    bars_5m: bars5m,
    bars_15m: aggregateBars(bars1m, 15),
    indicators_1m: indicators,
    key_levels: makeKeyLevels(options.keyLevels),
    session: {
      is_rth: options.isRth ?? true,
      is_eth: options.isEth ?? false,
      strategy_bucket: options.sessionBucket ?? 'NY_AM',
    },
  };
}

export function makeConfig(overrides: Partial<IndicatorConfig> = {}): IndicatorConfig {
  return {
    version: 'TEST',
    type: 'BASELINE',
    created_at: '2026-01-01T00:00:00Z',
    ema_fast: 9,
    ema_mid: 21,
    ema_slow: 50,
    rsi_period: 14,
    atr_period: 14,
    volume_sma_period: 20,
    min_confidence: 7.5,
    max_confidence: 10,
    min_rr: 1.6,
    max_risk_per_trade_pct: 0.5,
    max_daily_loss_pct: 2,
    max_consecutive_losses: 4,
    account_equity: 25_000,
    time_stop_minutes: 30,
    time_stop_max_r_pre_t1: 0.25,
    time_stop_max_r_post_t1: 1,
    analysis_interval_seconds: 20,
    in_position_monitor_seconds: 2,
    opening_range_minutes: 15,
    trail_ticks_post_t1: 12,
    breakeven_trigger_r: 0.5,
    pre_t1_trail_trigger_r: 0.75,
    pre_t1_trail_distance_ticks: 20,
    pt1_offset_pts: 6,
    pt2_offset_pts: 15,
    pt1_exit_fraction: 0.5,
    pt2_exit_fraction: 0.25,
    pt1_move_to_be: true,
    pt1_activate_trailing: true,
    enable_momentum_continuation: false,
    enable_opening_drive: false,
    enable_failed_or_break: false,
    dual_min_score: 7.5,
    dual_score_margin: 1,
    dual_choppy_extra_margin: 0.5,
    cooldown_bars: 3,
    no_same_bar_reversal: true,
    position_target: DEFAULT_POSITION_TARGET_CONFIG,
    ...overrides,
  };
}
