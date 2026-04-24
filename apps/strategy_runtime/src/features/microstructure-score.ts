import type { SetupFamily } from '../contracts/candidate.js';
import type { LobSnapshot } from '../contracts/market.js';
import { getSetupFamily } from '../management/management-profiles.js';

interface ComponentResult {
  score: number;
  hasData: boolean;
  reason: string | null;
}

export interface MicrostructureScoreResult {
  total: number;
  directional: number;
  imbalance: number;
  absorption: number;
  queue: number;
  sweep: number;
  profile: number;
  microprice: number;
  reasons: string[];
  warnings: string[];
  data_quality: 'good' | 'partial' | 'minimal' | 'none';
  setup_family: SetupFamily;
  components_available: number;
}

export interface MicrostructureOverlayConfig {
  enabled: boolean;
  multiplier: number;
  max_positive_adj: number;
  max_negative_adj: number;
  require_min_data_quality: 'none' | 'minimal' | 'partial' | 'good';
}

export const DEFAULT_MICROSTRUCTURE_OVERLAY_CONFIG: MicrostructureOverlayConfig = {
  enabled: true,
  multiplier: 0.5,
  max_positive_adj: 0.8,
  max_negative_adj: 0.6,
  require_min_data_quality: 'minimal',
};

export interface MicroAdjustmentResult {
  adjustment: number;
  applied: boolean;
  base_confidence: number;
  final_confidence: number;
  reason: string;
}

export function computeMicroAdjustment(
  score: MicrostructureScoreResult,
  baseConfidence: number,
  config: MicrostructureOverlayConfig,
): MicroAdjustmentResult {
  const noOp: MicroAdjustmentResult = {
    adjustment: 0,
    applied: false,
    base_confidence: baseConfidence,
    final_confidence: baseConfidence,
    reason: 'no_adjustment',
  };
  if (!config.enabled || config.multiplier === 0) {
    return { ...noOp, reason: 'overlay_disabled_or_zero_multiplier' };
  }
  if (score.data_quality === 'none') {
    return { ...noOp, reason: 'no_lob_data' };
  }

  let rawAdj = score.total * config.multiplier;
  rawAdj = rawAdj > 0
    ? Math.min(rawAdj, config.max_positive_adj)
    : Math.max(rawAdj, -config.max_negative_adj);
  const adjustment = Math.round(rawAdj * 10) / 10;
  if (adjustment === 0) {
    return { ...noOp, reason: 'adjustment_rounds_to_zero' };
  }
  const final = Math.max(0, Math.min(10, Math.round((baseConfidence + adjustment) * 10) / 10));
  return {
    adjustment,
    applied: true,
    base_confidence: baseConfidence,
    final_confidence: final,
    reason: `micro:${adjustment > 0 ? '+' : ''}${adjustment.toFixed(1)}(raw=${score.total.toFixed(2)}x${config.multiplier})`,
  };
}

export function scoreDirectionalFlow(
  snap: LobSnapshot,
  direction: 'long' | 'short',
  family: SetupFamily,
): ComponentResult {
  const delta10 = snap.cumulative_delta_10s;
  const delta30 = snap.cumulative_delta_30s;
  const flowImbalance = snap.trade_flow_imbalance_10s;
  if (!available(delta10) && !available(delta30) && !available(flowImbalance)) {
    return { score: 0, hasData: false, reason: null };
  }

  const sign = direction === 'long' ? 1 : -1;
  let score = 0;

  if (available(flowImbalance)) {
    const flowBias = (flowImbalance - 0.5) * 2;
    score += clamp(flowBias * sign * 0.25, -0.25, 0.25);
  }
  if (available(delta10)) {
    score += Math.sign(delta10) * sign * 0.15;
  }
  if (family !== 'lob_mbo_scalp' && available(delta30) && available(delta10)) {
    const momentumBuilding = Math.abs(delta10) > Math.abs(delta30) * 0.6;
    if (momentumBuilding && Math.sign(delta10) === sign) score += 0.1;
  }

  const finalScore = clamp(round2(score), -0.5, 0.5);
  return {
    score: finalScore,
    hasData: true,
    reason: Math.abs(finalScore) >= 0.05 ? `directional:${finalScore > 0 ? '+' : ''}${finalScore.toFixed(2)}` : null,
  };
}

