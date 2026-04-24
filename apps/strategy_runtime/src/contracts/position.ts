import type { CandidateSetup, EntryStateVector, MarketRegime, SetupType } from './candidate.js';
import type { ResolvedManagementParams } from '../management/types.js';

export type ExitReason =
  | 'target_1'
  | 'target_2'
  | 'target_3'
  | 'partial_profit_1'
  | 'partial_profit_2'
  | 'stop_loss'
  | 'stop_loss_initial'
  | 'stop_loss_breakeven'
  | 'stop_loss_trailing'
  | 'time_stop'
  | 'failure_exit_soft'
  | 'failure_exit_hard'
  | 'failure_exit_emergency'
  | 'exit_now'
  | 'manual';

export type PositionManagementParams = ResolvedManagementParams;

export interface ExitLeg {
  reason: ExitReason;
  quantity: number;
  fill_price: number;
  fill_time_iso: string;
  pnl_points: number;
  pnl_usd: number;
  fee_usd: number;
  slippage_pts: number;
}

export interface Position {
  trade_id: string;
  signal_id: string;
  session_id: string;
  symbol: string;
  venue: string;
  side: 'long' | 'short';
  setup_type: SetupType;
  entry_price: number;
  entry_time_iso: string;
  entry_time_unix: number;
  stop_initial: number;
  stop_current: number;
  target_1: number;
  target_2: number;
  target_3: number | null;
  planned_target_1: number | null;
  effective_target_1: number | null;
  first_partial_fill_price: number | null;
  target_1_direction_valid: boolean;
  target_2_direction_valid: boolean;
  target_3_direction_valid: boolean;
  target_ordering_valid: boolean;
  target_repair_applied: boolean;
  quantity_original: number;
  quantity_remaining: number;
  notional_usd: number;
  regime_at_entry: MarketRegime | null;
  strategy_version: string;
  confidence_at_entry: number;
  risk_pts_initial: number;
  partial_exit_done: boolean;
  pt1_done: boolean;
  pt2_done: boolean;
  trailing_active: boolean;
  pre_t1_trailing_active: boolean;
  pre_t1_be_triggered: boolean;
  stop_moved_to_be: boolean;
  trail_distance_ticks: number;
  trail_anchor_price: number | null;
  time_stop_minutes: number;
  last_checked_price: number;
  realized_pnl_usd: number;
  realized_fees_usd: number;
  max_favorable_excursion: number;
  max_adverse_excursion: number;
  pt1_qty_exited: number;
  pt2_qty_exited: number;
  pt1_realized_pnl: number;
  pt2_realized_pnl: number;
  exit_legs: ExitLeg[];
  peak_r_before_first_partial: number | null;
  t_peak_r_minutes: number | null;
  time_to_first_positive_r_minutes: number | null;
  time_to_peak_r_before_first_partial_minutes: number | null;
  mae_r_before_first_partial: number;
  atr_at_entry: number | null;
  failure_review_soft_emitted: boolean;
  failure_exit_hard_fired: boolean;
  failure_exit_emergency_fired: boolean;
  failure_exit_active_lane: 'none' | 'soft' | 'hard' | 'emergency';
  failure_exit_reason: string | null;
  failure_exit_shadow_only: boolean;
  entry_state_vector: EntryStateVector | null;
  management_params: PositionManagementParams;
}

export interface PositionDecision {
  shouldExit: boolean;
  reason: ExitReason | null;
  exitPrice: number;
  plannedExitPrice: number;
  isPartial: boolean;
  partialQuantity: number;
}

export interface TradeRecord {
  trade_id: string;
  signal_id: string;
  symbol: string;
  venue: string;
  side: 'long' | 'short';
  setup_type: SetupType;
  quantity: number;
  entry_price_planned: number;
  entry_price_filled: number;
  exit_price_planned: number;
  exit_price_actual: number;
  stop_price_initial: number;
  pnl_realized: number;
  exit_reason: ExitReason;
  regime_at_entry: MarketRegime | null;
  session_id: string;
  strategy_version: string;
  entry_state_vector?: EntryStateVector | null;
  target_1_direction_valid?: boolean;
  target_2_direction_valid?: boolean;
  target_3_direction_valid?: boolean;
  target_ordering_valid?: boolean;
  target_repair_applied?: boolean;
  commission_usd?: number;
  exchange_fees_usd?: number;
  entry_slippage_ticks?: number;
  exit_slippage_ticks?: number;
  slippage_usd?: number;
  total_cost_usd?: number;
  pnl_gross_usd?: number;
  pnl_net_usd?: number;
  r_gross?: number | null;
  r_net?: number | null;
  exit_legs?: ExitLeg[];
  cost_model_version?: string;
  commission_schedule_effective_date?: string;
  cost_assumption_source?: string;
}

export interface PositionBuildRequest {
  trade_id: string;
  signal_id: string;
  session_id: string;
  setup: CandidateSetup;
  fill_price: number;
  fill_time_iso: string;
  quantity: number;
  notional_usd: number;
  regime_at_entry: MarketRegime | null;
  strategy_version: string;
  confidence_at_entry: number;
  management_params: PositionManagementParams;
  entry_state_vector?: EntryStateVector | null;
}
