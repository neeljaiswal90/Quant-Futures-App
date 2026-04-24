import type { Direction } from '../contracts/market.js';
import {
  normalizeStopDistance,
  riskPerContractUsd,
  round6,
  type ContractSpec,
} from './contracts.js';

export interface Phase1SizingConfig {
  readonly C_abs: number;
  readonly C_base: number;
  readonly c_support_k: number;
  readonly c_calibration_placeholder: number;
  readonly c_agreement_placeholder: number;
  readonly eta_liq: number;
  readonly liq_hysteresis_cycles: number;
  readonly liq_increase_cooldown_ms: number;
  readonly d_min: number;
  readonly gamma: number;
  readonly slippage_buffer_points: number;
  readonly regime_scores: Readonly<Record<string, number>>;
}

export const PHASE1_SIZING_DEFAULTS = {
  C_abs: 10,
  C_base: 10,
  c_support_k: 100,
  c_calibration_placeholder: 0.7,
  c_agreement_placeholder: 0.8,
  eta_liq: 0.07,
  liq_hysteresis_cycles: 3,
  liq_increase_cooldown_ms: 30_000,
  d_min: 0.25,
  gamma: 0.75,
  slippage_buffer_points: 0.75,
  regime_scores: {
    strong_trend: 0.9,
    mixed: 0.5,
    chop: 0.3,
    unknown: 0.3,
  },
} as const satisfies Phase1SizingConfig;

export type SizerExecutionMode = 'simulation' | 'replay' | 'signal_only';

export interface LiquidityInputs {
  readonly d_2ticks: number | null;
  readonly v_1s: number | null;
  readonly d_median_session: number | null;
  readonly is_fresh: boolean;
}

export interface QLiqHysteresisState {
  committed: number | null;
  pending_target: number | null;
  pending_cycles: number;
  last_increase_at_ms: number | null;
}

export interface SizingInputs {
  readonly equity_usd: number;
  readonly max_risk_per_trade_pct: number;
  readonly stop_points: number;
  readonly current_open_quantity: number;
  readonly max_net_position_per_symbol: number;
  readonly drawdown_today_usd: number;
  readonly daily_loss_limit_usd: number;
  readonly regime: string;
  readonly n_eff: number;
  readonly direction: Direction;
  readonly mode: SizerExecutionMode;
  readonly liquidity: LiquidityInputs | null;
  readonly now_ms: number;
  readonly hysteresis: QLiqHysteresisState;
}

export interface ComposedSizingResult {
  readonly quantity: number;
  readonly binding_cap: 'q_risk' | 'q_liq' | 'q_softcap' | 'q_hardcap' | 'net_position' | 'reject';
  readonly rejected_reason?: string;
  readonly q_risk: number;
  readonly q_liq: number;
  readonly q_liq_raw: number;
  readonly q_softcap: number;
  readonly q_hardcap: number;
  readonly q_net_cap: number;
  readonly risk_per_contract_usd: number;
  readonly normalized_stop_points: number;
  readonly risk_budget_usd: number;
  readonly rho: number;
  readonly c_support: number;
  readonly c_calibration: number;
  readonly c_agreement: number;
  readonly ell: number;
  readonly d: number;
  readonly q_kelly: null;
}

export function makeQLiqHysteresisState(): QLiqHysteresisState {
  return {
    committed: null,
    pending_target: null,
    pending_cycles: 0,
    last_increase_at_ms: null,
  };
}

export function computeComposedSizing(
  inputs: SizingInputs,
  contract: ContractSpec,
  config: Phase1SizingConfig = PHASE1_SIZING_DEFAULTS,
): ComposedSizingResult {
  validateSizingInputs(inputs);
  const normalizedStopPoints = normalizeStopDistance(inputs.stop_points, contract);
  const riskPerContract = riskPerContractUsd({
    stop_points: normalizedStopPoints,
    contract,
    slippage_points_per_side: config.slippage_buffer_points,
  });
  const riskBudgetUsd = Math.max(0, inputs.equity_usd * (inputs.max_risk_per_trade_pct / 100));
  const qRisk = riskPerContract > 0 ? Math.floor(riskBudgetUsd / riskPerContract) : 0;
  const rho = resolveRegimeScore(inputs.regime, config.regime_scores);
  const cSupport = inputs.n_eff / (inputs.n_eff + config.c_support_k);
  const cCalibration = config.c_calibration_placeholder;
  const cAgreement = config.c_agreement_placeholder;
  const cCombined = clamp01(cSupport * cCalibration * cAgreement);
  const ell = computeEll(inputs.liquidity);
  const d = computeDrawdownRatchet(
    inputs.drawdown_today_usd,
    inputs.daily_loss_limit_usd,
    config.d_min,
    config.gamma,
  );
  const qLiq = computeQLiq(
    inputs.liquidity,
    inputs.mode,
    config.eta_liq,
    inputs.hysteresis,
    config.liq_hysteresis_cycles,
    config.liq_increase_cooldown_ms,
    inputs.now_ms,
  );
  const qSoftcap = floorWithEpsilon(config.C_base * rho * cCombined * ell * d);
  const qHardcap = config.C_abs;
  const qNetCap = Math.max(0, inputs.max_net_position_per_symbol - inputs.current_open_quantity);

  const candidates: Array<{
    readonly name: ComposedSizingResult['binding_cap'];
    readonly value: number;
  }> = [
    { name: 'q_softcap', value: qSoftcap },
    { name: 'q_liq', value: qLiq.q_liq },
    { name: 'q_risk', value: qRisk },
    { name: 'q_hardcap', value: qHardcap },
    { name: 'net_position', value: qNetCap },
  ];

  let quantity = Number.POSITIVE_INFINITY;
  let bindingCap: ComposedSizingResult['binding_cap'] = 'q_hardcap';
  for (const candidate of candidates) {
    if (candidate.value <= quantity) {
      quantity = candidate.value;
      bindingCap = candidate.name;
    }
  }
  quantity = Math.max(0, Math.floor(quantity));

  let rejectedReason = qLiq.rejected_reason;
  if (quantity < 1) {
    if (rejectedReason === undefined) {
      rejectedReason =
        qRisk < 1
          ? `risk_budget_lt_r_per_contract`
          : qNetCap < 1
            ? `net_position_cap_reached`
            : `q_final_zero_bound_by_${bindingCap}`;
    }
    bindingCap = rejectedReason === 'net_position_cap_reached' ? 'net_position' : 'reject';
  }

  return {
    quantity,
    binding_cap: bindingCap,
    rejected_reason: rejectedReason,
    q_risk: qRisk,
    q_liq: qLiq.q_liq,
    q_liq_raw: qLiq.q_liq_raw,
    q_softcap: qSoftcap,
    q_hardcap: qHardcap,
    q_net_cap: qNetCap,
    risk_per_contract_usd: riskPerContract,
    normalized_stop_points: normalizedStopPoints,
    risk_budget_usd: Math.round(riskBudgetUsd * 100) / 100,
    rho: round6(rho),
    c_support: round6(cSupport),
    c_calibration: cCalibration,
    c_agreement: cAgreement,
    ell: round6(ell),
    d: round6(d),
    q_kelly: null,
  };
}

