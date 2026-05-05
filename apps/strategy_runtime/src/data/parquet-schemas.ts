import { createRequire } from 'node:module';
import type { DatabentoSchema } from '../contracts/tier-policy.js';
import { ns, type UnixNs } from '../contracts/time.js';
import type {
  DbnAction,
  DbnBboInterval,
  DbnBboRecord,
  DbnDefinitionRecord,
  DbnLevel,
  DbnMboRecord,
  DbnMbp10Record,
  DbnMbp1Record,
  DbnOhlcv1mRecord,
  DbnRecord,
  DbnSide,
  DbnStatisticsRecord,
  DbnStatusFlag,
  DbnStatusRecord,
  DbnTbboRecord,
  DbnTradesRecord,
} from './dbn-types.js';

const require = createRequire(import.meta.url);
const parquet = require('parquetjs-lite') as {
  ParquetSchema: new (definition: Record<string, unknown>) => unknown;
};

export const PARQUET_FORMAT_VERSION = 1;
export const PARQUET_BIGINT_ENCODING_KEY = 'qfa_bigint_encoding';
// Future encoding versions must dispatch on this marker at read time instead of assuming v1.
export const PARQUET_BIGINT_ENCODING_VALUE = 'utf8_decimal_v1';
export const PARQUET_SCHEMA_KEY = 'qfa_schema';
export const PARQUET_FORMAT_VERSION_KEY = 'qfa_parquet_format_version';

const BIGINT_DECIMAL_PATTERN = /^-?(0|[1-9][0-9]{0,19})$/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = (2n ** 63n) - 1n;

type ParquetRow = Record<string, unknown>;
export type ParquetSchemaLike = unknown;

export class ParquetCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParquetCacheError';
  }
}

function bigintColumn(): Record<string, unknown> {
  return { type: 'UTF8' };
}

function stringColumn(optional = false): Record<string, unknown> {
  return optional ? { type: 'UTF8', optional: true } : { type: 'UTF8' };
}

function int32Column(optional = false): Record<string, unknown> {
  return optional ? { type: 'INT32', optional: true } : { type: 'INT32' };
}

function encodeBigInt(value: bigint, fieldPath: string): string {
  if (value < INT64_MIN || value > INT64_MAX) {
    throw new ParquetCacheError(
      `Bigint field ${fieldPath} is outside supported INT64 bounds for parquet cache encoding`,
    );
  }
  return value.toString();
}

function decodeBigInt(value: unknown, fieldPath: string): bigint {
  if (typeof value !== 'string') {
    throw new ParquetCacheError(`Expected ${fieldPath} to be a decimal string, received ${typeof value}`);
  }
  if (!BIGINT_DECIMAL_PATTERN.test(value)) {
    throw new ParquetCacheError(`Invalid bigint encoding for ${fieldPath}: ${value}`);
  }
  const parsed = BigInt(value);
  if (parsed < INT64_MIN || parsed > INT64_MAX) {
    throw new ParquetCacheError(`Decoded bigint for ${fieldPath} is outside INT64 bounds: ${value}`);
  }
  return parsed;
}

function decodeUnixNs(value: unknown, fieldPath: string): UnixNs {
  return ns(decodeBigInt(value, fieldPath));
}

function expectString(value: unknown, fieldPath: string): string {
  if (typeof value !== 'string') {
    throw new ParquetCacheError(`Expected ${fieldPath} to be a string, received ${typeof value}`);
  }
  return value;
}

function expectNumber(value: unknown, fieldPath: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ParquetCacheError(`Expected ${fieldPath} to be an integer number, received ${String(value)}`);
  }
  return value;
}

function decodeAction(value: unknown, fieldPath: string): DbnAction {
  const stringValue = expectString(value, fieldPath);
  if (stringValue === 'A' || stringValue === 'M' || stringValue === 'C' || stringValue === 'T' || stringValue === 'F') {
    return stringValue;
  }
  throw new ParquetCacheError(`Invalid action at ${fieldPath}: ${stringValue}`);
}

function decodeSide(value: unknown, fieldPath: string): DbnSide {
  const stringValue = expectString(value, fieldPath);
  if (stringValue === 'B' || stringValue === 'A' || stringValue === 'N') {
    return stringValue;
  }
  throw new ParquetCacheError(`Invalid side at ${fieldPath}: ${stringValue}`);
}

