import type { FreshnessResult, MarketRegime, SetupType } from '../../contracts/candidate.js';
import type { IndicatorConfig } from '../../contracts/config.js';
import type { MarketSnapshot } from '../../contracts/market.js';
import { computeNormalizers } from '../../features/normalization.js';

export function classifyRegime(snap: MarketSnapshot): MarketRegime {
  const { price, indicators_1m: ind } = snap;
  const ema9 = ind.ema_9;
  const ema21 = ind.ema_21;
  const ema50 = ind.ema_50;
  const adx = ind.adx ?? 0;
  const direction = ind.supertrend_direction;

  const aboveAll = ema9 !== null && ema21 !== null && ema50 !== null
    && price > ema9 && ema9 > ema21 && ema21 > ema50;
  const belowAll = ema9 !== null && ema21 !== null && ema50 !== null
    && price < ema9 && ema9 < ema21 && ema21 < ema50;

  if ((ind.ttm_squeeze_firing ?? false) === true) return 'compression';
  if (aboveAll && direction === 'up') return 'trending_up';
  if (belowAll && direction === 'down') return 'trending_down';
  if (adx > 28 && direction === 'up') return 'strong_trend';
  if (adx > 28 && direction === 'down') return 'strong_trend';

  const recent = snap.bars_1m.slice(-8);
  const changes = recent
    .map((bar) => Math.sign(bar.close - bar.open))
    .filter((value, index, values) => index > 0 && value !== 0 && value !== values[index - 1])
    .length;
  if (changes >= 4) return 'choppy';
  return 'range_bound';
}

export function isTrendFresh(
  snap: MarketSnapshot,
  direction: 'long' | 'short',
  config: IndicatorConfig,
  setupType: SetupType,
): FreshnessResult {
  const isLong = direction === 'long';
  const bars5m = snap.bars_5m;
  const ind = snap.indicators_1m;
  const ema21 = ind.ema_21;

  if (bars5m.length >= 6) {
    const recent3 = bars5m.slice(-3);
    const prior3 = bars5m.slice(-6, -3);
    if (isLong) {
      const recentMinLow = Math.min(...recent3.map((bar) => bar.low));
      const priorMinLow = Math.min(...prior3.map((bar) => bar.low));
      if (recentMinLow <= priorMinLow) {
        return { fresh: false, reason: 'stale_uptrend:lower_lows_on_5m' };
      }
    } else {
      const recentMaxHigh = Math.max(...recent3.map((bar) => bar.high));
      const priorMaxHigh = Math.max(...prior3.map((bar) => bar.high));
      if (recentMaxHigh >= priorMaxHigh) {
        return { fresh: false, reason: 'stale_downtrend:higher_highs_on_5m' };
      }
    }
  }

  if (isLong && ind.supertrend_direction === 'down' && ema21 !== null && snap.price < ema21) {
    return { fresh: false, reason: 'stale_uptrend:supertrend_down_below_ema21' };
  }
  if (!isLong && ind.supertrend_direction === 'up' && ema21 !== null && snap.price > ema21) {
    return { fresh: false, reason: 'stale_downtrend:supertrend_up_above_ema21' };
  }

  const vwap = ind.vwap;
  if (vwap !== null && vwap > 0) {
    if (isLong && snap.price < vwap) {
      return { fresh: false, reason: 'stale_uptrend:price_below_vwap' };
    }
    if (!isLong && snap.price > vwap) {
      const norms = computeNormalizers(snap);
      const sessionAtr = norms?.session_atr ?? ind.atr_14 ?? null;
      const vwapDistanceSession = sessionAtr && sessionAtr > 0
        ? Math.abs(snap.price - vwap) / sessionAtr
        : null;
      const shortSoftAllowance =
        snap.session?.is_eth === true &&
        setupType === 'trend_pullback_short' &&
        vwapDistanceSession !== null &&
        vwapDistanceSession <= 0.35;
      if (!shortSoftAllowance) {
        return { fresh: false, reason: 'stale_downtrend:price_above_vwap' };
      }
      return { fresh: true, reason: 'trend_fresh_soft_vwap_short' };
    }
  }

  void config;
  return { fresh: true, reason: 'trend_fresh' };
}