export function scoreBookImbalance(
  snap: LobSnapshot,
  direction: 'long' | 'short',
  _family: SetupFamily,
): ComponentResult {
  const depthImbalance = snap.depth_imbalance_5;
  const bid = snap.bid_size;
  const ask = snap.ask_size;
  if (!available(depthImbalance) && (!available(bid) || !available(ask))) {
    return { score: 0, hasData: false, reason: null };
  }

  const sign = direction === 'long' ? 1 : -1;
  let score = 0;
  if (available(depthImbalance)) {
    score += clamp(depthImbalance * sign * 0.25, -0.25, 0.25);
  }
  if (available(bid) && available(ask) && bid + ask > 0) {
    const bboSkew = (bid - ask) / (bid + ask);
    score += clamp(bboSkew * sign * 0.05, -0.05, 0.05);
  }
  const finalScore = clamp(round2(score), -0.3, 0.3);
  return {
    score: finalScore,
    hasData: true,
    reason: Math.abs(finalScore) >= 0.05 ? `imbalance:${finalScore > 0 ? '+' : ''}${finalScore.toFixed(2)}` : null,
  };
}

export function scoreQueuePressure(
  snap: LobSnapshot,
  direction: 'long' | 'short',
  _family: SetupFamily,
): ComponentResult {
  const queue = snap.queue_imbalance_5;
  const cancelAddRatio = snap.cancel_add_ratio_10s;
  const replenish = snap.replenishment_ratio_10s;
  if (!available(queue) && !available(cancelAddRatio) && !available(replenish)) {
    return { score: 0, hasData: false, reason: null };
  }

  const sign = direction === 'long' ? 1 : -1;
  let score = 0;
  if (available(queue)) {
    score += clamp(queue * sign * 0.2, -0.2, 0.2);
  }
  if (available(cancelAddRatio) && cancelAddRatio > 2.0) {
    score -= clamp((cancelAddRatio - 1.5) * 0.05, 0, 0.1);
  }
  if (available(replenish) && replenish > 1.0) {
    score += 0.05;
  }

  const finalScore = clamp(round2(score), -0.3, 0.3);
  return {
    score: finalScore,
    hasData: true,
    reason: Math.abs(finalScore) >= 0.05 ? `queue:${finalScore > 0 ? '+' : ''}${finalScore.toFixed(2)}` : null,
  };
}

function scoreSweepBehavior(
  snap: LobSnapshot,
  direction: 'long' | 'short',
  _family: SetupFamily,
): ComponentResult {
  const sweepCount = snap.sweep_count_10s;
  const sweepVolume = snap.sweep_volume_10s;
  const lastSweepSide = snap.last_sweep_side;
  if (!available(sweepCount) && !lastSweepSide) {
    return { score: 0, hasData: false, reason: null };
  }
  if (!available(sweepCount) || sweepCount <= 0 || !lastSweepSide || lastSweepSide === 'unknown') {
    return { score: 0, hasData: true, reason: null };
  }

  const aligned =
    (direction === 'long' && lastSweepSide === 'buy') ||
    (direction === 'short' && lastSweepSide === 'sell');
  const magnitude = available(sweepVolume) ? Math.min(0.2, sweepVolume / 1000) : 0.1;
  const score = round2(aligned ? magnitude : -magnitude);
  return {
    score,
    hasData: true,
    reason: Math.abs(score) >= 0.05 ? `sweep:${score > 0 ? '+' : ''}${score.toFixed(2)}` : null,
  };
}

function scoreVolumeProfile(
  snap: LobSnapshot,
  _direction: 'long' | 'short',
  _family: SetupFamily,
): ComponentResult {
  const insideValueArea = snap.inside_value_area;
  const distPoc = snap.distance_from_poc_pts;
  if (insideValueArea == null && !available(distPoc)) {
    return { score: 0, hasData: false, reason: null };
  }

  let score = 0;
  if (insideValueArea === true) score += 0.1;
  if (available(distPoc)) {
    if (Math.abs(distPoc) <= 1.0) score += 0.05;
    if (Math.abs(distPoc) >= 6.0) score -= 0.05;
  }
  const finalScore = clamp(round2(score), -0.2, 0.2);
  return {
    score: finalScore,
    hasData: true,
    reason: Math.abs(finalScore) >= 0.05 ? `profile:${finalScore > 0 ? '+' : ''}${finalScore.toFixed(2)}` : null,
  };
}