export function computeDrawdownRatchet(
  drawdownTodayUsd: number,
  dailyLossLimitUsd: number,
  dMin: number,
  gamma: number,
): number {
  if (dailyLossLimitUsd <= 0) {
    return dMin;
  }
  const fraction = clamp01(Math.max(0, drawdownTodayUsd) / dailyLossLimitUsd);
  return Math.max(dMin, 1 - gamma * fraction);
}

export function computeEll(liquidity: LiquidityInputs | null): number {
  if (liquidity === null || !liquidity.is_fresh) {
    return 0.5;
  }
  if (liquidity.d_2ticks === null || liquidity.d_median_session === null) {
    return 0.5;
  }
  if (liquidity.d_median_session <= 0) {
    return 0.5;
  }
  return clamp01(liquidity.d_2ticks / liquidity.d_median_session);
}

export interface QLiqResult {
  readonly q_liq: number;
  readonly q_liq_raw: number;
  readonly rejected_reason?: string;
}

export function computeQLiq(
  liquidity: LiquidityInputs | null,
  mode: SizerExecutionMode,
  eta: number,
  state: QLiqHysteresisState,
  hysteresisCycles: number,
  increaseCooldownMs: number,
  nowMs: number,
): QLiqResult {
  if (liquidity === null || !liquidity.is_fresh) {
    if (mode === 'simulation') {
      return { q_liq: 0, q_liq_raw: 0, rejected_reason: 'liquidity_snapshot_stale' };
    }
    return { q_liq: 1, q_liq_raw: 1 };
  }

  const depth = liquidity.d_2ticks ?? 0;
  const flow = liquidity.v_1s ?? 0;
  const raw = Math.max(0, Math.floor(Math.min(depth, flow) * eta));

  if (state.committed === null) {
    state.committed = raw;
    state.pending_target = null;
    state.pending_cycles = 0;
    return { q_liq: raw, q_liq_raw: raw };
  }

  if (raw < state.committed) {
    state.committed = raw;
    state.pending_target = null;
    state.pending_cycles = 0;
    return { q_liq: raw, q_liq_raw: raw };
  }

  if (raw === state.committed) {
    state.pending_target = null;
    state.pending_cycles = 0;
    return { q_liq: state.committed, q_liq_raw: raw };
  }

  if (state.pending_target === raw) {
    state.pending_cycles += 1;
  } else {
    state.pending_target = raw;
    state.pending_cycles = 1;
  }

  const dwellOk = state.pending_cycles >= hysteresisCycles;
  const cooldownOk =
    state.last_increase_at_ms === null ||
    nowMs - state.last_increase_at_ms >= increaseCooldownMs;
  if (dwellOk && cooldownOk) {
    state.committed = raw;
    state.last_increase_at_ms = nowMs;
    state.pending_target = null;
    state.pending_cycles = 0;
  }

  return { q_liq: state.committed, q_liq_raw: raw };
}

function resolveRegimeScore(
  regime: string,
  scores: Readonly<Record<string, number>>,
): number {
  const key = regime.trim().toLowerCase();
  return scores[key] ?? scores.unknown ?? 0.3;
}

function validateSizingInputs(inputs: SizingInputs): void {
  assertNonNegative(inputs.equity_usd, 'equity_usd');
  assertNonNegative(inputs.max_risk_per_trade_pct, 'max_risk_per_trade_pct');
  assertNonNegative(inputs.current_open_quantity, 'current_open_quantity');
  assertNonNegative(inputs.max_net_position_per_symbol, 'max_net_position_per_symbol');
  assertNonNegative(inputs.drawdown_today_usd, 'drawdown_today_usd');
  assertNonNegative(inputs.daily_loss_limit_usd, 'daily_loss_limit_usd');
  assertNonNegative(inputs.n_eff, 'n_eff');
  assertNonNegative(inputs.now_ms, 'now_ms');
}

function assertNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function floorWithEpsilon(value: number): number {
  return Math.floor(value + 1e-9);
}
