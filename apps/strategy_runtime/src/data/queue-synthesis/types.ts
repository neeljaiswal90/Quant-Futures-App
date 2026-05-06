import type { DatabentoSchema, DataTier } from '../../contracts/tier-policy.js';
import type { UnixNs } from '../../contracts/time.js';

export type CorpusDataTier = DataTier;

export type QueueSynthesisMode =
  | 'mbo_reconstruction'
  | 'mbp_proxy'
  | 'tbbo_trade_proxy';

export type FillProbabilityPpm = number;

export type PassiveOrderSide = 'buy' | 'sell';
export type QueueBookSide = 'bid' | 'ask';

export interface PassiveOrderProbe {
  readonly ts_ns: UnixNs;
  readonly instrument_id: number;
  readonly raw_symbol: string | null;
  readonly side: PassiveOrderSide;
  readonly limit_price: bigint;
  readonly order_quantity: bigint;
  readonly latency_ns: bigint;
}

export type QueueSynthesisConfidence =
  | 'high'
  | 'medium'
  | 'low'
  | 'unverified';

export type QueueSynthesisQualityFlag =
  | 'definition_missing'
  | 'manifest_unverified'
  | 'queue_ahead_unknown'
  | 'queue_state_unavailable'
  | 'trade_depletion_only'
  | 'visible_size_proxy'
  | 'mbo_order_id_missing'
  | 'trade_side_unknown';

export const QUEUE_SYNTHESIS_QUALITY_FLAGS: readonly QueueSynthesisQualityFlag[] = Object.freeze([
  'definition_missing',
  'manifest_unverified',
  'queue_ahead_unknown',
  'queue_state_unavailable',
  'trade_depletion_only',
  'visible_size_proxy',
  'mbo_order_id_missing',
  'trade_side_unknown',
]);

export interface QueueSynthesisSourceMetadata {
  readonly mode: QueueSynthesisMode;
  readonly corpus_tier: CorpusDataTier | null;
  readonly input_schemas: readonly DatabentoSchema[];
  readonly confidence: QueueSynthesisConfidence;
  readonly quality_flags: readonly QueueSynthesisQualityFlag[];
}

export interface QueueStateSnapshot {
  readonly type: 'queue_state_snapshot';
  readonly ts_ns: UnixNs;
  readonly instrument_id: number;
  readonly raw_symbol: string | null;
  readonly side: QueueBookSide;
  readonly price: bigint;
  readonly estimated_queue_ahead: bigint | null;
  readonly estimated_visible_size: bigint | null;
  readonly estimated_trade_depletion: bigint;
  readonly estimated_visible_reduction: bigint;
  readonly source_metadata: QueueSynthesisSourceMetadata;
}

export interface PassiveFillEstimate {
  readonly type: 'passive_fill_estimate';
  readonly ts_ns: UnixNs;
  readonly effective_ts_ns: UnixNs;
  readonly instrument_id: number;
  readonly raw_symbol: string | null;
  readonly side: PassiveOrderSide;
  readonly limit_price: bigint;
  readonly order_quantity: bigint;
  readonly estimated_fill_probability_ppm: FillProbabilityPpm;
  readonly estimated_fill_quantity: bigint;
  readonly source_metadata: QueueSynthesisSourceMetadata;
}

export type QueueSynthesisOutput = QueueStateSnapshot | PassiveFillEstimate;

export interface QueueSynthesisOptions {
  readonly instrument_root: string;
  readonly manifest_symbol: string;
  readonly input_schemas: readonly DatabentoSchema[];
  readonly corpus_tier: CorpusDataTier | null;
  readonly mode: QueueSynthesisMode | 'auto';
  readonly passive_order_quantity: bigint;
  readonly fill_horizon_ns: bigint;
  readonly depletion_lookback_ns: bigint;
  readonly allow_unverified_identity: boolean;
}
