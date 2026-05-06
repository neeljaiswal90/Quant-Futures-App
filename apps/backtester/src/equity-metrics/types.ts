import type { UnixNs } from '../../../strategy_runtime/src/contracts/time.js';

export type MoneyCents = bigint;
export type RatioPpm = number;

export interface InstrumentValuationSpec {
  readonly instrument_root: string;
  readonly tick_size: string;
  readonly tick_value_usd_cents: MoneyCents;
}

export interface EquityMetricsOptions {
  readonly initial_equity_cents: MoneyCents;
  readonly valuation: InstrumentValuationSpec;
}

export interface TradePnl {
  readonly trade_id: string;
  readonly run_id: string;
  readonly closed_at_ns: UnixNs;
  readonly side: 'long' | 'short';
  readonly quantity: bigint;
  readonly entry_ticks: bigint;
  readonly exit_ticks: bigint;
  readonly gross_pnl_cents: MoneyCents;
  readonly fees_cents: MoneyCents;
  readonly commissions_cents: MoneyCents;
  readonly net_pnl_cents: MoneyCents;
}

export interface EquityCurvePoint {
  readonly sequence: number;
  readonly ts_ns: UnixNs;
  readonly trade_id: string;
  readonly realized_pnl_cents: MoneyCents;
  readonly equity_cents: MoneyCents;
  readonly peak_equity_cents: MoneyCents;
  readonly drawdown_cents: MoneyCents;
}

export interface TradeMetricsSummary {
  readonly total_trades: number;
  readonly winning_trades: number;
  readonly losing_trades: number;
  readonly flat_trades: number;

  readonly gross_profit_cents: MoneyCents;
  readonly gross_loss_cents: MoneyCents;
  readonly net_pnl_cents: MoneyCents;

  readonly average_trade_pnl_cents: MoneyCents | null;
  readonly average_win_cents: MoneyCents | null;
  readonly average_loss_cents: MoneyCents | null;

  readonly win_rate_ppm: RatioPpm;
  readonly profit_factor_ppm: RatioPpm | null;

  readonly max_drawdown_cents: MoneyCents;
  readonly final_equity_cents: MoneyCents;
  readonly peak_equity_cents: MoneyCents;
}

export interface TradeLedgerAnalysis {
  readonly trade_pnl: readonly TradePnl[];
  readonly equity_curve: readonly EquityCurvePoint[];
  readonly summary: TradeMetricsSummary;
}
