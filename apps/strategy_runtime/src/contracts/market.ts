export interface OhlcvBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Bar = OhlcvBar;

export interface IndicatorSnapshot {
  ema_9: number | null;
  ema_21: number | null;
  ema_50: number | null;
  ema_200?: number | null;
  rsi_14: number | null;
  atr_14: number | null;
  vwap: number | null;
  adx: number | null;
  di_plus: number | null;
  di_minus: number | null;
  volume_sma_20?: number | null;
  ttm_squeeze_firing?: boolean | null;
  supertrend_direction: 'up' | 'down' | null;
  smart_money_bos_buy?: number | null;
  smart_money_bos_sell?: number | null;
  smart_money_choch_buy?: number | null;
  smart_money_choch_sell?: number | null;
}

export type HtfZoneKind = 'RES' | 'SUP';

export interface HtfZone {
  id: string;
  kind: HtfZoneKind;
  timeframe: string;
  level: number;
  top: number;
  bottom: number;
  atr: number | null;
  pivot_len: number | null;
  source_ts: number | null;
  distance_pts: number | null;
  distance_atr: number | null;
  contains_price: boolean;
}

export interface HtfContext {
  study_present: boolean;
  study_name: string | null;
  fetched_at_iso: string | null;
  resistance_zones: HtfZone[];
  support_zones: HtfZone[];
  nearest_resistance: HtfZone | null;
  nearest_support: HtfZone | null;
  inside_resistance_zone: boolean;
  inside_support_zone: boolean;
}

export interface HtfZonesConfig {
  enabled: boolean;
  study_filter: string;
  max_labels: number;
  hard_veto_enabled: boolean;
  hard_veto_timeframes: string[];
  min_first_obstacle_rr: number;
  warn_distance_atr: number;
  hard_veto_inside_major_zone: boolean;
  allow_breakout_acceptance_override: boolean;
  score_penalty_15m_res: number;
  score_penalty_1h_res: number;
  score_penalty_4h_res: number;
  score_penalty_obstacle_before_t1: number;
  score_bonus_near_support: number;
  score_bonus_reclaimed_support: number;
}

export interface HtfSetupEvaluation {
  first_obstacle_rr: number | null;
  location_quality: 'good' | 'warning' | 'poor' | null;
  score_adjustment: number;
  score_factors: string[];
  vetoed: boolean;
  veto_reason: string | null;
  breakout_accepted: boolean;
  nearest_obstacle: HtfZone | null;
  nearest_support_zone: HtfZone | null;
}

export interface KeyLevels {
  daily_open: number | null;
  weekly_open: number | null;
  session_high: number | null;
  session_low: number | null;
  opening_range_high: number | null;
  opening_range_low: number | null;
  prior_rth_high: number | null;
  prior_rth_low: number | null;
  bos_buy: number | null;
  bos_sell: number | null;
  choch_buy: number | null;
  choch_sell: number | null;
  pivot_resistance: number[];
  pivot_support: number[];
}

export interface SessionContext {
  is_rth?: boolean;
  is_eth?: boolean;
  strategy_bucket?: string | null;
}

export interface MarketSnapshot {
  symbol: string;
  timestamp_unix: number;
  price: number;
  bars_1m: OhlcvBar[];
  bars_5m: OhlcvBar[];
  bars_15m?: OhlcvBar[];
  indicators_1m: IndicatorSnapshot;
  key_levels: KeyLevels;
  session?: SessionContext | null;
  htf_context?: HtfContext | null;
}

export type EntryStateLobState = 'missing' | 'stale' | 'invalid' | 'fresh' | 'sparse';
export type EntryStateOfiReliability = 'full' | 'sparse' | 'unknown';

export interface LobSnapshot {
  timestamp_ms: number;
  bbo_age_ms: number;
  data_quality: 'full_depth' | 'partial_depth' | 'stale' | 'unavailable';
  recording_context?: string | null;
  bid: number | null;
  ask: number | null;
  mid?: number | null;
  bid_size: number | null;
  ask_size: number | null;
  spread_pts?: number | null;
  spread_ticks?: number | null;
  depth_imbalance_5?: number | null;
  depth_imbalance_10?: number | null;
  total_bid_depth_10lvl?: number | null;
  total_ask_depth_10lvl?: number | null;
  cumulative_delta_10s?: number | null;
  cumulative_delta_30s?: number | null;
  trade_flow_imbalance_10s?: number | null;
  cancel_add_ratio_10s?: number | null;
  replenishment_ratio_10s?: number | null;
  queue_imbalance_5?: number | null;
  sweep_count_10s?: number | null;
  sweep_volume_10s?: number | null;
  max_sweep_levels_10s?: number | null;
  last_sweep_side?: 'buy' | 'sell' | 'unknown' | null;
  distance_from_poc_pts?: number | null;
  distance_from_value_area_low_pts?: number | null;
  distance_from_value_area_high_pts?: number | null;
  inside_value_area?: boolean | null;
}
