import type { CandidateSetup, MarketRegime, SetupFamily } from '../contracts/candidate.js';
import type { IndicatorConfig } from '../contracts/config.js';
import type { MarketSnapshot } from '../contracts/market.js';
import { getSetupFamily, getManagementProfile, resolveProfile } from '../management/management-profiles.js';
import type { ExtensionFeatures } from './extension.js';
import type { MicrostructureScoreResult } from './microstructure-score.js';
import { getContractSpec } from '../risk/contracts.js';

export interface DynamicRewardPlan {
  dynamic_min_rr: number;
  rr_gate_pass: boolean;
  rr_base: number;
  rr_regime_adj: number;
  rr_structure_adj: number;
  rr_micro_adj: number;
  rr_components: string[];
  mgmt_pt1_offset_pts: number;
  mgmt_pt2_offset_pts: number;
  mgmt_pt1_implied_rr: number;
  quality_band: 'high' | 'standard' | 'marginal';
  setup_family: SetupFamily;
}

export interface DynamicRewardConfig {
  enabled: boolean;
  family_baselines: Record<string, number>;
  regime_adjustments: Record<string, number>;
  rr_floor: number;
  rr_ceiling: number;
  micro_weight: number;
}

export const DEFAULT_DYNAMIC_REWARD_CONFIG: DynamicRewardConfig = {
  enabled: true,
  family_baselines: {
    trend_pullback: 1.6,
    breakout_retest: 1.7,
    momentum_continuation: 1.7,
    opening_drive: 1.5,
    or_retest: 1.5,
    failed_or_break: 1.8,
    default: 1.8,
  },
  regime_adjustments: {
    trending_up: -0.1,
    trending_down: -0.1,
    choppy: 0.3,
    range_bound: 0.2,
    compression: 0.1,
    high_volatility_impulse: 0.2,
  },
  rr_floor: 1.3,
  rr_ceiling: 3.0,
  micro_weight: 0.15,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function computeStructureAdj(
  extension: ExtensionFeatures | null | undefined,
  direction: 'long' | 'short',
): { adj: number; reasons: string[] } {
  if (!extension) return { adj: 0, reasons: [] };

  let adj = 0;
  const reasons: string[] = [];

  if (extension.reset_occurred) {
    adj -= 0.1;
    reasons.push('reset_occurred(-0.1)');
  } else if (extension.no_reset_extension) {
    adj += 0.15;
    reasons.push('no_reset(+0.15)');
  }

  if (extension.current_impulse_atr !== null && extension.current_impulse_atr > 3.0) {
    adj += 0.15;
    reasons.push(`impulse_mature(+0.15,${extension.current_impulse_atr.toFixed(1)}ATR)`);
  } else if (extension.current_impulse_atr !== null && extension.current_impulse_atr < 1.5) {
    adj -= 0.05;
    reasons.push('impulse_fresh(-0.05)');
  }

  const roomAtr = direction === 'long' ? extension.upside_room_atr : extension.downside_room_atr;
  if (roomAtr !== null && roomAtr > 2.0) {
    adj -= 0.1;
    reasons.push(`good_room(-0.1,${roomAtr.toFixed(1)}ATR)`);
  } else if (roomAtr !== null && roomAtr < 1.0) {
    adj += 0.15;
    reasons.push(`tight_room(+0.15,${roomAtr.toFixed(1)}ATR)`);
  }

  if (extension.last_3_bar_return_atr !== null && extension.last_3_bar_return_atr > 2.0) {
    adj += 0.1;
    reasons.push(`fast_move(+0.1,${extension.last_3_bar_return_atr.toFixed(1)}ATR)`);
  }

  if (extension.consecutive_push_bars > 6) {
    adj += 0.1;
    reasons.push(`push_bars(+0.1,${extension.consecutive_push_bars})`);
  }

  return { adj: round2(clamp(adj, -0.3, 0.4)), reasons };
}

function resolvePtOffsets(
  setupType: CandidateSetup['setup_type'],
  regime: MarketRegime,
  atr: number | null,
  symbol: string,
  config: IndicatorConfig,
): { pt1_offset_pts: number; pt2_offset_pts: number } {
  const profile = getManagementProfile(setupType, regime, config);
  const contract = getContractSpec(symbol);
  const resolved = resolveProfile(profile, atr, contract);
  return {
    pt1_offset_pts: round2(resolved.pt1_offset_pts),
    pt2_offset_pts: round2(resolved.pt2_offset_pts),
  };
}

function classifyQuality(
  dynamicMinRr: number,
  actualRr: number,
  structureAdj: number,
): 'high' | 'standard' | 'marginal' {
  const headroom = actualRr - dynamicMinRr;
  if (headroom >= 0.5 && structureAdj <= 0) return 'high';
  if (headroom >= 0) return 'standard';
  return 'marginal';
}

export function buildDynamicRewardPlan(
  setup: CandidateSetup,
  snap: MarketSnapshot,
  regime: MarketRegime,
  config: IndicatorConfig,
  extension?: ExtensionFeatures | null,
  microScore?: MicrostructureScoreResult | null,
  dynamicConfig: DynamicRewardConfig = DEFAULT_DYNAMIC_REWARD_CONFIG,
): DynamicRewardPlan {
  const family = getSetupFamily(setup.setup_type);
  const rrBase = dynamicConfig.family_baselines[family] ?? dynamicConfig.family_baselines.default ?? 1.8;
  const rrRegimeAdj = dynamicConfig.regime_adjustments[regime] ?? 0;
  const structure = computeStructureAdj(extension, setup.direction);
  let rrMicroAdj = 0;
  if (microScore && dynamicConfig.micro_weight > 0 && microScore.data_quality !== 'none') {
    rrMicroAdj = round2(-microScore.total * dynamicConfig.micro_weight);
  }

  const dynamicMinRr = round2(clamp(
    rrBase + rrRegimeAdj + structure.adj + rrMicroAdj,
    dynamicConfig.rr_floor,
    dynamicConfig.rr_ceiling,
  ));
  const atr = snap.indicators_1m?.atr_14 ?? null;
  const pt = resolvePtOffsets(setup.setup_type, regime, atr, snap.symbol, config);
  const rrComponents = [`base:${rrBase}(${family})`];
  if (rrRegimeAdj !== 0) rrComponents.push(`regime:${rrRegimeAdj > 0 ? '+' : ''}${rrRegimeAdj}(${regime})`);
  if (structure.adj !== 0) rrComponents.push(...structure.reasons);
  if (rrMicroAdj !== 0) rrComponents.push(`micro:${rrMicroAdj > 0 ? '+' : ''}${rrMicroAdj}`);
  rrComponents.push(`->${dynamicMinRr}(actual=${setup.rr_t1}${setup.rr_t1 >= dynamicMinRr ? 'pass' : 'fail'})`);

  return {
    dynamic_min_rr: dynamicMinRr,
    rr_gate_pass: setup.rr_t1 >= dynamicMinRr,
    rr_base: rrBase,
    rr_regime_adj: rrRegimeAdj,
    rr_structure_adj: structure.adj,
    rr_micro_adj: rrMicroAdj,
    rr_components: rrComponents,
    mgmt_pt1_offset_pts: pt.pt1_offset_pts,
    mgmt_pt2_offset_pts: pt.pt2_offset_pts,
    mgmt_pt1_implied_rr: setup.risk_pts > 0 ? round2(pt.pt1_offset_pts / setup.risk_pts) : 0,
    quality_band: classifyQuality(dynamicMinRr, setup.rr_t1, structure.adj),
    setup_family: family,
  };
}

export const QUANT_COLD_START_TP1_K = 0.7;
export const QUANT_COLD_START_TP2_K = 1.4;

export interface QuantColdStartTargets {
  target_1_quant: number;
  target_2_quant: number;
  bucket_source_quant: 'cold_start';
}

export function computeQuantColdStartTargets(
  entry: number,
  sigmaPts: number,
  direction: 'long' | 'short',
  tickSize: number,
): QuantColdStartTargets {
  if (!(sigmaPts > 0)) throw new Error('computeQuantColdStartTargets: sigmaPts must be > 0');
  if (!(tickSize > 0)) throw new Error('computeQuantColdStartTargets: tickSize must be > 0');
  const sign = direction === 'long' ? 1 : -1;
  return {
    target_1_quant: roundPriceToTick(entry + sign * QUANT_COLD_START_TP1_K * sigmaPts, tickSize),
    target_2_quant: roundPriceToTick(entry + sign * QUANT_COLD_START_TP2_K * sigmaPts, tickSize),
    bucket_source_quant: 'cold_start',
  };
}

export function buildLegacyRewardPlan(
  setup: CandidateSetup,
  config: IndicatorConfig,
  snap: MarketSnapshot,
): DynamicRewardPlan {
  const family = getSetupFamily(setup.setup_type);
  const atr = snap.indicators_1m?.atr_14 ?? null;
  const regime: MarketRegime = 'trending_up';
  const pt = resolvePtOffsets(setup.setup_type, regime, atr, snap.symbol, config);
  return {
    dynamic_min_rr: config.min_rr,
    rr_gate_pass: setup.rr_t1 >= config.min_rr,
    rr_base: config.min_rr,
    rr_regime_adj: 0,
    rr_structure_adj: 0,
    rr_micro_adj: 0,
    rr_components: [`legacy_fixed:${config.min_rr}`],
    mgmt_pt1_offset_pts: pt.pt1_offset_pts,
    mgmt_pt2_offset_pts: pt.pt2_offset_pts,
    mgmt_pt1_implied_rr: setup.risk_pts > 0 ? round2(pt.pt1_offset_pts / setup.risk_pts) : 0,
    quality_band: setup.rr_t1 >= config.min_rr * 1.5 ? 'high' : setup.rr_t1 >= config.min_rr ? 'standard' : 'marginal',
    setup_family: family,
  };
}

function roundPriceToTick(price: number, tickSize: number): number {
  return Math.round(Math.round(price / tickSize) * tickSize * 10000) / 10000;
}
