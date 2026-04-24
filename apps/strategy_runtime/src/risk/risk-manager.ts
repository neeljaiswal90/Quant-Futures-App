import type { CandidateSetup, MarketRegime } from '../contracts/candidate.js';
import type { IndicatorConfig } from '../contracts/config.js';
import type { ContractSpec } from './contracts.js';
import { normalizeStopDistance, priceToTicks, riskPerContract } from './contracts.js';
import {
  computeTargetPosition,
  DEFAULT_POSITION_TARGET_CONFIG,
  logTargetPositionDecision,
  type BoundBy,
  type TargetPositionContext,
  type TargetPositionResult,
} from '../management/target-position.js';

export interface RiskState {
  daily_pnl_usd: number;
  daily_loss_pct: number;
  consecutive_losses: number;
  total_trades_today: number;
  is_locked: boolean;
  lock_reason: string | null;
}

export const DEFAULT_MAX_NET_POSITION_PER_SYMBOL = 10;
export const MAX_NET_POSITION_PER_SYMBOL = DEFAULT_MAX_NET_POSITION_PER_SYMBOL;

export function resolveMaxNetPositionPerSymbol(
  config: Pick<IndicatorConfig, 'max_net_position_per_symbol'>,
): number {
  const value = config.max_net_position_per_symbol;
  if (value === undefined || value === null) return DEFAULT_MAX_NET_POSITION_PER_SYMBOL;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid_max_net_position_per_symbol: ${String(value)}`);
  }
  return value;
}

export interface SizingResult {
  quantity: number;
  notional: number;
  risk_usd: number;
  max_risk_usd: number;
  stop_distance_pts: number;
  stop_distance_ticks: number;
  risk_per_contract_usd: number;
  reason: string;
  equity: number;
  max_risk_pct_used: number;
  contracts_raw: number;
  target_position?: TargetPositionResult;
  bound_by?: BoundBy;
}

export class RiskManager {
  private state: RiskState;
  private readonly maxNetPositionPerSymbol: number;

  constructor(
    private readonly config: IndicatorConfig,
    private readonly contract: ContractSpec,
  ) {
    this.maxNetPositionPerSymbol = resolveMaxNetPositionPerSymbol(config);
    this.state = {
      daily_pnl_usd: 0,
      daily_loss_pct: 0,
      consecutive_losses: 0,
      total_trades_today: 0,
      is_locked: false,
      lock_reason: null,
    };
  }

  getState(): Readonly<RiskState> {
    return { ...this.state };
  }

  getMaxNetPositionPerSymbol(): number {
    return this.maxNetPositionPerSymbol;
  }

  isLocked(): boolean {
    return this.state.is_locked;
  }

  getLockReason(): string | null {
    return this.state.lock_reason;
  }

  preTradeCheck(
    setup: CandidateSetup,
    dynamicMinRr?: number | null,
    currentOpenQty: number = 0,
  ): string | null {
    if (this.state.is_locked) {
      return `risk_locked: ${this.state.lock_reason}`;
    }

    const effectiveMinRr = dynamicMinRr ?? this.config.min_rr;
    if (setup.rr_t1 < effectiveMinRr) {
      return `rr_insufficient: ${setup.rr_t1} < ${effectiveMinRr}`;
    }

    const sizing = this.calcPositionSize(setup);
    if (sizing.quantity <= 0) {
      return `sizing_zero_contracts: ${sizing.reason}`;
    }

    const projectedQty = currentOpenQty + sizing.quantity;
    if (projectedQty > this.maxNetPositionPerSymbol) {
      return `net_position_cap: ${currentOpenQty} + ${sizing.quantity} > ${this.maxNetPositionPerSymbol}`;
    }

    return null;
  }

  calcPositionSize(setup: CandidateSetup): SizingResult {
    const equity = this.config.account_equity;
    const maxRiskUsd = equity * (this.config.max_risk_per_trade_pct / 100);
    const stopPts = normalizeStopDistance(setup.risk_pts, this.contract);
    const stopTicks = priceToTicks(stopPts, this.contract);
    const riskPerK = riskPerContract(stopPts, this.contract);

    if (riskPerK <= 0) {
      return {
        quantity: 0,
        notional: 0,
        risk_usd: 0,
        max_risk_usd: round2(maxRiskUsd),
        stop_distance_pts: stopPts,
        stop_distance_ticks: stopTicks,
        risk_per_contract_usd: 0,
        reason: 'risk_per_contract_non_positive',
        equity,
        max_risk_pct_used: this.config.max_risk_per_trade_pct,
        contracts_raw: 0,
      };
    }

    const contractsRaw = maxRiskUsd / riskPerK;
    let quantity = Math.floor(contractsRaw);
    let reason = 'ok';
    if (quantity <= 0) {
      reason = `budget_$${maxRiskUsd.toFixed(2)}_lt_risk_per_contract_$${riskPerK.toFixed(2)}`;
    }
    const HARD_CAP = 10;
    if (quantity > HARD_CAP) {
      quantity = HARD_CAP;
      reason = `capped_at_${HARD_CAP}`;
    }

    const entryMid = (setup.entry_low + setup.entry_high) / 2;
    return {
      quantity,
      notional: round2(quantity * entryMid * this.contract.point_value),
      risk_usd: round2(quantity * riskPerK),
      max_risk_usd: round2(maxRiskUsd),
      stop_distance_pts: stopPts,
      stop_distance_ticks: stopTicks,
      risk_per_contract_usd: round2(riskPerK),
      reason,
      equity,
      max_risk_pct_used: this.config.max_risk_per_trade_pct,
      contracts_raw: round2(contractsRaw),
    };
  }

  buildTargetContextFromSetup(
    setup: CandidateSetup,
    regime: MarketRegime | null,
    sessionBucket: string | null,
  ): TargetPositionContext {
    const entryMid = (setup.entry_low + setup.entry_high) / 2;
    const cfg = this.config.position_target ?? DEFAULT_POSITION_TARGET_CONFIG;
    return {
      stop_distance_pts: Math.abs(entryMid - setup.stop),
      contract: this.contract,
      equity: this.config.account_equity,
      max_risk_per_trade_pct: this.config.max_risk_per_trade_pct,
      confidence_raw: setup.confidence,
      confidence_source: 'entry_setup',
      regime,
      session_bucket: sessionBucket,
      daily_loss_pct: this.state.daily_loss_pct,
      max_daily_loss_pct: this.config.max_daily_loss_pct,
      hard_cap: cfg.hard_cap,
      config: cfg,
    };
  }

  calcTargetSizing(
    setup: CandidateSetup,
    regime: MarketRegime | null,
    sessionBucket: string | null,
  ): SizingResult {
    const cfg = this.config.position_target;
    if (!cfg || !cfg.enabled) {
      return this.calcPositionSize(setup);
    }

    const target = computeTargetPosition(this.buildTargetContextFromSetup(setup, regime, sessionBucket));
    const quantity = target.q_target;
    const entryMid = (setup.entry_low + setup.entry_high) / 2;
    const contractsRaw = target.risk_per_contract_usd > 0
      ? target.max_risk_usd / target.risk_per_contract_usd
      : 0;
    let reason = target.reason;
    if (quantity <= 0 && reason === 'ok') reason = 'target_zero';
    else if (quantity > 0 && target.bound_by !== 'risk') reason = `bound_by_${target.bound_by}`;

    return {
      quantity,
      notional: round2(quantity * entryMid * this.contract.point_value),
      risk_usd: round2(quantity * target.risk_per_contract_usd),
      max_risk_usd: round2(target.max_risk_usd),
      stop_distance_pts: target.stop_distance_pts,
      stop_distance_ticks: target.stop_distance_ticks,
      risk_per_contract_usd: round2(target.risk_per_contract_usd),
      reason,
      equity: this.config.account_equity,
      max_risk_pct_used: this.config.max_risk_per_trade_pct,
      contracts_raw: round2(contractsRaw),
      target_position: target,
      bound_by: target.bound_by,
    };
  }

  logTargetSizingDecision(
    sizing: SizingResult,
    direction: 'long' | 'short',
    contractRoot: string,
    approved: boolean,
  ): void {
    if (!sizing.target_position) return;
    logTargetPositionDecision(sizing.target_position, {
      tag: 'entry',
      approved,
      equity: sizing.equity,
      direction,
      contractRoot,
    });
  }

  logSizingDecision(
    sizing: SizingResult,
    direction: 'long' | 'short',
    contractRoot: string,
    pointValue: number,
    approved: boolean,
  ): void {
    const tag = approved ? '[SIZING]' : '[SIZING_BLOCKED]';
    console.log(
      `${tag} ${direction.toUpperCase()} ${contractRoot} account_equity=$${sizing.equity.toLocaleString()}` +
        ` max_risk_pct=${sizing.max_risk_pct_used}% risk_budget=$${sizing.max_risk_usd}` +
        ` stop=${sizing.stop_distance_pts}pts (${sizing.stop_distance_ticks}tk)` +
        ` point_value=$${pointValue}/pt risk_per_contract=$${sizing.risk_per_contract_usd}` +
        ` contracts_raw=${sizing.contracts_raw} contracts_final=${sizing.quantity} reason=${sizing.reason}`,
    );
  }

  recordTradeOpen(): void {
    this.state.total_trades_today += 1;
  }

  recordTradeClose(pnlUsd: number, outcomeClass: 'winner' | 'loser' | 'scratch' = 'scratch'): void {
    this.state.daily_pnl_usd += pnlUsd;
    this.state.daily_loss_pct =
      Math.abs(Math.min(0, this.state.daily_pnl_usd)) / this.config.account_equity * 100;

    if (outcomeClass === 'loser') this.state.consecutive_losses += 1;
    if (outcomeClass === 'winner') this.state.consecutive_losses = 0;

    if (this.state.daily_loss_pct >= this.config.max_daily_loss_pct) {
      this.lock(`daily_loss_limit_${this.state.daily_loss_pct.toFixed(2)}%`);
    }
  }

  resetDaily(): void {
    this.state = {
      daily_pnl_usd: 0,
      daily_loss_pct: 0,
      consecutive_losses: 0,
      total_trades_today: 0,
      is_locked: false,
      lock_reason: null,
    };
  }

  private lock(reason: string): void {
    this.state.is_locked = true;
    this.state.lock_reason = reason;
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
