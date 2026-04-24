import type { ManagementFeatures, ProbabilityModel, TradePoP } from './types.js';

const MIN_POP = 0.1;
const MAX_POP = 0.92;

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function countAvailableContext(features: ManagementFeatures): number {
  let available = 0;
  if (features.atr_14 !== null) available++;
  if (features.adx !== null) available++;
  if (features.di_plus !== null && features.di_minus !== null) available++;
  if (features.vwap_distance_pts !== null) available++;
  if (features.cvd_trend !== null) available++;
  if (features.ema_alignment !== null) available++;
  if (features.regime !== null) available++;
  return available;
}

export class RulesProbabilityEngine implements ProbabilityModel {
  readonly name = 'rules_v1';
  readonly version = '1.0.0';

  computePoP(features: ManagementFeatures): TradePoP {
    const available = countAvailableContext(features);
    const confidence_in_estimate: TradePoP['confidence_in_estimate'] =
      available >= 5 ? 'high' : available >= 3 ? 'medium' : 'low';

    return {
      pop_target1_before_stop: round2(this.computePopT1(features)),
      pop_target2_before_stop: round2(this.computePopT2(features)),
      pop_runner_extension: round2(this.computePopRunner(features)),
      model_name: this.name,
      model_version: this.version,
      confidence_in_estimate,
    };
  }

  private computePopT1(features: ManagementFeatures): number {
    if (features.partial_exit_done || features.pt1_done || features.distance_to_t1_pts <= 0) return 1;
    if (features.distance_to_stop_pts <= 0) return 0;

    const t1Dist = Math.max(features.distance_to_t1_pts, 0.01);
    const stopDist = Math.max(features.distance_to_stop_pts, 0.01);
    const geometricRatio = stopDist / (stopDist + t1Dist);
    let score = (geometricRatio - 0.5) * 4;

    if (features.current_r >= 0.75) score += 0.5;
    else if (features.current_r >= 0.3) score += 0.25;
    else if (features.current_r <= -0.3) score -= 0.5;

    if (features.mfe_r >= 0.7) score += 0.25;

    if (features.adx !== null) {
      if (features.adx >= 30) score += 0.5;
      else if (features.adx >= 22) score += 0.25;
      else if (features.adx < 15) score -= 0.4;
    }

    if (features.di_plus !== null && features.di_minus !== null) {
      const aligned =
        (features.side === 'long' && features.di_plus > features.di_minus) ||
        (features.side === 'short' && features.di_minus > features.di_plus);
      score += aligned ? 0.35 : -0.3;
    }

    if (features.vwap_distance_pts !== null) score += features.vwap_distance_pts > 0 ? 0.2 : -0.2;

    if (features.cvd_trend !== null) {
      const aligned =
        (features.side === 'long' && features.cvd_trend === 'up') ||
        (features.side === 'short' && features.cvd_trend === 'down');
      score += aligned ? 0.25 : -0.2;
    }

    if (features.ema_alignment !== null) {
      if (
        (features.side === 'long' && features.ema_alignment === 'bullish') ||
        (features.side === 'short' && features.ema_alignment === 'bearish')
      ) {
        score += 0.3;
      } else if (
        (features.side === 'long' && features.ema_alignment === 'bearish') ||
        (features.side === 'short' && features.ema_alignment === 'bullish')
      ) {
        score -= 0.4;
      }
    }

    if (features.regime !== null) {
      if (
        (features.side === 'long' && features.regime === 'trending_up') ||
        (features.side === 'short' && features.regime === 'trending_down')
      ) {
        score += 0.4;
      } else if (features.regime === 'choppy' || features.regime === 'high_volatility_impulse') {
        score -= 0.4;
      } else if (
        (features.side === 'long' && features.regime === 'trending_down') ||
        (features.side === 'short' && features.regime === 'trending_up')
      ) {
        score -= 0.6;
      }
    }

    if (features.ttm_squeeze_firing === true) score -= 0.2;
    if (features.rsi_14 !== null) {
      if (features.side === 'long' && features.rsi_14 > 75) score -= 0.25;
      if (features.side === 'short' && features.rsi_14 < 25) score -= 0.25;
    }

    return clamp(sigmoid(score), MIN_POP, MAX_POP);
  }

  private computePopT2(features: ManagementFeatures): number {
    if (features.distance_to_t2_pts <= 0) return 1;
    if (features.distance_to_stop_pts <= 0) return 0;

    const popT1 = this.computePopT1(features);
    const t2Dist = Math.max(features.distance_to_t2_pts, 0.01);
    const t1Dist = Math.max(features.distance_to_t1_pts, 0.01);
    const remainingToT2 = Math.max(t2Dist - t1Dist, 0.01);
    const beStopDistance = t1Dist;
    const ratio = beStopDistance / (beStopDistance + remainingToT2);
    let conditionalScore = (ratio - 0.5) * 3;

    if (features.adx !== null && features.adx >= 30) conditionalScore += 0.4;
    if (features.regime !== null) {
      if (
        (features.side === 'long' && features.regime === 'trending_up') ||
        (features.side === 'short' && features.regime === 'trending_down')
      ) {
        conditionalScore += 0.35;
      } else if (features.regime === 'choppy') {
        conditionalScore -= 0.35;
      }
    }
    if (features.cvd_trend !== null) {
      const aligned =
        (features.side === 'long' && features.cvd_trend === 'up') ||
        (features.side === 'short' && features.cvd_trend === 'down');
      conditionalScore += aligned ? 0.2 : -0.15;
    }

    const popT2GivenT1 = clamp(sigmoid(conditionalScore), MIN_POP, MAX_POP);
    const effectivePopT1 = features.partial_exit_done || features.pt1_done ? 1 : popT1;
    return clamp(effectivePopT1 * popT2GivenT1, MIN_POP, MAX_POP);
  }

  private computePopRunner(features: ManagementFeatures): number {
    if (features.distance_to_stop_pts <= 0) return 0;
    let score = -0.5;

    if (features.adx !== null) {
      if (features.adx >= 35) score += 0.8;
      else if (features.adx >= 28) score += 0.5;
      else if (features.adx >= 22) score += 0.2;
    }

    if (features.regime !== null) {
      if (
        (features.side === 'long' && features.regime === 'trending_up') ||
        (features.side === 'short' && features.regime === 'trending_down')
      ) {
        score += 0.5;
      } else if (features.regime === 'choppy' || features.regime === 'range_bound') {
        score -= 0.5;
      }
    }

    if (features.mfe_r >= 1.5) score += 0.3;
    else if (features.mfe_r >= 1.0) score += 0.15;

    if (
      (features.side === 'long' && features.ema_alignment === 'bullish') ||
      (features.side === 'short' && features.ema_alignment === 'bearish')
    ) {
      score += 0.25;
    }

    if (features.cvd_trend !== null) {
      const aligned =
        (features.side === 'long' && features.cvd_trend === 'up') ||
        (features.side === 'short' && features.cvd_trend === 'down');
      score += aligned ? 0.2 : -0.2;
    }

    return clamp(sigmoid(score), MIN_POP, 0.75);
  }
}
