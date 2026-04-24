import type { MarketRegime, SetupType, SetupFamily } from '../contracts/candidate.js';
import type { BoundBy, ConfidenceSource, PositionTargetConfig, TargetActionKind } from './target-position.js';

export interface ManagementProfile {
  name: string;
  family: SetupFamily;
  pt1_offset_atr: number;
  pt2_offset_atr: number;
  pt1_offset_pts_fallback: number;
  pt2_offset_pts_fallback: number;
  pt1_exit_fraction: number;
  pt2_exit_fraction: number;
  pt1_move_to_be: boolean;
  pt1_activate_trailing: boolean;
  trail_atr_post_t1: number;
  trail_ticks_post_t1_fallback: number;
  breakeven_trigger_r: number;
  pre_t1_trail_trigger_r: number;
  pre_t1_trail_atr: number;
  pre_t1_trail_ticks_fallback: number;
  time_stop_minutes: number;
  time_stop_max_r_pre_t1: number;
  time_stop_max_r_post_t1: number;
  pre_t1_failure_exit_enabled?: boolean;
  pre_t1_failure_shadow_mode?: boolean;
  pre_t1_failure_decay_min_gap_minutes?: number;
  pre_t1_failure_lambda_net?: number;
  pre_t1_failure_soft_min_minutes?: number;
  pre_t1_failure_soft_progress_rate_max?: number;
  pre_t1_failure_soft_failure_ratio_min?: number;
  pre_t1_failure_hard_min_minutes?: number;
  pre_t1_failure_hard_current_r_alpha?: number;
  pre_t1_failure_curves_key?: string;
  pre_t1_failure_min_n_per_bucket?: number;
  pre_t1_failure_emergency_min_minutes?: number;
  pre_t1_failure_emergency_mae_r_floor?: number;
  pre_t1_failure_emergency_failure_ratio_min?: number;
  pre_t1_failure_emergency_peak_r_max?: number;
  pre_t1_failure_emergency_decay_rate_min?: number;
  pre_t1_failure_cost_r?: number;
  time_stop_seconds?: number | null;
  scalper_hard_cap_seconds?: number | null;
  scalper_no_progress_seconds?: number | null;
  scalper_micro_stop_min_ticks?: number | null;
  scalper_micro_stop_max_ticks?: number | null;
}

export interface ResolvedManagementParams {
  profile_name: string;
  family: SetupFamily;
  atr_at_entry: number | null;
  pt1_offset_pts: number;
  pt2_offset_pts: number;
  pt1_exit_fraction: number;
  pt2_exit_fraction: number;
  pt1_move_to_be: boolean;
  pt1_activate_trailing: boolean;
  trail_ticks_post_t1: number;
  breakeven_trigger_r: number;
  pre_t1_trail_trigger_r: number;
  pre_t1_trail_distance_ticks: number;
  time_stop_minutes: number;
  time_stop_max_r_pre_t1: number;
  time_stop_max_r_post_t1: number;
  pre_t1_failure_exit_enabled: boolean;
  pre_t1_failure_shadow_mode: boolean;
  pre_t1_failure_decay_min_gap_minutes: number;
  pre_t1_failure_lambda_net: number;
  pre_t1_failure_soft_min_minutes: number;
  pre_t1_failure_soft_progress_rate_max: number;
  pre_t1_failure_soft_failure_ratio_min: number;
  pre_t1_failure_hard_min_minutes: number;
  pre_t1_failure_hard_current_r_alpha: number;
  pre_t1_failure_curves_key: string;
  pre_t1_failure_min_n_per_bucket: number;
  pre_t1_failure_emergency_min_minutes: number;
  pre_t1_failure_emergency_mae_r_floor: number;
  pre_t1_failure_emergency_failure_ratio_min: number;
  pre_t1_failure_emergency_peak_r_max: number;
  pre_t1_failure_emergency_decay_rate_min: number;
  pre_t1_failure_cost_r: number;
  time_stop_seconds?: number | null;
  scalper_hard_cap_seconds?: number | null;
  scalper_no_progress_seconds?: number | null;
  scalper_micro_stop_min_ticks?: number | null;
  scalper_micro_stop_max_ticks?: number | null;
}

export interface ManagementFeatures {
  side: 'long' | 'short';
  setup_type: SetupType;
  current_price: number;
  unrealized_pnl_pts: number;
  initial_risk_pts: number;
  current_r: number;
  mfe_r: number;
  mae_r: number;
  hold_seconds: number;
  time_stop_remaining_seconds: number;
  distance_to_stop_pts: number;
  distance_to_stop_atr: number | null;
  distance_to_t1_pts: number;
  distance_to_t1_atr: number | null;
  distance_to_t2_pts: number;
  distance_to_t2_atr: number | null;
  partial_exit_done: boolean;
  pt1_done: boolean;
  pt2_done: boolean;
  quantity_remaining: number;
  quantity_original: number;
  realized_pnl_usd: number;
  atr_14: number | null;
  adx: number | null;
  di_plus: number | null;
  di_minus: number | null;
  rsi_14: number | null;
  vwap_distance_pts: number | null;
  vwap_distance_atr: number | null;
  ema_alignment: 'bullish' | 'bearish' | 'mixed' | null;
  ema_9_21_gap_pts: number | null;
  cvd_trend: 'up' | 'down' | null;
  volume_ratio: number | null;
  regime: MarketRegime | null;
  session_bucket: string | null;
  ttm_squeeze_firing: boolean | null;
  daily_loss_pct: number;
  max_daily_loss_pct: number;
  account_equity: number;
  max_risk_per_trade_pct: number;
}

export interface TradePoP {
  pop_target1_before_stop: number;
  pop_target2_before_stop: number;
  pop_runner_extension: number;
  model_name: string;
  model_version: string;
  confidence_in_estimate: 'high' | 'medium' | 'low';
}

export interface ProbabilityModel {
  readonly name: string;
  readonly version: string;
  computePoP(features: ManagementFeatures): TradePoP;
}

export type ManagementState = 'HOLD' | 'REDUCE' | 'MOVE_STOP' | 'EXIT_NOW';

export interface ManagementTargetPositionSnapshot {
  q_target: number;
  q_risk: number;
  q_softcap: number;
  q_hardcap: number;
  bound_by: BoundBy;
  bound_by_all: BoundBy[];
  delta: number;
  action_kind: TargetActionKind;
  action_qty: number;
  confidence_raw: number;
  confidence_factor: number;
  confidence_source: ConfidenceSource;
  regime_factor: number;
  session_factor: number;
  drawdown_factor: number;
  from_stale_cache: boolean;
  small_drop_cycles_consecutive: number;
  cooldown_remaining_sec: number;
  bracket_sync_block_active: boolean;
}

export interface ManagementMetrics {
  features: ManagementFeatures;
  pop: TradePoP;
  unrealized_pnl_usd: number;
  expected_value_hold_usd: number;
  expected_value_exit_now_usd: number;
  expected_value_reduce_usd: number;
  ev_hold_vs_exit_delta: number;
  management_state: ManagementState;
  management_state_reason: string;
  decision_factors: string[];
  timestamp_iso: string;
  target_position: ManagementTargetPositionSnapshot | null;
  requested_qty_to_exit: number | null;
}
