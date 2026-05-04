/**
 * TypeScript contract for the normalized FRED VIXCLS daily series emitted by
 * `scripts/research/fetch-vix-series.py`. Backtests consume this stored JSON
 * artifact instead of calling FRED during replay.
 */

/** One normalized daily VIX observation from FRED VIXCLS. */
export interface VixObservation {
  /** Observation date in `YYYY-MM-DD` format. */
  readonly date: string;
  /** VIX close value, or `null` for FRED missing-value sentinels such as holidays. */
  readonly value: number | null;
}

/** Versioned normalized FRED VIXCLS series artifact. */
export interface VixSeries {
  /** Schema version for the normalized VIX artifact. */
  readonly manifest_schema_version: number;
  /** Upstream data provider name. */
  readonly source: 'FRED';
  /** FRED series identifier. */
  readonly series_id: 'VIXCLS';
  /** Fetch start timestamp in nanoseconds since Unix epoch, emitted by the fetcher. */
  readonly fetch_timestamp_ns: number;
  /** First observation date in the normalized payload. */
  readonly start_date: string;
  /** Last observation date in the normalized payload. */
  readonly end_date: string;
  /** Number of observations in the normalized payload. */
  readonly record_count: number;
  /** Whether any observation has a `null` value. */
  readonly has_missing: boolean;
  /** Number of observations with a `null` value. */
  readonly missing_count: number;
  /** Deterministic sha256 of the canonicalized observations array. */
  readonly sha256: string;
  /** Date-sorted normalized VIX observations. */
  readonly observations: readonly VixObservation[];
}

/** Quartile boundary metadata computed from non-null VIX observations. */
export interface VixQuartileBoundaries {
  /** Highest VIX value included in the lowest-volatility quartile. */
  readonly q1_high: number;
  /** Highest VIX value included in the second quartile. */
  readonly q2_high: number;
  /** Highest VIX value included in the third quartile. */
  readonly q3_high: number;
  /** Number of non-null observations used to compute the boundaries. */
  readonly sample_count: number;
  /** Number of null observations excluded from boundary computation. */
  readonly excluded_null_count: number;
}

/** Deterministic quartile label used by VIX-stratified downstream metrics. */
export type VixQuartile = 'Q1_low' | 'Q2' | 'Q3' | 'Q4_high';
