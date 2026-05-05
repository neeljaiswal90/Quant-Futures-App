import { ns } from '../contracts/time.js';
import { readAsciiChar, readFixedString, readInt32, readInt64, readUint16, readUint32, readUint64 } from './dbn-binary.js';
import { DbnFormatError } from './dbn-errors.js';
import {
  DBN_RECORD_LENGTHS,
  type DbnAction,
  type DbnBboInterval,
  type DbnBboRecord,
  type DbnDefinitionRecord,
  type DbnLevel,
  type DbnMboRecord,
  type DbnMbp10Record,
  type DbnMbp1Record,
  type DbnOhlcv1mRecord,
  type DbnRecord,
  type DbnSide,
  type DbnStatisticsRecord,
  type DbnStatusFlag,
  type DbnStatusRecord,
  type DbnTbboRecord,
  type DbnTradesRecord,
  type DbnWireSchema,
} from './dbn-types.js';

function freezeRecord<T extends DbnRecord>(record: T): T {
  if ('levels' in record) {
    for (const level of record.levels) {
      Object.freeze(level);
    }
    Object.freeze(record.levels);
  }
  return Object.freeze(record);
}

function expectRecordLength(
  buffer: Buffer,
  offset: number,
  expectedLength: number,
  filePath: string,
): void {
  const actualLengthWords = buffer.readUInt8(offset);
  const actualLengthBytes = actualLengthWords * 4;
  if (actualLengthBytes !== expectedLength) {
    throw new DbnFormatError({
      filePath,
      byteOffset: offset,
      message: 'DBN record length byte does not match schema length',
      expected: String(expectedLength),
      actual: String(actualLengthBytes),
    });
  }
}

function parseAction(value: string, filePath: string, offset: number): DbnAction {
  if (value === 'A' || value === 'M' || value === 'C' || value === 'T' || value === 'F') {
    return value;
  }
  throw new DbnFormatError({
    filePath,
    byteOffset: offset,
    message: 'DBN action code is invalid',
    expected: 'A | M | C | T | F',
    actual: JSON.stringify(value),
  });
}

function parseSide(value: string, filePath: string, offset: number): DbnSide {
  if (value === 'B' || value === 'A' || value === 'N') {
    return value;
  }
  throw new DbnFormatError({
    filePath,
    byteOffset: offset,
    message: 'DBN side code is invalid',
    expected: 'B | A | N',
    actual: JSON.stringify(value),
  });
}

function parseStatusFlag(value: string, filePath: string, offset: number): DbnStatusFlag {
  if (value === 'Y' || value === 'N' || value === '~') {
    return value;
  }
  throw new DbnFormatError({
    filePath,
    byteOffset: offset,
    message: 'DBN status flag is invalid',
    expected: 'Y | N | ~',
    actual: JSON.stringify(value),
  });
}

function parseLevelArray(
  buffer: Buffer,
  offset: number,
  count: number,
  filePath: string,
): readonly DbnLevel[] {
  const levels: DbnLevel[] = [];
  let cursor = offset;
  for (let index = 0; index < count; index += 1) {
    const bidPx = readInt64(buffer, cursor, filePath);
    const askPx = readInt64(buffer, bidPx.nextOffset, filePath);
    const bidSz = readUint32(buffer, askPx.nextOffset, filePath);
    const askSz = readUint32(buffer, bidSz.nextOffset, filePath);
    const bidCt = readUint32(buffer, askSz.nextOffset, filePath);
    const askCt = readUint32(buffer, bidCt.nextOffset, filePath);
    levels.push({
      bid_px: bidPx.value,
      ask_px: askPx.value,
      bid_sz: bidSz.value,
      ask_sz: askSz.value,
      bid_ct: bidCt.value,
      ask_ct: askCt.value,
    });
    cursor = askCt.nextOffset;
  }
  return levels;
}

