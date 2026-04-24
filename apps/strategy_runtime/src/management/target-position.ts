import type { MarketRegime } from '../contracts/candidate.js';
import type { ContractSpec } from '../risk/contracts.js';
import { normalizeStopDistance, priceToTicks, riskPerContract } from '../risk/contracts.js';

export interface PositionTargetConfig {
  enabled: boolean;
  hard_cap: number;
  soft_cap_base: number;
  regime_factors: Record<string, number> & { default: number };
  session_factors: Record<string, number> & { default: number };
  min_confidence_for_full_size: number;
  enable_fractional_entry: boolean;
  fractional_entry_min_confidence: number;
  fractional_entry_mode: 'confidence_scaled' | 'fixed_fraction';
  management_recompute_enabled: boolean;
  management_reduce_min_delta: number;
  management_reduce_cooldown_sec: number;
  reduce_large_delta_threshold: number;
  reduce_persistence_cycles_small_delta: number;
  min_residual_contracts: number;
  flatten_on_zero_target: boolean;
  max_target_reduce_per_cycle: number;
  stop_widening_allowed: boolean;
  stale_input_policy: 'hold_prior_target';
}

export const DEFAULT_POSITION_TARGET_CONFIG: PositionTargetConfig = {
  enabled: true,
  hard_cap: 10,
  soft_cap_base: 10,
  regime_factors: {
    trending_up: 1.0,
    trending_down: 1.0,
    range_bound: 0.8,
    breakout_attempt: 0.9,
    breakdown_attempt: 0.9,
    compression: 0.7,
    high_volatility_impulse: 0.6,
    choppy: 0.5,
    default: 0.8,
  },
  session_factors: {
    NY_AM: 1.0,
    NY_PM: 0.95,
    NY_LUNCH: 0.85,
    LONDON: 0.9,
    ASIA: 0.85,
    default: 0.95,
  },
  min_confidence_for_full_size: 0.7,
  enable_fractional_entry: false,
  fractional_entry_min_confidence: 0.65,
  fractional_entry_mode: 'confidence_scaled',
  management_recompute_enabled: true,
  management_reduce_min_delta: 1,
  management_reduce_cooldown_sec: 20,
  reduce_large_delta_threshold: 2,
  reduce_persistence_cycles_small_delta: 2,
  min_residual_contracts: 1,
  flatten_on_zero_target: true,
  max_target_reduce_per_cycle: 2,
  stop_widening_allowed: false,
  stale_input_policy: 'hold_prior_target',
};

export type ConfidenceSource = 'entry_setup' | 'management_pop_t2' | 'management_pop_t1';
export type BoundBy = 'risk' | 'softcap' | 'hardcap';

export interface TargetPositionContext {
  stop_distance_pts: number;
  contract: ContractSpec;
  equity: number;
  max_risk_per_trade_pct: number;
  confidence_raw: number;
  confidence_source: ConfidenceSource;
  regime: MarketRegime | null;
  session_bucket: string | null;
  daily_loss_pct: number;
  max_daily_loss_pct: number;
  hard_cap: number;
  config: PositionTargetConfig;
}

