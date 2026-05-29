import type {
  AnyJournalEventEnvelope,
} from '../../../strategy_runtime/src/contracts/index.js';
import type { StrategyId } from '../../../strategy_runtime/src/contracts/strategy-ids.js';
import type { UnixNs, UnixNsInput } from '../../../strategy_runtime/src/contracts/time.js';
import type { DbnRecord } from '../../../strategy_runtime/src/data/dbn-types.js';
import type {
  PassiveFillEstimate,
  QueueSynthesisOutput,
} from '../../../strategy_runtime/src/data/queue-synthesis/index.js';
import type { BuiltBar } from '../../../strategy_runtime/src/data/bar-builder/index.js';
import type { TradeLedger } from '../trade-ledger/index.js';
import type {
  InstrumentValuationSpec,
  TradeLedgerAnalysis,
} from '../equity-metrics/index.js';
import type {
  StrategyFeatureSnapshot,
  StrategyGenerationResult,
} from '../../../strategy_runtime/src/strategies/index.js';

export type RealArchiveRegimeLabel = 'high' | 'mid' | 'low' | 'unknown';

export type SpreadBucket = '1-tick' | '2-tick' | '3+ ticks' | 'unknown';

export type QueueAheadBucket = '1-5' | '6-20' | '21+' | 'unknown';

export type RealArchiveExitReason =
  | 'stop_loss'
  | 'target'
  | 'time_stop'
  | 'strategy_exit'
  | 'session_close'
  | 'fail_safe'
  | 'unknown';

export type RealArchiveTimeStopAtDeadlineExtension =
  | 'enforce_floor'
  | 'move_to_be'
  | 'activate_trail'
  | 'unconditional_exit';

export interface RealArchiveSessionSource {
  readonly session_id: string;
  readonly trading_date: string;
  readonly raw_symbol: string;
  readonly regime_label?: RealArchiveRegimeLabel;
  readonly vix_prior_close_percentile?: number | null;
  readonly prior_day_close?: number | null;
  readonly prior_day_high?: number | null;
  readonly prior_day_low?: number | null;
  readonly rth_start_ts_ns?: UnixNsInput;
  readonly rth_end_ts_ns?: UnixNsInput;
  readonly trades_path?: string;
  readonly mbp1_path?: string;
  readonly trades_records?: readonly DbnRecord[] | AsyncIterable<DbnRecord>;
  readonly mbp1_records?: readonly DbnRecord[] | AsyncIterable<DbnRecord>;
}

export interface RealArchiveExecutionFillPolicy {
  readonly fill_horizon_ns: bigint;
  readonly depletion_lookback_ns: bigint;
  readonly minimum_fill_probability_ppm: number;
  readonly order_quantity: number;
  readonly exchange_fee_usd?: number;
  readonly commission_usd?: number;
}

export interface RealArchiveBacktestOptions {
  readonly run_id: string;
  readonly strategy_id: StrategyId;
  readonly sessions: readonly RealArchiveSessionSource[];
  readonly bar_spec?: string;
  readonly run_started_at_ns: UnixNsInput;
  readonly fill_policy?: Partial<RealArchiveExecutionFillPolicy>;
  readonly initial_equity_cents?: bigint;
  readonly valuation?: InstrumentValuationSpec;
  readonly strategy_generator?: RealArchiveStrategyGenerator;
  readonly vix_daily_paths?: readonly string[];
  readonly regime_labels_path?: string;
}

export interface RealArchiveStrategyGeneratorInput {
  readonly strategy_id: StrategyId;
  readonly snapshot: StrategyFeatureSnapshot;
}

export type RealArchiveStrategyGenerator = (
  input: RealArchiveStrategyGeneratorInput,
) => StrategyGenerationResult;

export interface RealArchiveRuntimeMetrics {
  readonly sessions_processed: number;
  readonly bars_processed: number;
  readonly candidate_count: number;
  readonly order_intent_count: number;
  readonly fill_count: number;
  readonly closed_trade_count: number;
}

export type RealArchiveMarketAuthority =
  | 'unknown'
  | 'warming'
  | 'authoritative'
  | 'stale'
  | 'gap';