function parseMboRecord(buffer: Buffer, offset: number, filePath: string): DbnMboRecord {
  expectRecordLength(buffer, offset, DBN_RECORD_LENGTHS.mbo, filePath);
  const instrumentId = readUint32(buffer, offset + 4, filePath);
  const tsEvent = readUint64(buffer, offset + 8, filePath);
  const orderId = readUint64(buffer, offset + 16, filePath);
  const price = readInt64(buffer, offset + 24, filePath);
  const size = readUint32(buffer, offset + 32, filePath);
  const action = readAsciiChar(buffer, offset + 38, filePath);
  const side = readAsciiChar(buffer, offset + 39, filePath);
  const tsRecv = readUint64(buffer, offset + 40, filePath);
  return freezeRecord({
    schema: 'mbo',
    ts_event: ns(tsEvent.value),
    ts_recv: ns(tsRecv.value),
    instrument_id: instrumentId.value,
    action: parseAction(action.value, filePath, offset + 38),
    side: parseSide(side.value, filePath, offset + 39),
    price: price.value,
    size: size.value,
    order_id: orderId.value,
  });
}

function parseMbpRecord(
  buffer: Buffer,
  offset: number,
  filePath: string,
  schema: 'mbp-1' | 'mbp-10',
): DbnMbp1Record | DbnMbp10Record {
  const expectedLength = DBN_RECORD_LENGTHS[schema];
  expectRecordLength(buffer, offset, expectedLength, filePath);
  const instrumentId = readUint32(buffer, offset + 4, filePath);
  const tsEvent = readUint64(buffer, offset + 8, filePath);
  const price = readInt64(buffer, offset + 16, filePath);
  const size = readUint32(buffer, offset + 24, filePath);
  const action = readAsciiChar(buffer, offset + 28, filePath);
  const side = readAsciiChar(buffer, offset + 29, filePath);
  const tsRecv = readUint64(buffer, offset + 32, filePath);
  const levels = parseLevelArray(buffer, offset + 48, schema === 'mbp-1' ? 1 : 10, filePath);
  const record = {
    schema,
    ts_event: ns(tsEvent.value),
    ts_recv: ns(tsRecv.value),
    instrument_id: instrumentId.value,
    action: parseAction(action.value, filePath, offset + 28),
    side: parseSide(side.value, filePath, offset + 29),
    price: price.value,
    size: size.value,
    levels,
  };
  return freezeRecord(record as DbnMbp1Record | DbnMbp10Record);
}

function parseTradesRecord(buffer: Buffer, offset: number, filePath: string): DbnTradesRecord {
  expectRecordLength(buffer, offset, DBN_RECORD_LENGTHS.trades, filePath);
  const instrumentId = readUint32(buffer, offset + 4, filePath);
  const tsEvent = readUint64(buffer, offset + 8, filePath);
  const price = readInt64(buffer, offset + 16, filePath);
  const size = readUint32(buffer, offset + 24, filePath);
  const side = readAsciiChar(buffer, offset + 29, filePath);
  const tsRecv = readUint64(buffer, offset + 32, filePath);
  return freezeRecord({
    schema: 'trades',
    ts_event: ns(tsEvent.value),
    ts_recv: ns(tsRecv.value),
    instrument_id: instrumentId.value,
    price: price.value,
    size: size.value,
    aggressor_side: parseSide(side.value, filePath, offset + 29),
  });
}

function parseTbboRecord(buffer: Buffer, offset: number, filePath: string): DbnTbboRecord {
  expectRecordLength(buffer, offset, DBN_RECORD_LENGTHS.tbbo, filePath);
  const instrumentId = readUint32(buffer, offset + 4, filePath);
  const tsEvent = readUint64(buffer, offset + 8, filePath);
  const price = readInt64(buffer, offset + 16, filePath);
  const size = readUint32(buffer, offset + 24, filePath);
  const side = readAsciiChar(buffer, offset + 29, filePath);
  const tsRecv = readUint64(buffer, offset + 32, filePath);
  const bidPx = readInt64(buffer, offset + 48, filePath);
  const askPx = readInt64(buffer, offset + 56, filePath);
  const bidSz = readUint32(buffer, offset + 64, filePath);
  const askSz = readUint32(buffer, offset + 68, filePath);
  return freezeRecord({
    schema: 'tbbo',
    ts_event: ns(tsEvent.value),
    ts_recv: ns(tsRecv.value),
    instrument_id: instrumentId.value,
    price: price.value,
    size: size.value,
    aggressor_side: parseSide(side.value, filePath, offset + 29),
    bid_px: bidPx.value,
    bid_sz: bidSz.value,
    ask_px: askPx.value,
    ask_sz: askSz.value,
  });
}