function decodeStatusFlag(value: unknown, fieldPath: string): DbnStatusFlag {
  const stringValue = expectString(value, fieldPath);
  if (stringValue === 'Y' || stringValue === 'N' || stringValue === '~') {
    return stringValue;
  }
  throw new ParquetCacheError(`Invalid status flag at ${fieldPath}: ${stringValue}`);
}

function decodeBboInterval(value: unknown, fieldPath: string): DbnBboInterval {
  const stringValue = expectString(value, fieldPath);
  if (stringValue === '1s' || stringValue === '1m') {
    return stringValue;
  }
  throw new ParquetCacheError(`Invalid bbo interval at ${fieldPath}: ${stringValue}`);
}

function encodeLevel(level: DbnLevel): ParquetRow {
  return {
    bid_px: encodeBigInt(level.bid_px, 'levels[].bid_px'),
    bid_sz: level.bid_sz,
    bid_ct: level.bid_ct,
    ask_px: encodeBigInt(level.ask_px, 'levels[].ask_px'),
    ask_sz: level.ask_sz,
    ask_ct: level.ask_ct,
  };
}

function decodeLevels(value: unknown, fieldPath: string): readonly DbnLevel[] {
  if (!Array.isArray(value)) {
    throw new ParquetCacheError(`Expected ${fieldPath} to be an array`);
  }
  return Object.freeze(
    value.map((entry, index) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new ParquetCacheError(`Expected ${fieldPath}[${index}] to be an object`);
      }
      const row = entry as ParquetRow;
      return Object.freeze({
        bid_px: decodeBigInt(row.bid_px, `${fieldPath}[${index}].bid_px`),
        bid_sz: expectNumber(row.bid_sz, `${fieldPath}[${index}].bid_sz`),
        bid_ct: expectNumber(row.bid_ct, `${fieldPath}[${index}].bid_ct`),
        ask_px: decodeBigInt(row.ask_px, `${fieldPath}[${index}].ask_px`),
        ask_sz: expectNumber(row.ask_sz, `${fieldPath}[${index}].ask_sz`),
        ask_ct: expectNumber(row.ask_ct, `${fieldPath}[${index}].ask_ct`),
      });
    }),
  );
}

const LEVELS_DEFINITION = {
  repeated: true,
  fields: {
    bid_px: bigintColumn(),
    bid_sz: int32Column(),
    bid_ct: int32Column(),
    ask_px: bigintColumn(),
    ask_sz: int32Column(),
    ask_ct: int32Column(),
  },
};

export const PARQUET_SCHEMAS: Readonly<Record<DatabentoSchema, ParquetSchemaLike>> = Object.freeze({
  mbo: new parquet.ParquetSchema({
    ts_event: bigintColumn(),
    ts_recv: bigintColumn(),
    instrument_id: int32Column(),
    action: stringColumn(),
    side: stringColumn(),
    price: bigintColumn(),
    size: int32Column(),
    order_id: bigintColumn(),
  }),
  'mbp-10': new parquet.ParquetSchema({
    ts_event: bigintColumn(),
    ts_recv: bigintColumn(),
    instrument_id: int32Column(),
    action: stringColumn(),
    side: stringColumn(),
    price: bigintColumn(),
    size: int32Column(),
    levels: LEVELS_DEFINITION,
  }),
  'mbp-1': new parquet.ParquetSchema({
    ts_event: bigintColumn(),
    ts_recv: bigintColumn(),
    instrument_id: int32Column(),
    action: stringColumn(),
    side: stringColumn(),
    price: bigintColumn(),
    size: int32Column(),
    levels: LEVELS_DEFINITION,
  }),
  trades: new parquet.ParquetSchema({
    ts_event: bigintColumn(),
    ts_recv: bigintColumn(),
    instrument_id: int32Column(),
    price: bigintColumn(),
    size: int32Column(),
    aggressor_side: stringColumn(),
  }),
  tbbo: new parquet.ParquetSchema({
    ts_event: bigintColumn(),
    ts_recv: bigintColumn(),
    instrument_id: int32Column(),
    price: bigintColumn(),
    size: int32Column(),
    aggressor_side: stringColumn(),
    bid_px: bigintColumn(),
    bid_sz: int32Column(),
    ask_px: bigintColumn(),
    ask_sz: int32Column(),
  }),
  bbo: new parquet.ParquetSchema({
    bbo_interval: stringColumn(),
    ts_event: bigintColumn(),
    ts_recv: bigintColumn(),
    instrument_id: int32Column(),
    bid_px: bigintColumn(),
    bid_sz: int32Column(),
    ask_px: bigintColumn(),
    ask_sz: int32Column(),
  }),
  'ohlcv-1m': new parquet.ParquetSchema({
    ts_event: bigintColumn(),
    instrument_id: int32Column(),
    open: bigintColumn(),
    high: bigintColumn(),
    low: bigintColumn(),
    close: bigintColumn(),
    volume: bigintColumn(),
  }),
  definition: new parquet.ParquetSchema({
    ts_event: bigintColumn(),
    ts_recv: bigintColumn(),
    instrument_id: int32Column(),
    raw_symbol: stringColumn(),
    expiration: bigintColumn(),
    tick_size: bigintColumn(),
    multiplier: int32Column(),
  }),
  statistics: new parquet.ParquetSchema({
    ts_event: bigintColumn(),
    ts_recv: bigintColumn(),
    ts_ref: bigintColumn(),
    instrument_id: int32Column(),
    stat_type: int32Column(),
    price: bigintColumn(),
    quantity: bigintColumn(),
    update_action: int32Column(),
    stat_flags: int32Column(),
    channel_id: int32Column(),
  }),
  status: new parquet.ParquetSchema({
    ts_event: bigintColumn(),
    ts_recv: bigintColumn(),
    instrument_id: int32Column(),
    status_code: int32Column(),
    reason_code: int32Column(),
    trading_event_code: int32Column(),
    is_trading: stringColumn(),
    is_quoting: stringColumn(),
    is_short_sell_restricted: stringColumn(),
  }),
});