export function scoreMicropriceEdge(
  snap: LobSnapshot,
  direction: 'long' | 'short',
  cap: number = 0.5,
): ComponentResult {
  if (!available(snap.bid) || !available(snap.ask) || !available(snap.bid_size) || !available(snap.ask_size)
    || snap.bid_size + snap.ask_size === 0) {
    return { score: 0, hasData: false, reason: null };
  }
  const microprice = (snap.ask * snap.bid_size + snap.bid * snap.ask_size) / (snap.bid_size + snap.ask_size);
  const mid = (snap.bid + snap.ask) / 2;
  const tickSize = 0.25;
  const edgeTicks = (microprice - mid) / tickSize;
  const sign = direction === 'long' ? 1 : -1;
  const score = clamp(round2(edgeTicks * sign * 0.12), -cap, cap);
  return {
    score,
    hasData: true,
    reason: Math.abs(score) >= 0.05 ? `microprice:${score > 0 ? '+' : ''}${score.toFixed(2)}(edge=${edgeTicks.toFixed(1)}t)` : null,
  };
}

export function computeMicrostructureScore(
  snap: LobSnapshot | null | undefined,
  direction: 'long' | 'short',
  setupType: string,
  config: MicrostructureOverlayConfig = DEFAULT_MICROSTRUCTURE_OVERLAY_CONFIG,
): MicrostructureScoreResult {
  const family = getSetupFamily(setupType as never);
  const empty: MicrostructureScoreResult = {
    total: 0,
    directional: 0,
    imbalance: 0,
    absorption: 0,
    queue: 0,
    sweep: 0,
    profile: 0,
    microprice: 0,
    reasons: [],
    warnings: [],
    data_quality: 'none',
    setup_family: family,
    components_available: 0,
  };

  if (!config.enabled) {
    return { ...empty, warnings: ['overlay_disabled'] };
  }
  if (!snap || snap.data_quality === 'unavailable' || snap.bbo_age_ms > 5000) {
    return { ...empty, warnings: ['no_lob_data'] };
  }

  const directional = scoreDirectionalFlow(snap, direction, family);
  const imbalance = scoreBookImbalance(snap, direction, family);
  const queue = scoreQueuePressure(snap, direction, family);
  const sweep = scoreSweepBehavior(snap, direction, family);
  const profile = scoreVolumeProfile(snap, direction, family);
  const microprice = scoreMicropriceEdge(snap, direction);
  const absorption: ComponentResult = {
    score: available(snap.replenishment_ratio_10s) && snap.replenishment_ratio_10s > 1 ? 0.05 : 0,
    hasData: available(snap.replenishment_ratio_10s),
    reason: available(snap.replenishment_ratio_10s) && snap.replenishment_ratio_10s > 1 ? 'absorption:+0.05' : null,
  };

  const components = [directional, imbalance, absorption, queue, sweep, profile, microprice];
  const componentsAvailable = components.filter((component) => component.hasData).length;
  const dataQuality = assessDataQuality(componentsAvailable);
  if (!meetsMinQuality(dataQuality, config.require_min_data_quality)) {
    return {
      ...empty,
      data_quality: dataQuality,
      components_available: componentsAvailable,
      warnings: [`insufficient_data_quality:${dataQuality}<${config.require_min_data_quality}`],
    };
  }

  const total = clamp(round2(
    directional.score
      + imbalance.score
      + absorption.score
      + queue.score
      + sweep.score
      + profile.score
      + microprice.score,
  ), -2, 2);

  return {
    total,
    directional: directional.score,
    imbalance: imbalance.score,
    absorption: absorption.score,
    queue: queue.score,
    sweep: sweep.score,
    profile: profile.score,
    microprice: microprice.score,
    reasons: components.flatMap((component) => (component.reason ? [component.reason] : [])),
    warnings: componentsAvailable < 3 ? [`sparse_data:${componentsAvailable}/7_components`] : [],
    data_quality: dataQuality,
    setup_family: family,
    components_available: componentsAvailable,
  };
}

function available(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function assessDataQuality(count: number): 'good' | 'partial' | 'minimal' | 'none' {
  if (count >= 4) return 'good';
  if (count >= 2) return 'partial';
  if (count >= 1) return 'minimal';
  return 'none';
}

function meetsMinQuality(
  quality: 'good' | 'partial' | 'minimal' | 'none',
  required: 'none' | 'minimal' | 'partial' | 'good',
): boolean {
  const rank = { none: 0, minimal: 1, partial: 2, good: 3 };
  return rank[quality] >= rank[required];
}
