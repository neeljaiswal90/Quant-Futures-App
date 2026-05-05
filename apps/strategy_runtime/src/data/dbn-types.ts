import type { DatabentoSchema } from '../contracts/tier-policy.js';
import type { UnixNs } from '../contracts/time.js';

export const DBN_MAGIC = Buffer.from([0x44, 0x42, 0x4e, 0x01]);
export const DBN_VERSION = 1;
export const DBN_HEADER_LENGTH_PREFIX_BYTES = 8;
export const DBN_DATASET_OFFSET = 8;
export const DBN_DATASET_LENGTH = 16;
export const DBN_SCHEMA_CODE_OFFSET = 24;
export const DBN_STYPE_IN_CODE_OFFSET = 25;
export const DBN_START_TS_NS_OFFSET = 26;
export const DBN_END_TS_NS_OFFSET = 34;

export type DbnWireSchema =
  | 'mbo'
  | 'mbp-10'
  | 'mbp-1'
  | 'trades'
  | 'tbbo'
  | 'bbo-1s'
  | 'bbo-1m'
  | 'ohlcv-1m'
  | 'definition'
  | 'statistics'
  | 'status';

export type DbnAction = 'A' | 'M' | 'C' | 'T' | 'F';
export type DbnSide = 'B' | 'A' | 'N';
export type DbnStatusFlag = 'Y' | 'N' | '~';
export type DbnBboInterval = '1s' | '1m';

export interface DbnHeader {
  readonly version: 1;
  readonly metadata_length: number;
  readonly dataset: string;
  readonly schema: DatabentoSchema;
  readonly wire_schema: DbnWireSchema;
  readonly stype_in_code: number;
  readonly start_ts_ns: UnixNs;
  readonly end_ts_ns: UnixNs;
  readonly records_offset: number;
}

export interface DbnLevel {
  readonly bid_px: bigint;
  readonly bid_sz: number;
  readonly bid_ct: number;
  readonly ask_px: bigint;
  readonly ask_sz: number;
  readonly ask_ct: number;
}

export interface DbnRecordBase<TSchema extends DatabentoSchema> {
  readonly schema: TSchema;
  readonly ts_event: UnixNs;
  readonly instrument_id: number;
}

export interface DbnMboRecord extends DbnRecordBase<'mbo'> {
  readonly ts_recv: UnixNs;
  readonly action: DbnAction;
  readonly side: DbnSide;
  readonly price: bigint;
  readonly size: number;
  readonly order_id: bigint;
}

export interface DbnMbp10Record extends DbnRecordBase<'mbp-10'> {
  readonly ts_recv: UnixNs;
  readonly action: DbnAction;
  readonly side: DbnSide;
  readonly price: bigint;
  readonly size: number;
  readonly levels: readonly DbnLevel[];
}

export interface DbnMbp1Record extends DbnRecordBase<'mbp-1'> {
  readonly ts_recv: UnixNs;
  readonly action: DbnAction;
  readonly side: DbnSide;
  readonly price: bigint;
  readonly size: number;
  readonly levels: readonly DbnLevel[];
}

export interface DbnTradesRecord extends DbnRecordBase<'trades'> {
  readonly ts_recv: UnixNs;
  readonly price: bigint;
  readonly size: number;
  readonly aggressor_side: DbnSide;
}

export interface DbnTbboRecord extends DbnRecordBase<'tbbo'> {
  readonly ts_recv: UnixNs;
  readonly price: bigint;
  readonly size: number;
  readonly aggressor_side: DbnSide;
  readonly bid_px: bigint;
  readonly bid_sz: number;
  readonly ask_px: bigint;
  readonly ask_sz: number;
}

export interface DbnBboRecord extends DbnRecordBase<'bbo'> {
  readonly bbo_interval: DbnBboInterval;
  readonly ts_recv: UnixNs;
  readonly bid_px: bigint;
  readonly bid_sz: number;
  readonly ask_px: bigint;
  readonly ask_sz: number;
}

export interface DbnOhlcv1mRecord extends DbnRecordBase<'ohlcv-1m'> {
  readonly open: bigint;
  readonly high: bigint;
  readonly low: bigint;
  readonly close: bigint;
  readonly volume: bigint;
}

export interface DbnDefinitionRecord extends DbnRecordBase<'definition'> {
  readonly ts_recv: UnixNs;
  readonly raw_symbol: string;
  readonly expiration: UnixNs;
  readonly tick_size: bigint;
  readonly multiplier: number;
}

export interface DbnStatisticsRecord extends DbnRecordBase<'statistics'> {
  readonly ts_recv: UnixNs;
  readonly ts_ref: UnixNs;
  readonly stat_type: number;
  readonly price: bigint;
  readonly quantity: bigint;
  readonly update_action: number;
  readonly stat_flags: number;
  readonly channel_id: number;
}

export interface DbnStatusRecord extends DbnRecordBase<'status'> {
  readonly ts_recv: UnixNs;
  readonly status_code: number;
  readonly reason_code: number;
  readonly trading_event_code: number;
  readonly is_trading: DbnStatusFlag;
  readonly is_quoting: DbnStatusFlag;
  readonly is_short_sell_restricted: DbnStatusFlag;
}

export type DbnRecord =
  | DbnMboRecord
  | DbnMbp10Record
  | DbnMbp1Record
  | DbnTradesRecord
  | DbnTbboRecord
  | DbnBboRecord
  | DbnOhlcv1mRecord
  | DbnDefinitionRecord
  | DbnStatisticsRecord
  | DbnStatusRecord;

export const DBN_WIRE_SCHEMA_CODE_MAP: Readonly<Record<number, DbnWireSchema>> = Object.freeze({
  0: 'mbo',
  1: 'mbp-1',
  2: 'mbp-10',
  3: 'tbbo',
  4: 'trades',
  6: 'ohlcv-1m',
  9: 'definition',
  10: 'statistics',
  11: 'status',
  18: 'bbo-1s',
  19: 'bbo-1m',
});

export const DBN_RECORD_LENGTHS: Readonly<Record<DbnWireSchema, number>> = Object.freeze({
  mbo: 56,
  'mbp-10': 368,
  'mbp-1': 80,
  trades: 48,
  tbbo: 80,
  'bbo-1s': 80,
  'bbo-1m': 80,
  'ohlcv-1m': 56,
  definition: 520,
  statistics: 80,
  status: 40,
});

export function normalizeWireSchema(wireSchema: DbnWireSchema): DatabentoSchema {
  if (wireSchema === 'bbo-1s' || wireSchema === 'bbo-1m') {
    return 'bbo';
  }
  return wireSchema;
}
