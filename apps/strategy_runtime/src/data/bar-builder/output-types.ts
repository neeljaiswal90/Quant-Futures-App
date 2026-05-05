import type { UnixNs } from '../../contracts/time.js';
import type { ManifestSymbolCheck } from './manifest-symbol.js';
import type { ContractRoot, ContractRollPolicy, RollDetectionSource } from './roll-policy.js';
import type { BarSourceMetadata } from './source-metadata.js';

export type BarOpenReason = 'stream_start' | 'bar_boundary' | 'contract_roll';

export type BarCloseReason = 'bar_boundary' | 'target_reached' | 'contract_roll' | 'stream_end';

export interface ContractIdentityRef {
  readonly instrument_id: number | null;
  readonly raw_symbol: string | null;
  readonly expiration: UnixNs | null;
}

export interface BuiltBar {
  readonly type: 'bar';
  readonly bar_id: string;
  readonly instrument_root: ContractRoot;
  readonly instrument_id: number | null;
  readonly raw_symbol: string | null;
  readonly bar_spec: string;
  readonly open_reason: BarOpenReason;
  readonly close_reason: BarCloseReason;
  readonly is_complete: boolean;
  readonly roll_boundary_id: string | null;
  readonly manifest_symbol_check: ManifestSymbolCheck;
  readonly source_metadata: BarSourceMetadata;
  readonly bucket_start_ts_ns: UnixNs | null;
  readonly bucket_end_ts_ns: UnixNs | null;
  readonly first_record_ts_ns: UnixNs;
  readonly last_record_ts_ns: UnixNs;
  readonly open: bigint;
  readonly high: bigint;
  readonly low: bigint;
  readonly close: bigint;
  readonly volume: bigint;
}

export interface ContractRollBoundary {
  readonly type: 'contract_roll_boundary';
  readonly boundary_id: string;
  readonly instrument_root: ContractRoot;
  readonly roll_policy: ContractRollPolicy;
  readonly detection_source: RollDetectionSource;
  readonly boundary_ts_ns: UnixNs;
  readonly previous_contract: ContractIdentityRef;
  readonly next_contract: ContractIdentityRef;
  readonly forced_closed_bar_id: string | null;
  readonly manifest_symbol_check: ManifestSymbolCheck;
}

export type BarBuilderOutput = BuiltBar | ContractRollBoundary;
