import type {
  Candidate,
  RiskGateDecision,
  SizingDecision,
} from '../contracts/candidate.js';
import {
  makeRiskGateDecisionId,
  makeSizingDecisionId,
} from '../contracts/ids.js';
import type { UnixNs } from '../contracts/time.js';
import {
  computeComposedSizing,
  makeQLiqHysteresisState,
  PHASE1_SIZING_DEFAULTS,
  type LiquidityInputs,
  type Phase1SizingConfig,
  type QLiqHysteresisState,
  type SizerExecutionMode,
} from './composed-sizer.js';
import {
  contractRootFromInstrument,
  getContractSpec,
  round6,
  type ContractSpec,
} from './contracts.js';

export const RISK_MANAGER_VERSION = 'risk_manager_v1' as const;
export const DEFAULT_MAX_NET_POSITION_PER_SYMBOL = 10 as const;

export interface RiskPolicyConfig {
  readonly account_equity_usd: number;
  readonly max_risk_per_trade_pct: number;
  readonly max_daily_loss_pct: number;
  readonly min_reward_risk: number;
  readonly max_net_position_per_symbol: number;
  readonly hard_cap_contracts: number;
  readonly sizing_mode: SizerExecutionMode;
  readonly default_regime: string;
  readonly default_n_eff: number;
  readonly sizing: Phase1SizingConfig;
}

export const DEFAULT_RISK_POLICY: RiskPolicyConfig = {
  account_equity_usd: 50_000,
  max_risk_per_trade_pct: 0.5,
  max_daily_loss_pct: 2,
  min_reward_risk: 1,
  max_net_position_per_symbol: DEFAULT_MAX_NET_POSITION_PER_SYMBOL,
  hard_cap_contracts: PHASE1_SIZING_DEFAULTS.C_abs,
  sizing_mode: 'signal_only',
  default_regime: 'mixed',
  default_n_eff: 200,
  sizing: PHASE1_SIZING_DEFAULTS,
};

export interface RiskRuntimeState {
  readonly current_open_quantity: number;
  readonly daily_realized_pnl_usd: number;
  readonly drawdown_today_usd?: number;
  readonly regime?: string;
  readonly n_eff?: number;
  readonly liquidity?: LiquidityInputs | null;
  readonly q_liq_hysteresis?: QLiqHysteresisState;
  readonly now_ms: number;
}

export interface RiskSizingInput {
  readonly candidate: Candidate;
  readonly decided_ts_ns: UnixNs;
  readonly policy?: PartialRiskPolicyConfig;
  readonly state: RiskRuntimeState;
  readonly contract?: ContractSpec;
}

export interface RiskGateInput {
  readonly candidate: Candidate;
  readonly sizing: SizingDecision;
  readonly decided_ts_ns: UnixNs;
  readonly policy?: PartialRiskPolicyConfig;
  readonly state: RiskRuntimeState;
}

export interface RiskAssessment {
  readonly sizing: SizingDecision;
  readonly gate: RiskGateDecision;
}

export type PartialRiskPolicyConfig =
  Partial<Omit<RiskPolicyConfig, 'sizing'>> & {
    readonly sizing?: Partial<Phase1SizingConfig>;
  };

export function resolveRiskPolicy(
  overrides: PartialRiskPolicyConfig = {},
): RiskPolicyConfig {
  const sizing = {
    ...PHASE1_SIZING_DEFAULTS,
    ...overrides.sizing,
    regime_scores: {
      ...PHASE1_SIZING_DEFAULTS.regime_scores,
      ...overrides.sizing?.regime_scores,
    },
  } as Phase1SizingConfig;
  const hardCap = overrides.hard_cap_contracts ?? sizing.C_abs;
  return {
    ...DEFAULT_RISK_POLICY,
    ...overrides,
    hard_cap_contracts: hardCap,
    max_net_position_per_symbol:
      overrides.max_net_position_per_symbol ?? DEFAULT_RISK_POLICY.max_net_position_per_symbol,
    sizing,
  };
}

