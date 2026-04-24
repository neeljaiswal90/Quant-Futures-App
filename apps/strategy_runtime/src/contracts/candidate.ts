import type { EntryStateLobState, EntryStateOfiReliability } from './market.js';
import type { StrategyId } from './strategy-ids.js';

export type SetupType = StrategyId;

export type SetupFamily =
  | 'trend_pullback'
  | 'breakout_retest'
  | 'opening_drive'
  | 'or_retest'
  | 'failed_or_break'
  | 'momentum_continuation'
  | 'lob_mbo_scalp'
  | 'reversal_reclaim'
  | 'default';

export type MarketRegime =
  | 'trending_up'
  | 'trending_down'
  | 'range_bound'
  | 'breakout_attempt'
  | 'breakdown_attempt'
  | 'compression'
  | 'high_volatility_impulse'
  | 'choppy'
  | 'strong_trend'
  | 'mixed'
  | 'unknown';

export const ENTRY_STATE_VECTOR_SCHEMA_VERSION = '1.0.0';

export interface EntryStateVector {
  schema_version: string;
  timestamp_unix: number;
  direction: 'long' | 'short';
  setup_type: SetupType;
  sigma_pts: number;
  micro_atr: number | null;
  room_atr: number | null;
  session_atr: number | null;
  z_ema9: number | null;
  z_ema21: number | null;
  z_vwap: number | null;
  pullback_ratio: number | null;
  impulse_maturity_bars: number | null;
  regime: MarketRegime | null;
  ofi_10s: number | null;
  ofi_30s: number | null;
  z_ofi_10s: number | null;
  z_ofi_30s: number | null;
  z_ofi_blend: number | null;
  queue_imbalance_5: number | null;
  microprice_offset_pts: number | null;
  lob_state: EntryStateLobState;
  ofi_reliability: EntryStateOfiReliability;
}

export interface FreshnessResult {
  fresh: boolean;
  reason: string;
}

export interface CandidateSetup {
  direction: 'long' | 'short';
  setup_type: SetupType;
  entry_low: number;
  entry_high: number;
  stop: number;
  target_1: number;
  target_2: number;
  target_3: number | null;
  risk_pts: number;
  rr_t1: number;
  rr_t2: number;
  confidence: number;
  confidence_factors: string[];
  reason: string;
  freshness?: FreshnessResult;
  entry_state_vector?: EntryStateVector | null;
  target_1_direction_valid?: boolean;
  target_2_direction_valid?: boolean;
  target_3_direction_valid?: boolean;
  target_ordering_valid?: boolean;
  target_repair_applied?: boolean;
  target_1_quant?: number | null;
  target_2_quant?: number | null;
  bucket_source_quant?: 'cold_start' | 'full' | 'backoff_1d' | 'backoff_2d' | 'side_prior' | null;
  expected_r_30s_quant?: number | null;
  win_prob_30s_quant?: number | null;
  quality_band_quant?: 'A' | 'B' | 'C' | 'D' | null;
  bucket_id_quant?: string | null;
  bucket_sample_count_quant?: number | null;
  quant_shadow_reject_reason?: string | null;
  bucket_lookup_status?: string | null;
}

export interface StrategyEvaluation {
  setupType: SetupType;
  setupFamily: SetupFamily;
  candidate: CandidateSetup | null;
  rejectionReasonPrimary: string | null;
  rejectionReasonAll: string[];
}