export function dbnToParquetRecord(record: DbnRecord): ParquetRow {
  switch (record.schema) {
    case 'mbo':
      return {
        ts_event: encodeBigInt(record.ts_event, 'ts_event'),
        ts_recv: encodeBigInt(record.ts_recv, 'ts_recv'),
        instrument_id: record.instrument_id,
        action: record.action,
        side: record.side,
        price: encodeBigInt(record.price, 'price'),
        size: record.size,
        order_id: encodeBigInt(record.order_id, 'order_id'),
      };
    case 'mbp-10':
    case 'mbp-1':
      return {
        ts_event: encodeBigInt(record.ts_event, 'ts_event'),
        ts_recv: encodeBigInt(record.ts_recv, 'ts_recv'),
        instrument_id: record.instrument_id,
        action: record.action,
        side: record.side,
        price: encodeBigInt(record.price, 'price'),
        size: record.size,
        levels: record.levels.map(encodeLevel),
      };
    case 'trades':
      return {
        ts_event: encodeBigInt(record.ts_event, 'ts_event'),
        ts_recv: encodeBigInt(record.ts_recv, 'ts_recv'),
        instrument_id: record.instrument_id,
        price: encodeBigInt(record.price, 'price'),
        size: record.size,
        aggressor_side: record.aggressor_side,
      };
    case 'tbbo':
      return {
        ts_event: encodeBigInt(record.ts_event, 'ts_event'),
        ts_recv: encodeBigInt(record.ts_recv, 'ts_recv'),
        instrument_id: record.instrument_id,
        price: encodeBigInt(record.price, 'price'),
        size: record.size,
        aggressor_side: record.aggressor_side,
        bid_px: encodeBigInt(record.bid_px, 'bid_px'),
        bid_sz: record.bid_sz,
        ask_px: encodeBigInt(record.ask_px, 'ask_px'),
        ask_sz: record.ask_sz,
      };
    case 'bbo':
      return {
        bbo_interval: record.bbo_interval,
        ts_event: encodeBigInt(record.ts_event, 'ts_event'),
        ts_recv: encodeBigInt(record.ts_recv, 'ts_recv'),
        instrument_id: record.instrument_id,
        bid_px: encodeBigInt(record.bid_px, 'bid_px'),
        bid_sz: record.bid_sz,
        ask_px: encodeBigInt(record.ask_px, 'ask_px'),
        ask_sz: record.ask_sz,
      };
    case 'ohlcv-1m':
      return {
        ts_event: encodeBigInt(record.ts_event, 'ts_event'),
        instrument_id: record.instrument_id,
        open: encodeBigInt(record.open, 'open'),
        high: encodeBigInt(record.high, 'high'),
        low: encodeBigInt(record.low, 'low'),
        close: encodeBigInt(record.close, 'close'),
        volume: encodeBigInt(record.volume, 'volume'),
      };
    case 'definition':
      return {
        ts_event: encodeBigInt(record.ts_event, 'ts_event'),
        ts_recv: encodeBigInt(record.ts_recv, 'ts_recv'),
        instrument_id: record.instrument_id,
        raw_symbol: record.raw_symbol,
        expiration: encodeBigInt(record.expiration, 'expiration'),
        tick_size: encodeBigInt(record.tick_size, 'tick_size'),
        multiplier: record.multiplier,
      };
    case 'statistics':
      return {
        ts_event: encodeBigInt(record.ts_event, 'ts_event'),
        ts_recv: encodeBigInt(record.ts_recv, 'ts_recv'),
        ts_ref: encodeBigInt(record.ts_ref, 'ts_ref'),
        instrument_id: record.instrument_id,
        stat_type: record.stat_type,
        price: encodeBigInt(record.price, 'price'),
        quantity: encodeBigInt(record.quantity, 'quantity'),
        update_action: record.update_action,
        stat_flags: record.stat_flags,
        channel_id: record.channel_id,
      };
    case 'status':
      return {
        ts_event: encodeBigInt(record.ts_event, 'ts_event'),
        ts_recv: encodeBigInt(record.ts_recv, 'ts_recv'),
        instrument_id: record.instrument_id,
        status_code: record.status_code,
        reason_code: record.reason_code,
        trading_event_code: record.trading_event_code,
        is_trading: record.is_trading,
        is_quoting: record.is_quoting,
        is_short_sell_restricted: record.is_short_sell_restricted,
      };
  }
}