export interface TargetPositionResult {
  q_target: number;
  q_risk: number;
  q_softcap: number;
  q_hardcap: number;
  bound_by: BoundBy;
  bound_by_all: BoundBy[];
  confidence_raw: number;
  confidence_factor: number;
  confidence_source: ConfidenceSource;
  regime_factor: number;
  session_factor: number;
  drawdown_factor: number;
  risk_per_contract_usd: number;
  max_risk_usd: number;
  stop_distance_pts: number;
  stop_distance_ticks: number;
  reason: string;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function normalizeConfidence(source: ConfidenceSource, raw: number): number {
  switch (source) {
    case 'entry_setup':
      return clamp01(raw / 10);
    case 'management_pop_t2':
    case 'management_pop_t1':
      return clamp01(raw);
  }
}

function regimeFactor(
  regime: MarketRegime | null,
  factors: PositionTargetConfig['regime_factors'],
): number {
  if (regime == null) return factors.default;
  const value = factors[regime];
  return typeof value === 'number' && Number.isFinite(value) ? value : factors.default;
}

function sessionFactor(
  bucket: string | null,
  factors: PositionTargetConfig['session_factors'],
): number {
  if (bucket == null) return factors.default;
  const value = factors[bucket];
  return typeof value === 'number' && Number.isFinite(value) ? value : factors.default;
}

function drawdownFactor(dailyLossPct: number, maxDailyLossPct: number): number {
  if (!Number.isFinite(dailyLossPct) || !Number.isFinite(maxDailyLossPct)) return 1;
  if (maxDailyLossPct <= 0) return 1;
  const drawdown = Math.max(0, dailyLossPct);
  return clamp01(1 - drawdown / maxDailyLossPct);
}

function resolveBoundBy(qRisk: number, qSoft: number, qHard: number): {
  bound_by: BoundBy;
  bound_by_all: BoundBy[];
} {
  const minValue = Math.min(qRisk, qSoft, qHard);
  const hits: BoundBy[] = [];
  if (qSoft <= minValue + 0.01) hits.push('softcap');
  if (qRisk <= minValue + 0.01) hits.push('risk');
  if (qHard <= minValue + 0.01) hits.push('hardcap');
  return {
    bound_by: hits.includes('softcap') ? 'softcap' : hits.includes('risk') ? 'risk' : 'hardcap',
    bound_by_all: hits,
  };
}

export function computeTargetPosition(ctx: TargetPositionContext): TargetPositionResult {
  const stopPts = normalizeStopDistance(ctx.stop_distance_pts, ctx.contract);
  const stopTicks = priceToTicks(stopPts, ctx.contract);
  const rpcUsd = riskPerContract(stopPts, ctx.contract);
  const maxRiskUsd = ctx.equity * (ctx.max_risk_per_trade_pct / 100);
  const confidenceFactor = normalizeConfidence(ctx.confidence_source, ctx.confidence_raw);
  const rho = regimeFactor(ctx.regime, ctx.config.regime_factors);
  const session = sessionFactor(ctx.session_bucket, ctx.config.session_factors);
  const drawdown = drawdownFactor(ctx.daily_loss_pct, ctx.max_daily_loss_pct);
  const qHardcap = Math.max(0, Math.floor(ctx.hard_cap));

  if (rpcUsd <= 0 || !Number.isFinite(rpcUsd)) {
    return {
      q_target: 0,
      q_risk: 0,
      q_softcap: 0,
      q_hardcap: qHardcap,
      bound_by: 'risk',
      bound_by_all: ['risk'],
      confidence_raw: ctx.confidence_raw,
      confidence_factor: confidenceFactor,
      confidence_source: ctx.confidence_source,
      regime_factor: rho,
      session_factor: session,
      drawdown_factor: drawdown,
      risk_per_contract_usd: 0,
      max_risk_usd: round2(maxRiskUsd),
      stop_distance_pts: stopPts,
      stop_distance_ticks: stopTicks,
      reason: 'risk_per_contract_non_positive',
    };
  }

  const qRiskRaw = maxRiskUsd / rpcUsd;
  const qSoftRaw = ctx.config.soft_cap_base * confidenceFactor * rho * session * drawdown;
  const binding = resolveBoundBy(qRiskRaw, qSoftRaw, qHardcap);
  const qRisk = Math.max(0, Math.floor(qRiskRaw));
  const qSoft = Math.max(0, Math.floor(qSoftRaw));
  const qTarget = Math.max(0, Math.floor(Math.min(qRiskRaw, qSoftRaw, qHardcap)));

  let reason = 'ok';
  if (qTarget <= 0) {
    if (qSoftRaw <= 0) {
      reason = `softcap_zero (d_t=${drawdown.toFixed(2)} c_t=${confidenceFactor.toFixed(2)})`;
    } else if (qRiskRaw < 1) {
      reason = `budget_$${maxRiskUsd.toFixed(2)}_lt_risk_per_contract_$${rpcUsd.toFixed(2)}`;
    } else {
      reason = 'target_zero';
    }
  }

  return {
    q_target: qTarget,
    q_risk: qRisk,
    q_softcap: qSoft,
    q_hardcap: qHardcap,
    bound_by: binding.bound_by,
    bound_by_all: binding.bound_by_all,
    confidence_raw: ctx.confidence_raw,
    confidence_factor: confidenceFactor,
    confidence_source: ctx.confidence_source,
    regime_factor: rho,
    session_factor: session,
    drawdown_factor: drawdown,
    risk_per_contract_usd: round2(rpcUsd),
    max_risk_usd: round2(maxRiskUsd),
    stop_distance_pts: stopPts,
    stop_distance_ticks: stopTicks,
    reason,
  };
}

export type TargetActionKind =
  | 'ON_TARGET'
  | 'REDUCE'
  | 'WOULD_ADD'
  | 'FLATTEN_PENDING'
  | 'HOLD_PERSISTENCE'
  | 'HOLD_COOLDOWN'
  | 'HOLD_BRACKET_SYNC'
  | 'HOLD_STALE_INPUT';

export interface TargetActionDescription {
  kind: TargetActionKind;
  qty: number;
}

export function describeTargetAction(
  delta: number,
  qTarget: number,
  persistenceCounter: number,
  cooldownRemainingSec: number,
  bracketSyncBlocked = false,
  fromStaleCache = false,
): TargetActionDescription {
  if (fromStaleCache) return { kind: 'HOLD_STALE_INPUT', qty: 0 };
  if (qTarget === 0) return { kind: 'FLATTEN_PENDING', qty: 0 };
  if (delta === 0) return { kind: 'ON_TARGET', qty: 0 };
  if (delta > 0) return { kind: 'WOULD_ADD', qty: delta };
  if (bracketSyncBlocked) return { kind: 'HOLD_BRACKET_SYNC', qty: Math.abs(delta) };
  if (cooldownRemainingSec > 0) return { kind: 'HOLD_COOLDOWN', qty: Math.abs(delta) };
  if (persistenceCounter > 0) return { kind: 'HOLD_PERSISTENCE', qty: Math.abs(delta) };
  return { kind: 'REDUCE', qty: Math.abs(delta) };
}

export function logTargetPositionDecision(
  result: TargetPositionResult,
  opts: {
    tag: 'entry' | 'recompute' | 'execute' | 'would_scale_in';
    approved: boolean;
    equity: number;
    qCurrent?: number;
    deltaDrop?: number;
    direction?: 'long' | 'short' | null;
    contractRoot?: string;
  },
): void {
  const icon = opts.approved ? 'APPROVED' : 'BLOCKED';
  const boundAll = result.bound_by_all.join(',');
  const currentPart =
    typeof opts.qCurrent === 'number'
      ? ` q_current=${opts.qCurrent} delta=${typeof opts.deltaDrop === 'number' ? opts.deltaDrop : opts.qCurrent - result.q_target}`
      : '';
  console.log(
    `[TARGET_POS][${opts.tag}] ${icon}${opts.direction ? ` ${opts.direction.toUpperCase()}` : ''}` +
      `${opts.contractRoot ? ` ${opts.contractRoot}` : ''} q_target=${result.q_target}${currentPart}` +
      ` | q_risk=${result.q_risk} q_softcap=${result.q_softcap} q_hardcap=${result.q_hardcap}` +
      ` | bound_by=${result.bound_by} bound_by_all=[${boundAll}]` +
      ` | c_t_raw=${fmt(result.confidence_raw)} c_t_norm=${fmt(result.confidence_factor)}` +
      ` source=${result.confidence_source} rho=${fmt(result.regime_factor)}` +
      ` session=${fmt(result.session_factor)} drawdown=${fmt(result.drawdown_factor)}` +
      ` | equity=$${Math.round(opts.equity).toLocaleString()} risk_usd=$${result.max_risk_usd}` +
      ` stop=${result.stop_distance_pts}pts (${result.stop_distance_ticks}tk)` +
      ` | reason=${result.reason}`,
  );
}

function fmt(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