export function sizeCandidate(input: RiskSizingInput): SizingDecision {
  const policy = resolveRiskPolicy(input.policy);
  validateRiskPolicy(policy);
  const contract = input.contract ?? getContractSpec(contractRootFromInstrument(input.candidate.instrument));
  const drawdownTodayUsd =
    input.state.drawdown_today_usd ?? Math.max(0, -input.state.daily_realized_pnl_usd);
  const dailyLossLimitUsd = policy.account_equity_usd * (policy.max_daily_loss_pct / 100);
  const hysteresis = input.state.q_liq_hysteresis ?? makeQLiqHysteresisState();
  const sizingResult = computeComposedSizing(
    {
      equity_usd: policy.account_equity_usd,
      max_risk_per_trade_pct: policy.max_risk_per_trade_pct,
      stop_points: input.candidate.risk_points,
      current_open_quantity: input.state.current_open_quantity,
      max_net_position_per_symbol: policy.max_net_position_per_symbol,
      drawdown_today_usd: drawdownTodayUsd,
      daily_loss_limit_usd: dailyLossLimitUsd,
      regime: input.state.regime ?? policy.default_regime,
      n_eff: input.state.n_eff ?? policy.default_n_eff,
      direction: input.candidate.direction,
      mode: policy.sizing_mode,
      liquidity: input.state.liquidity ?? null,
      now_ms: input.state.now_ms,
      hysteresis,
    },
    contract,
    {
      ...policy.sizing,
      C_abs: policy.hard_cap_contracts,
      C_base: Math.min(policy.sizing.C_base, policy.hard_cap_contracts),
    } as Phase1SizingConfig,
  );

  const quantity = sizingResult.quantity;
  return {
    sizing_decision_id: makeSizingDecisionId(`sizing-${input.candidate.candidate_id}`),
    candidate_id: input.candidate.candidate_id,
    decided_ts_ns: input.decided_ts_ns,
    quantity,
    risk_usd: round6(quantity * sizingResult.risk_per_contract_usd),
    risk_points: sizingResult.normalized_stop_points,
    rejected_reason: sizingResult.rejected_reason,
    config: input.candidate.config,
  };
}

export function evaluateRiskGate(input: RiskGateInput): RiskGateDecision {
  const policy = resolveRiskPolicy(input.policy);
  validateRiskPolicy(policy);
  const reasons: string[] = [];

  if (input.candidate.status !== 'proposed') {
    reasons.push('risk_gate:candidate_not_proposed');
  }

  const minRewardRisk = minimumRewardRisk(input.candidate);
  if (minRewardRisk < policy.min_reward_risk) {
    reasons.push('risk_gate:reward_risk_below_minimum');
  }

  if (input.sizing.quantity < 1) {
    reasons.push(input.sizing.rejected_reason ?? 'risk_gate:sizing_quantity_zero');
  }

  const projectedNetQuantity = input.state.current_open_quantity + input.sizing.quantity;
  if (projectedNetQuantity > policy.max_net_position_per_symbol) {
    reasons.push('risk_gate:max_net_position_exceeded');
  }

  const dailyLossLimitUsd = policy.account_equity_usd * (policy.max_daily_loss_pct / 100);
  const realizedLossUsd = Math.max(0, -input.state.daily_realized_pnl_usd);
  if (realizedLossUsd >= dailyLossLimitUsd) {
    reasons.push('risk_gate:daily_loss_limit_reached');
  }

  return {
    risk_gate_decision_id: makeRiskGateDecisionId(`risk-${input.candidate.candidate_id}`),
    candidate_id: input.candidate.candidate_id,
    decided_ts_ns: input.decided_ts_ns,
    status: reasons.length === 0 ? 'pass' : 'reject',
    reasons: reasons.length === 0 ? ['risk_gate:passed'] : reasons,
    max_loss_usd: input.sizing.quantity > 0 ? input.sizing.risk_usd : undefined,
    config: input.candidate.config,
  };
}

export function assessCandidateRisk(input: RiskSizingInput): RiskAssessment {
  const sizing = sizeCandidate(input);
  const gate = evaluateRiskGate({
    candidate: input.candidate,
    sizing,
    decided_ts_ns: input.decided_ts_ns,
    policy: input.policy,
    state: input.state,
  });
  return { sizing, gate };
}

function minimumRewardRisk(candidate: Candidate): number {
  const values = candidate.reward_risk.map((target) => target.reward_risk);
  if (values.length === 0) {
    return 0;
  }
  return Math.min(...values);
}

function validateRiskPolicy(policy: RiskPolicyConfig): void {
  validatePositive(policy.account_equity_usd, 'account_equity_usd');
  validatePositive(policy.max_risk_per_trade_pct, 'max_risk_per_trade_pct');
  validatePositive(policy.max_daily_loss_pct, 'max_daily_loss_pct');
  validatePositive(policy.min_reward_risk, 'min_reward_risk');
  validatePositive(policy.max_net_position_per_symbol, 'max_net_position_per_symbol');
  validatePositive(policy.hard_cap_contracts, 'hard_cap_contracts');
  validatePositive(policy.default_n_eff, 'default_n_eff');
}

function validatePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
}
