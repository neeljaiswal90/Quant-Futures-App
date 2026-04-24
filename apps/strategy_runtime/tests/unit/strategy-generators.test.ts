import { describe, expect, it } from 'vitest';
import { genBreakdownRetestShort } from '../../src/strategies/breakdown_retest_short.js';
import { genBreakoutRetestLong } from '../../src/strategies/breakout_retest_long.js';
import { genTrendPullbackLong } from '../../src/strategies/trend_pullback_long.js';
import { genTrendPullbackShort } from '../../src/strategies/trend_pullback_short.js';
import { makeConfig, makeSnapshot, aggregateBars, makeBar } from './helpers.js';

const config = makeConfig();

describe('Active strategy generators', () => {
  it('emits a trend_pullback_long candidate on a fresh bullish pullback', () => {
    const closes = Array.from({ length: 80 }, (_, index) => 20_000 + index * 0.8);
    closes[closes.length - 1] = closes[closes.length - 2]! - 3;
    const bars1m = closes.map((close, index) => makeBar(close, index, close + 2, close - 2, 120));
    const bars5m = aggregateBars(bars1m, 5);
    const snap = makeSnapshot({
      bars1m,
      bars5m,
      price: bars1m[bars1m.length - 1]!.close,
      indicators: {
        supertrend_direction: 'up',
        ema_9: bars1m[bars1m.length - 1]!.close - 2,
        ema_21: bars1m[bars1m.length - 1]!.close - 6,
        ema_50: bars1m[bars1m.length - 1]!.close - 12,
        vwap: bars1m[bars1m.length - 1]!.close - 10,
        atr_14: 8,
        smart_money_choch_sell: bars1m[bars1m.length - 1]!.close + 12,
      },
      keyLevels: { pivot_resistance: [bars1m[bars1m.length - 1]!.close + 20, bars1m[bars1m.length - 1]!.close + 40] },
    });
    const result = genTrendPullbackLong(snap, null, config);
    expect(result.candidate?.setup_type).toBe('trend_pullback_long');
  });

  it('emits a trend_pullback_short candidate on a fresh bearish pullback', () => {
    const closes = Array.from({ length: 80 }, (_, index) => 20_150 - index * 0.8);
    closes[closes.length - 1] = closes[closes.length - 2]! + 3;
    const bars1m = closes.map((close, index) => makeBar(close, index, close + 2, close - 2, 120));
    const bars5m = aggregateBars(bars1m, 5);
    const snap = makeSnapshot({
      bars1m,
      bars5m,
      price: bars1m[bars1m.length - 1]!.close,
      indicators: {
        supertrend_direction: 'down',
        ema_9: bars1m[bars1m.length - 1]!.close + 2,
        ema_21: bars1m[bars1m.length - 1]!.close + 6,
        ema_50: bars1m[bars1m.length - 1]!.close + 12,
        vwap: bars1m[bars1m.length - 1]!.close - 4,
        atr_14: 8,
        smart_money_choch_buy: bars1m[bars1m.length - 1]!.close - 12,
      },
      keyLevels: { pivot_support: [bars1m[bars1m.length - 1]!.close - 20, bars1m[bars1m.length - 1]!.close - 40] },
      isEth: true,
    });
    const result = genTrendPullbackShort(snap, null, config);
    expect(result.candidate?.setup_type).toBe('trend_pullback_short');
  });

  it('emits a breakout_retest_long candidate when price is riding above the EMA stack', () => {
    const snap = makeSnapshot({
      price: 20_040,
      indicators: {
        supertrend_direction: 'up',
        ema_9: 20_035,
        ema_21: 20_025,
        ema_50: 20_010,
        atr_14: 7,
        vwap: 20_000,
      },
      keyLevels: { pivot_resistance: [20_070, 20_110] },
    });
    const result = genBreakoutRetestLong(snap, null, config);
    expect(result.candidate?.setup_type).toBe('breakout_retest_long');
  });

  it('emits a breakdown_retest_short candidate around a broken support zone', () => {
    const snap = makeSnapshot({
      price: 19_995,
      indicators: {
        supertrend_direction: 'down',
        ema_9: 20_005,
        ema_21: 20_015,
        ema_50: 20_030,
        atr_14: 7,
        smart_money_bos_sell: 20_010,
        smart_money_choch_sell: 20_020,
        smart_money_choch_buy: 19_960,
      },
      keyLevels: {
        bos_sell: 20_010,
        choch_sell: 20_020,
        choch_buy: 19_960,
        pivot_support: [19_930, 19_900],
      },
    });
    const result = genBreakdownRetestShort(snap, null, config);
    expect(result.candidate?.setup_type).toBe('breakdown_retest_short');
  });
});
