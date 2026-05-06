import type { StrategyId } from '../../../strategy_runtime/src/contracts/strategy-ids.js';
import type { UnixNs } from '../../../strategy_runtime/src/contracts/time.js';

export type LedgerExecutionSide = 'buy' | 'sell';
export type LedgerPositionSide = 'long' | 'short';

export type InstrumentIdentitySource = 'fill_event' | 'ledger_options';

export interface TradeLedgerInstrumentContext {
  readonly instrument_id: number;
  readonly raw_symbol: string | null;
}

export interface TradeLedgerOptions {
  readonly instrument_context?: TradeLedgerInstrumentContext;
  readonly run_id?: string;
}

export interface LedgerExecution {
  readonly execution_id: string;
  readonly run_id: string;
  readonly event_id: string;
  readonly ts_ns: UnixNs;

  readonly strategy_id: StrategyId | null;
  readonly instrument_id: number;
  readonly raw_symbol: string | null;
  readonly instrument_identity_source: InstrumentIdentitySource;

  readonly side: LedgerExecutionSide;
  readonly price: number;
  readonly quantity: number;
  readonly exchange_fee_usd?: number;
  readonly commission_usd?: number;

  readonly source_event_type: 'SIM_FILL';
  readonly source_event_id: string;
  readonly fill_id: string;
  readonly order_intent_id: string;
}

export interface OpenLedgerPosition {
  readonly position_id: string;
  readonly run_id: string;
  readonly strategy_id: StrategyId | null;
  readonly instrument_id: number;
  readonly raw_symbol: string | null;
  readonly instrument_identity_source: InstrumentIdentitySource;

  readonly side: LedgerPositionSide;
  readonly quantity_open: number;
  readonly entry_quantity: number;
  readonly average_entry_price: number;
  readonly opened_at_ns: UnixNs;
  readonly updated_at_ns: UnixNs;
  readonly execution_ids: readonly string[];
}

export interface ClosedTrade {
  readonly trade_id: string;
  readonly run_id: string;
  readonly strategy_id: StrategyId | null;
  readonly instrument_id: number;
  readonly raw_symbol: string | null;
  readonly instrument_identity_source: InstrumentIdentitySource;

  readonly opened_at_ns: UnixNs;
  readonly closed_at_ns: UnixNs;

  readonly side: LedgerPositionSide;
  readonly entry_quantity: number;
  readonly exit_quantity: number;

  readonly average_entry_price: number;
  readonly average_exit_price: number;

  readonly realized_pnl: null;
  readonly execution_ids: readonly string[];
}

export interface TradeLedger {
  readonly run_id: string;
  readonly executions: readonly LedgerExecution[];
  readonly closed_trades: readonly ClosedTrade[];
  readonly open_positions: readonly OpenLedgerPosition[];
}