export function parquetToDbnRecord(row: unknown, schema: DatabentoSchema): DbnRecord {
  if (typeof row !== 'object' || row === null) {
    throw new ParquetCacheError('Parquet row must be an object');
  }
  const value = row as ParquetRow;
  switch (schema) {
    case 'mbo':
      return Object.freeze<DbnMboRecord>({
        schema,
        ts_event: decodeUnixNs(value.ts_event, 'ts_event'),
        ts_recv: decodeUnixNs(value.ts_recv, 'ts_recv'),
        instrument_id: expectNumber(value.instrument_id, 'instrument_id'),
        action: decodeAction(value.action, 'action'),
        side: decodeSide(value.side, 'side'),
        price: decodeBigInt(value.price, 'price'),
        size: expectNumber(value.size, 'size'),
        order_id: decodeBigInt(value.order_id, 'order_id'),
      });
    case 'mbp-10':
      return Object.freeze<DbnMbp10Record>({
        schema,
        ts_event: decodeUnixNs(value.ts_event, 'ts_event'),
        ts_recv: decodeUnixNs(value.ts_recv, 'ts_recv'),
        instrument_id: expectNumber(value.instrument_id, 'instrument_id'),
        action: decodeAction(value.action, 'action'),
        side: decodeSide(value.side, 'side'),
        price: decodeBigInt(value.price, 'price'),
        size: expectNumber(value.size, 'size'),
        levels: decodeLevels(value.levels, 'levels'),
      });
    case 'mbp-1':
      return Object.freeze<DbnMbp1Record>({
        schema,
        ts_event: decodeUnixNs(value.ts_event, 'ts_event'),
        ts_recv: decodeUnixNs(value.ts_recv, 'ts_recv'),
        instrument_id: expectNumber(value.instrument_id, 'instrument_id'),
        action: decodeAction(value.action, 'action'),
        side: decodeSide(value.side, 'side'),
        price: decodeBigInt(value.price, 'price'),
        size: expectNumber(value.size, 'size'),
        levels: decodeLevels(value.levels, 'levels'),
      });
    case 'trades':
      return Object.freeze<DbnTradesRecord>({
        schema,
        ts_event: decodeUnixNs(value.ts_event, 'ts_event'),
        ts_recv: decodeUnixNs(value.ts_recv, 'ts_recv'),
        instrument_id: expectNumber(value.instrument_id, 'instrument_id'),
        price: decodeBigInt(value.price, 'price'),
        size: expectNumber(value.size, 'size'),
        aggressor_side: decodeSide(value.aggressor_side, 'aggressor_side'),
      });
    case 'tbbo':
      return Object.freeze<DbnTbboRecord>({
        schema,
        ts_event: decodeUnixNs(value.ts_event, 'ts_event'),
        ts_recv: decodeUnixNs(value.ts_recv, 'ts_recv'),
        instrument_id: expectNumber(value.instrument_id, 'instrument_id'),
        price: decodeBigInt(value.price, 'price'),
        size: expectNumber(value.size, 'size'),
        aggressor_side: decodeSide(value.aggressor_side, 'aggressor_side'),
        bid_px: decodeBigInt(value.bid_px, 'bid_px'),
        bid_sz: expectNumber(value.bid_sz, 'bid_sz'),
        ask_px: decodeBigInt(value.ask_px, 'ask_px'),
        ask_sz: expectNumber(value.ask_sz, 'ask_sz'),
      });
    case 'bbo':
      return Object.freeze<DbnBboRecord>({
        schema,
        bbo_interval: decodeBboInterval(value.bbo_interval, 'bbo_interval'),
        ts_event: decodeUnixNs(value.ts_event, 'ts_event'),
        ts_recv: decodeUnixNs(value.ts_recv, 'ts_recv'),
        instrument_id: expectNumber(value.instrument_id, 'instrument_id'),
        bid_px: decodeBigInt(value.bid_px, 'bid_px'),
        bid_sz: expectNumber(value.bid_sz, 'bid_sz'),
        ask_px: decodeBigInt(value.ask_px, 'ask_px'),
        ask_sz: expectNumber(value.ask_sz, 'ask_sz'),
      });
    case 'ohlcv-1m':
      return Object.freeze<DbnOhlcv1mRecord>({
        schema,
        ts_event: decodeUnixNs(value.ts_event, 'ts_event'),
        instrument_id: expectNumber(value.instrument_id, 'instrument_id'),
        open: decodeBigInt(value.open, 'open'),
        high: decodeBigInt(value.high, 'high'),
        low: decodeBigInt(value.low, 'low'),
        close: decodeBigInt(value.close, 'close'),
        volume: decodeBigInt(value.volume, 'volume'),
      });
    case 'definition':
      return Object.freeze<DbnDefinitionRecord>({
        schema,
        ts_event: decodeUnixNs(value.ts_event, 'ts_event'),
        ts_recv: decodeUnixNs(value.ts_recv, 'ts_recv'),
        instrument_id: expectNumber(value.instrument_id, 'instrument_id'),
        raw_symbol: expectString(value.raw_symbol, 'raw_symbol'),
        expiration: decodeUnixNs(value.expiration, 'expiration'),
        tick_size: decodeBigInt(value.tick_size, 'tick_size'),
        multiplier: expectNumber(value.multiplier, 'multiplier'),
      });
    case 'statistics':
      return Object.freeze<DbnStatisticsRecord>({
        schema,
        ts_event: decodeUnixNs(value.ts_event, 'ts_event'),
        ts_recv: decodeUnixNs(value.ts_recv, 'ts_recv'),
        ts_ref: decodeUnixNs(value.ts_ref, 'ts_ref'),
        instrument_id: expectNumber(value.instrument_id, 'instrument_id'),
        stat_type: expectNumber(value.stat_type, 'stat_type'),
        price: decodeBigInt(value.price, 'price'),
        quantity: decodeBigInt(value.quantity, 'quantity'),
        update_action: expectNumber(value.update_action, 'update_action'),
        stat_flags: expectNumber(value.stat_flags, 'stat_flags'),
        channel_id: expectNumber(value.channel_id, 'channel_id'),
      });
    case 'status':
      return Object.freeze<DbnStatusRecord>({
        schema,
        ts_event: decodeUnixNs(value.ts_event, 'ts_event'),
        ts_recv: decodeUnixNs(value.ts_recv, 'ts_recv'),
        instrument_id: expectNumber(value.instrument_id, 'instrument_id'),
        status_code: expectNumber(value.status_code, 'status_code'),
        reason_code: expectNumber(value.reason_code, 'reason_code'),
        trading_event_code: expectNumber(value.trading_event_code, 'trading_event_code'),
        is_trading: decodeStatusFlag(value.is_trading, 'is_trading'),
        is_quoting: decodeStatusFlag(value.is_quoting, 'is_quoting'),
        is_short_sell_restricted: decodeStatusFlag(value.is_short_sell_restricted, 'is_short_sell_restricted'),
      });
  }
}
