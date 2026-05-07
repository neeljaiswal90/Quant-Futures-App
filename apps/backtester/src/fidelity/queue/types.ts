import type { UnixNs } from '../../../../strategy_runtime/src/contracts/time.js';
import type { QueueSynthesisMode } from '../../../../strategy_runtime/src/data/queue-synthesis/types.js';

export type QueueFidelitySide = 'buy' | 'sell';

export type QueueFidelityStatus =
  | 'pass'
  | 'fail'
  | 'insufficient_data'
  | 'reference_unavailable'
  | 'synthesized_unavailable'
  | 'skipped_archive_missing';

export type QueueFidelityProbeStatus =
  | 'compared'
  | 'reference_unavailable'
  | 'synthesized_unavailable';

export interface QueueFidelityProbePolicy {
  readonly policy_schema_version: 1;
  readonly sample_interval: '1s';
  readonly fill_horizon_ns: bigint;
  readonly depletion_lookback_ns: bigint;
  readonly order_quantity: bigint;
  readonly sides: readonly ['buy', 'sell'];
}

export interface QueueFidelityPolicy extends QueueFidelityProbePolicy {
  readonly tolerance_ppm: number;
  readonly min_comparable_probes: number;
  readonly min_within_tolerance_share_ppm: number;
  readonly synthesized_mode: 'qfa105_mbp_proxy_mbp1_only';
}

export interface QueueFidelityProbe {
  readonly probe_id: string;
  readonly ts_ns: UnixNs;
  readonly instrument_id: number;
  readonly raw_symbol: string | null;
  readonly side: QueueFidelitySide;
  readonly limit_price: bigint;
  readonly quantity: bigint;
  readonly fill_horizon_ns: bigint;
  readonly depletion_lookback_ns: bigint;
}

export interface QueueFidelityProbeResult {
  readonly probe_id: string;
  readonly ts_ns: UnixNs;
  readonly side: QueueFidelitySide;
  readonly limit_price: bigint;
  readonly quantity: bigint;
  readonly reference_fill_probability_ppm: number | null;
  readonly synthesized_fill_probability_ppm: number | null;
  readonly absolute_error_ppm: number | null;
  readonly within_tolerance: boolean | null;
  readonly status: QueueFidelityProbeStatus;
  readonly synthesized_source_mode: QueueSynthesisMode | null;
}

export interface QueueFidelityRegimeResult {
  readonly regime: 'baseline' | 'stress' | string;
  readonly status: QueueFidelityStatus;
  readonly total_probes: number;
  readonly comparable_probes: number;
  readonly within_tolerance_probes: number;
  readonly within_tolerance_share_ppm: number | null;
  readonly tolerance_ppm: number;
  readonly threshold_ppm: number;
}

export interface QueueFidelityRegimeInput {
  readonly regime: 'baseline' | 'stress' | string;
  readonly probe_results: readonly QueueFidelityProbeResult[];
}

export interface QueueFidelityResult {
  readonly result_schema_version: 1;
  readonly policy: QueueFidelityPolicy;
  readonly regimes: readonly QueueFidelityRegimeResult[];
}

export const DEFAULT_QUEUE_FIDELITY_POLICY_V1: QueueFidelityPolicy = Object.freeze({
  policy_schema_version: 1,
  sample_interval: '1s',
  fill_horizon_ns: 5_000_000_000n,
  depletion_lookback_ns: 30_000_000_000n,
  order_quantity: 1n,
  sides: Object.freeze(['buy', 'sell'] as const),
  tolerance_ppm: 100_000,
  min_comparable_probes: 300,
  min_within_tolerance_share_ppm: 800_000,
  // QFA-402 v1 intentionally uses the existing QFA-105 MBP proxy path. Trades
  // are present in the Tier A archive, but QFA-105 only consumes trades in the
  // TBBO+trades mode, and TBBO is absent from the locked corpus.
  synthesized_mode: 'qfa105_mbp_proxy_mbp1_only',
});
