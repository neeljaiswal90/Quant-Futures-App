import type { UnixNs } from '../../../../strategy_runtime/src/contracts/time.js';

export type OfiFidelityStatus =
  | 'pass'
  | 'fail'
  | 'insufficient_data'
  | 'insufficient_variance'
  | 'skipped_archive_missing';

export type OfiRegime = 'baseline' | 'stress' | string;

export interface OfiFidelityPolicy {
  readonly policy_schema_version: 1;
  readonly bucket: '1s';
  readonly min_bucket_count: number;
  readonly min_pearson_r_ppm: number;
  readonly zscore_epsilon_ppm: number;
  readonly reference_depth_levels: number;
  readonly reference_mode: 'mbp10_unweighted_depth_sum';
  readonly synthesized_mode: 'mbp1_trades_imbalance';
}

export interface OfiBucket {
  readonly bucket_start_ts_ns: UnixNs;
  readonly bucket_end_ts_ns: UnixNs;
  readonly ofi: bigint;
  readonly event_count: number;
  readonly missing_depth_level_count: number;
  readonly unknown_trade_side_count: number;
}

export interface AlignedOfiBucket {
  readonly bucket_start_ts_ns: UnixNs;
  readonly reference_ofi: bigint;
  readonly synthesized_ofi: bigint;
}

export interface OfiSeriesStats {
  readonly mean: number;
  readonly std: number;
}

export interface OfiFidelityRegimeResult {
  readonly regime: OfiRegime;
  readonly status: OfiFidelityStatus;
  readonly bucket_count: number;
  readonly pearson_r_ppm: number | null;
  readonly threshold_ppm: number;
  readonly reference_mean: number | null;
  readonly synthesized_mean: number | null;
  readonly reference_std: number | null;
  readonly synthesized_std: number | null;
  readonly missing_depth_level_count: number;
  readonly unknown_trade_side_count: number;
}

export interface OfiFidelityResult {
  readonly result_schema_version: 1;
  readonly policy: OfiFidelityPolicy;
  readonly regimes: readonly OfiFidelityRegimeResult[];
}

export interface OfiFidelityRegimeInput {
  readonly regime: OfiRegime;
  readonly reference: readonly OfiBucket[];
  readonly synthesized: readonly OfiBucket[];
}
