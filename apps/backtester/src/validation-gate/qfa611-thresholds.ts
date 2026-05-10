export const ADR0016_STAGE1_THRESHOLDS = {
  schema_version: 1,
  annualized_return_min_decimal: 0.12,
  annualized_sharpe_min: 1.0,
  dsr_statistic_min: 0.0,
  psr_zero_null_min: 0.80,
  max_drawdown_max_decimal: 0.08,
  profit_factor_min: 1.35,
  total_trades_min: 300,
  per_regime_trades_min: 30,
  regime_trade_contribution_floor: 0.10,
  sensitivity_low_fidelity_share_ppm: 750_000,
  sensitivity_concentration_fraction: 0.30,
} as const;

export const ADR0016_STAGE2_THRESHOLDS = {
  schema_version: 1,
  psr_zero_null_min: 0.95,
  psr_hurdle_null_min: 0.50,
  paper_observation_trading_days_min: 45,
  paper_observation_trading_days_preferred: 60,
} as const;

export const ADR0016_RISK_BUDGETS = {
  schema_version: 1,
  max_risk_per_trade_pct: 0.25,
  max_daily_loss_pct: 1.0,
  max_weekly_loss_pct: 3.0,
  max_total_drawdown_pct: 10.0,
  held_out_drawdown_gate_pct: 8.0,
  gross_notional_leverage_cap: 2.0,
} as const;

export const QFA611_STAT_CORE_VERSION = 'qfa611_stats_v1' as const;
export const QFA611_ANNUALIZATION_SESSIONS = 252 as const;
export const QFA611_NEWEY_WEST_BANDWIDTH_RULE = 'floor(4*(T/100)^(2/9))' as const;
export const QFA611_BOOTSTRAP_REPLICATIONS = 10_000 as const;
export const QFA611_BOOTSTRAP_SEED_DEFAULT = 42 as const;