export interface RealArchiveFailSafeContextRecord {
  readonly market_authority: RealArchiveMarketAuthority | null;
  readonly market_is_stale: boolean | null;
  readonly mark_price: number | null;
  readonly bid_px: number | null;
  readonly ask_px: number | null;
  readonly active_stop_price: number | null;
  readonly remaining_quantity: number | null;
  readonly position_profile_id: string | null;
  readonly position_profile_version: number | null;
  readonly management_profile_id: string | null;
  readonly management_profile_version: number | null;
  readonly validation_path: string | null;
  readonly adverse_r_at_exit: number | null;
}

export type RealArchiveSignedShockMeasurementRecord =
  StrategyFeatureSnapshot['context']['signed_shock_vwap'];

export interface RealArchivePerTradeExitRecord {
  readonly exit_ts_ns: UnixNs;
  readonly exit_quantity: number;
  readonly management_action_reason: string | null;
  readonly management_action_type: string | null;
  readonly target_label: 'pt1' | 'pt2' | 'runner' | null;
  readonly fail_safe_context: RealArchiveFailSafeContextRecord | null;
}

export interface RealArchivePerTradeRecord {
  readonly trade_id: string;
  readonly strategy_id: StrategyId | null;
  readonly session_id: string;
  readonly regime_label: RealArchiveRegimeLabel;
  readonly vix_value: number | null;
  readonly vix_fresh: boolean;
  readonly vix_prior_close_percentile: number | null;
  readonly signed_shock_vwap: RealArchiveSignedShockMeasurementRecord | null;
  readonly signed_shock_vwap_recent_values: readonly (number | null)[] | null;
  readonly side: 'long' | 'short';
  readonly entry_ts_ns: UnixNs;
  readonly exit_ts_ns: UnixNs;
  readonly entry_px: number;
  readonly exit_px: number;
  readonly quantity: number;
  readonly entry_quantity: number;
  readonly exit_quantity: number;
  readonly management_profile_id: string;
  readonly time_stop_at_deadline_extension: RealArchiveTimeStopAtDeadlineExtension;
  readonly exits: readonly RealArchivePerTradeExitRecord[];
  readonly pnl_cents: bigint;
  readonly spread_bucket: SpreadBucket;
  readonly queue_ahead_bucket: QueueAheadBucket;
  readonly exit_reason: RealArchiveExitReason;
  readonly exit_bar_index: number;
  readonly max_favorable_excursion_cents: bigint;
  readonly max_adverse_excursion_cents: bigint;
  readonly first_minute_max_favorable_excursion_cents: bigint | null;
  readonly first_minute_max_adverse_excursion_cents: bigint | null;
  readonly first_minute_close_pnl_cents: bigint | null;
  readonly first_minute_observed: boolean;
  readonly fill_quality_metric: {
    readonly entry_fill_probability_ppm: number;
    readonly entry_estimated_fill_quantity: bigint;
    readonly entry_quality_flags: readonly string[];
  };
}

export interface RealArchiveExecutionBarContext {
  readonly bar: BuiltBar;
  readonly session: RealArchiveSessionSource;
  readonly latest_quote: RealArchiveTopOfBook | null;
}

export interface RealArchiveTopOfBook {
  readonly ts_ns: UnixNs;
  readonly instrument_id: number;
  readonly bid_px: number;
  readonly bid_size: number;
  readonly ask_px: number;
  readonly ask_size: number;
}

export interface RealArchiveExecutionDebugProbe {
  readonly estimate: PassiveFillEstimate | null;
  readonly outputs: readonly QueueSynthesisOutput[];
}

export interface RealArchiveBacktestResult {
  readonly result_schema_version: 1;
  readonly run_id: string;
  readonly strategy_id: StrategyId;
  readonly journal_events: readonly AnyJournalEventEnvelope[];
  readonly trade_ledger: TradeLedger;
  readonly trade_analysis: TradeLedgerAnalysis;
  readonly per_trade_records: readonly RealArchivePerTradeRecord[];
  readonly runtime_metrics: RealArchiveRuntimeMetrics;
}