function parseBboRecord(
  buffer: Buffer,
  offset: number,
  filePath: string,
  wireSchema: 'bbo-1s' | 'bbo-1m',
): DbnBboRecord {
  expectRecordLength(buffer, offset, DBN_RECORD_LENGTHS[wireSchema], filePath);
  const instrumentId = readUint32(buffer, offset + 4, filePath);
  const tsEvent = readUint64(buffer, offset + 8, filePath);
  const tsRecv = readUint64(buffer, offset + 32, filePath);
  const bidPx = readInt64(buffer, offset + 48, filePath);
  const askPx = readInt64(buffer, offset + 56, filePath);
  const bidSz = readUint32(buffer, offset + 64, filePath);
  const askSz = readUint32(buffer, offset + 68, filePath);
  const interval: DbnBboInterval = wireSchema === 'bbo-1s' ? '1s' : '1m';
  return freezeRecord({
    schema: 'bbo',
    bbo_interval: interval,
    ts_event: ns(tsEvent.value),
    ts_recv: ns(tsRecv.value),
    instrument_id: instrumentId.value,
    bid_px: bidPx.value,
    bid_sz: bidSz.value,
    ask_px: askPx.value,
    ask_sz: askSz.value,
  });
}

function parseOhlcvRecord(buffer: Buffer, offset: number, filePath: string): DbnOhlcv1mRecord {
  expectRecordLength(buffer, offset, DBN_RECORD_LENGTHS['ohlcv-1m'], filePath);
  const instrumentId = readUint32(buffer, offset + 4, filePath);
  const tsEvent = readUint64(buffer, offset + 8, filePath);
  const open = readInt64(buffer, offset + 16, filePath);
  const high = readInt64(buffer, offset + 24, filePath);
  const low = readInt64(buffer, offset + 32, filePath);
  const close = readInt64(buffer, offset + 40, filePath);
  const volume = readUint64(buffer, offset + 48, filePath);
  return freezeRecord({
    schema: 'ohlcv-1m',
    ts_event: ns(tsEvent.value),
    instrument_id: instrumentId.value,
    open: open.value,
    high: high.value,
    low: low.value,
    close: close.value,
    volume: volume.value,
  });
}

function parseDefinitionRecord(buffer: Buffer, offset: number, filePath: string): DbnDefinitionRecord {
  expectRecordLength(buffer, offset, DBN_RECORD_LENGTHS.definition, filePath);
  const instrumentId = readUint32(buffer, offset + 4, filePath);
  const tsEvent = readUint64(buffer, offset + 8, filePath);
  const tsRecv = readUint64(buffer, offset + 16, filePath);
  const tickSize = readInt64(buffer, offset + 24, filePath);
  const expiration = readUint64(buffer, offset + 40, filePath);
  const multiplier = readInt32(buffer, offset + 176, filePath);
  const rawSymbol = readFixedString(buffer, offset + 238, 71, filePath);
  return freezeRecord({
    schema: 'definition',
    ts_event: ns(tsEvent.value),
    ts_recv: ns(tsRecv.value),
    instrument_id: instrumentId.value,
    raw_symbol: rawSymbol.value,
    expiration: ns(expiration.value),
    tick_size: tickSize.value,
    multiplier: multiplier.value,
  });
}

