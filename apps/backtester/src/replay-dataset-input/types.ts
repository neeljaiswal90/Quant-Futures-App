export const REPLAY_DATASET_SCHEMA_VERSION = 1 as const;

export const REPLAY_SIGNAL_FAMILIES = Object.freeze([
  'sweep',
  'iceberg',
  'absorption',
  'dislocation',
  'aggressor_flow',
  'vol_regime',
  'institutional_flow',
] as const);

export type ReplaySignalFamily = (typeof REPLAY_SIGNAL_FAMILIES)[number] | string;

export type NormalizedSignalDirection = 'long' | 'short' | 'neutral' | 'unknown';

export type TradeAggressorSide = 'buy' | 'sell' | 'unknown';

export interface ReplayDatasetContext {
  readonly capture_date: string;
  readonly session: string;
  readonly step_ns: bigint;
  readonly source_obs01: string;
  readonly source_mbo: string | null;
  readonly schema_version: number;
}

export interface ReplaySignalRow {
  readonly schema_version: number;
  readonly ts_ns: bigint;
  readonly family: ReplaySignalFamily;
  readonly event_type: string;
  readonly tier: string | null;
  readonly price: number | null;
  readonly level_id: string | null;
  readonly side: string | null;
  readonly direction: string | null;
  readonly zone_context: unknown;
  readonly regime: unknown;
  readonly orderflow_snapshot: unknown;
  readonly depth_snapshot: unknown;
  readonly confluence_stack_size: number | null;
  readonly payload: unknown;
  readonly replay: ReplayDatasetContext;
  readonly raw_line: string;
}

export interface ReplaySignalCandidateSeed {
  readonly seed_schema_version: 1;
  readonly seed_id: string;
  readonly ts_ns: bigint;
  readonly family: ReplaySignalFamily;
  readonly event_type: string;
  readonly signal_price: number | null;
  readonly level_id: string | null;
  readonly side: string | null;
  readonly normalized_direction: NormalizedSignalDirection;
  readonly capture_date: string;
  readonly session: string;
  readonly source_obs01: string;
}

export interface ReplayTradeTick {
  readonly ts_ns: bigint;
  readonly price: number;
  readonly size: number;
  readonly aggressor_side: TradeAggressorSide;
}

export interface ReplayDatasetInput {
  readonly dataset_path: string;
  readonly trade_tape_path: string;
  readonly rows: readonly ReplaySignalRow[];
  readonly trade_tape: readonly ReplayTradeTick[];
}

export interface ReplayDatasetLoadOptions {
  readonly datasetPath: string;
  readonly tradeTapePath?: string;
}

export interface ReplaySignalRowJson {
  readonly schema_version: number;
  readonly ts_ns: string;
  readonly family: ReplaySignalFamily;
  readonly event_type: string;
  readonly tier: string | null;
  readonly price: number | null;
  readonly level_id: string | null;
  readonly side: string | null;
  readonly direction: string | null;
  readonly replay: {
    readonly capture_date: string;
    readonly session: string;
    readonly step_ns: string;
    readonly source_obs01: string;
    readonly source_mbo: string | null;
    readonly schema_version: number;
  };
}

// Timestamp discipline for RA-090b/RA-091:
// all *_ts_ns values are parsed at the JSONL boundary as bigint and remain bigint
// through seed construction, horizon scanning, and label generation. Convert to a
// decimal string only at artifact boundaries. Do not use Number(value) on a
// *_ts_ns value; use cmpNs/addNs/diffNsToMillis helpers instead.

