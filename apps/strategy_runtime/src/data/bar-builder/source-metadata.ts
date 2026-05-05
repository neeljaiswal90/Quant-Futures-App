import type { DataTier, DatabentoSchema } from '../../contracts/tier-policy.js';

export type BarConstructionMethod =
  | 'trade_aggregation'
  | 'ohlcv_passthrough'
  | 'ohlcv_aggregation'
  | 'book_trade_aggregation';

export type ContractIdentitySource =
  | 'definition'
  | 'raw_symbol'
  | 'instrument_id'
  | 'calendar_fallback'
  | 'unverified';

export type BarQualityFlag =
  | 'calendar_roll_fallback'
  | 'definition_missing'
  | 'manifest_unverified'
  | 'ohlcv_source';

export interface BarSourceMetadata {
  readonly corpus_tier: DataTier | null;
  readonly input_schemas: readonly DatabentoSchema[];
  readonly construction_method: BarConstructionMethod;
  readonly contract_identity_source: ContractIdentitySource;
  readonly quality_flags: readonly BarQualityFlag[];
}