function parseStatisticsRecord(buffer: Buffer, offset: number, filePath: string): DbnStatisticsRecord {
  expectRecordLength(buffer, offset, DBN_RECORD_LENGTHS.statistics, filePath);
  const instrumentId = readUint32(buffer, offset + 4, filePath);
  const tsEvent = readUint64(buffer, offset + 8, filePath);
  const tsRecv = readUint64(buffer, offset + 16, filePath);
  const tsRef = readUint64(buffer, offset + 24, filePath);
  const price = readInt64(buffer, offset + 32, filePath);
  const quantity = readInt64(buffer, offset + 40, filePath);
  const statType = readUint16(buffer, offset + 56, filePath);
  const channelId = readUint16(buffer, offset + 58, filePath);
  const updateAction = buffer.readUInt8(offset + 60);
  const statFlags = buffer.readUInt8(offset + 61);
  return freezeRecord({
    schema: 'statistics',
    ts_event: ns(tsEvent.value),
    ts_recv: ns(tsRecv.value),
    ts_ref: ns(tsRef.value),
    instrument_id: instrumentId.value,
    stat_type: statType.value,
    price: price.value,
    quantity: quantity.value,
    update_action: updateAction,
    stat_flags: statFlags,
    channel_id: channelId.value,
  });
}

function parseStatusRecord(buffer: Buffer, offset: number, filePath: string): DbnStatusRecord {
  expectRecordLength(buffer, offset, DBN_RECORD_LENGTHS.status, filePath);
  const instrumentId = readUint32(buffer, offset + 4, filePath);
  const tsEvent = readUint64(buffer, offset + 8, filePath);
  const tsRecv = readUint64(buffer, offset + 16, filePath);
  const action = readUint16(buffer, offset + 24, filePath);
  const reason = readUint16(buffer, offset + 26, filePath);
  const tradingEvent = readUint16(buffer, offset + 28, filePath);
  const isTrading = readAsciiChar(buffer, offset + 30, filePath);
  const isQuoting = readAsciiChar(buffer, offset + 31, filePath);
  const isSsr = readAsciiChar(buffer, offset + 32, filePath);
  return freezeRecord({
    schema: 'status',
    ts_event: ns(tsEvent.value),
    ts_recv: ns(tsRecv.value),
    instrument_id: instrumentId.value,
    status_code: action.value,
    reason_code: reason.value,
    trading_event_code: tradingEvent.value,
    is_trading: parseStatusFlag(isTrading.value, filePath, offset + 30),
    is_quoting: parseStatusFlag(isQuoting.value, filePath, offset + 31),
    is_short_sell_restricted: parseStatusFlag(isSsr.value, filePath, offset + 32),
  });
}

export function parseDbnRecord(
  buffer: Buffer,
  offset: number,
  schema: DbnWireSchema,
  filePath = '<buffer>',
): { record: DbnRecord; nextOffset: number } {
  const recordLength = DBN_RECORD_LENGTHS[schema];
  if (offset + recordLength > buffer.length) {
    throw new DbnFormatError({
      filePath,
      byteOffset: offset,
      message: 'DBN record is truncated',
      expected: `${recordLength} bytes`,
      actual: `${buffer.length - offset} bytes`,
    });
  }

  let record: DbnRecord;
  switch (schema) {
    case 'mbo':
      record = parseMboRecord(buffer, offset, filePath);
      break;
    case 'mbp-1':
      record = parseMbpRecord(buffer, offset, filePath, 'mbp-1');
      break;
    case 'mbp-10':
      record = parseMbpRecord(buffer, offset, filePath, 'mbp-10');
      break;
    case 'trades':
      record = parseTradesRecord(buffer, offset, filePath);
      break;
    case 'tbbo':
      record = parseTbboRecord(buffer, offset, filePath);
      break;
    case 'bbo-1s':
    case 'bbo-1m':
      record = parseBboRecord(buffer, offset, filePath, schema);
      break;
    case 'ohlcv-1m':
      record = parseOhlcvRecord(buffer, offset, filePath);
      break;
    case 'definition':
      record = parseDefinitionRecord(buffer, offset, filePath);
      break;
    case 'statistics':
      record = parseStatisticsRecord(buffer, offset, filePath);
      break;
    case 'status':
      record = parseStatusRecord(buffer, offset, filePath);
      break;
    default: {
      const unhandled: never = schema;
      throw new DbnFormatError({
        filePath,
        byteOffset: offset,
        message: `Unhandled DBN schema ${String(unhandled)}`,
      });
    }
  }

  return { record, nextOffset: offset + recordLength };
}
