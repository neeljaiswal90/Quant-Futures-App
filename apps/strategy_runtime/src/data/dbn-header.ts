import { ns } from '../contracts/time.js';
import { readFixedString, readUint8, readUint32, readUint64 } from './dbn-binary.js';
import { DbnFormatError } from './dbn-errors.js';
import {
  DBN_DATASET_LENGTH,
  DBN_DATASET_OFFSET,
  DBN_END_TS_NS_OFFSET,
  DBN_HEADER_LENGTH_PREFIX_BYTES,
  DBN_MAGIC,
  DBN_SCHEMA_CODE_OFFSET,
  DBN_START_TS_NS_OFFSET,
  DBN_STYPE_IN_CODE_OFFSET,
  DBN_VERSION,
  DBN_WIRE_SCHEMA_CODE_MAP,
  normalizeWireSchema,
  type DbnHeader,
} from './dbn-types.js';

export function parseDbnHeader(buffer: Buffer): { header: DbnHeader; recordsOffset: number } {
  const filePath = '<buffer>';
  if (buffer.length < DBN_HEADER_LENGTH_PREFIX_BYTES) {
    throw new DbnFormatError({
      filePath,
      byteOffset: 0,
      message: 'DBN header is truncated',
      expected: `${DBN_HEADER_LENGTH_PREFIX_BYTES} bytes`,
      actual: `${buffer.length} bytes`,
    });
  }

  const magic = buffer.subarray(0, DBN_MAGIC.length);
  if (!magic.equals(DBN_MAGIC)) {
    throw new DbnFormatError({
      filePath,
      byteOffset: 0,
      message: 'DBN magic bytes are invalid',
      expected: DBN_MAGIC.toString('hex'),
      actual: magic.toString('hex'),
    });
  }

  const { value: metadataLength } = readUint32(buffer, 4, filePath);
  const recordsOffset = DBN_HEADER_LENGTH_PREFIX_BYTES + metadataLength;
  if (buffer.length < recordsOffset) {
    throw new DbnFormatError({
      filePath,
      byteOffset: 4,
      message: 'DBN metadata block is truncated',
      expected: `${recordsOffset} bytes`,
      actual: `${buffer.length} bytes`,
    });
  }

  const { value: dataset } = readFixedString(
    buffer,
    DBN_DATASET_OFFSET,
    DBN_DATASET_LENGTH,
    filePath,
  );
  const { value: schemaCode } = readUint8(buffer, DBN_SCHEMA_CODE_OFFSET, filePath);
  const wireSchema = DBN_WIRE_SCHEMA_CODE_MAP[schemaCode];
  if (wireSchema === undefined) {
    throw new DbnFormatError({
      filePath,
      byteOffset: DBN_SCHEMA_CODE_OFFSET,
      message: 'DBN schema code is not recognized',
      expected: Object.keys(DBN_WIRE_SCHEMA_CODE_MAP).join(', '),
      actual: String(schemaCode),
    });
  }

  const { value: stypeInCode } = readUint8(buffer, DBN_STYPE_IN_CODE_OFFSET, filePath);
  const { value: startTsNs } = readUint64(buffer, DBN_START_TS_NS_OFFSET, filePath);
  const { value: endTsNs } = readUint64(buffer, DBN_END_TS_NS_OFFSET, filePath);

  const header: DbnHeader = Object.freeze({
    version: DBN_VERSION,
    metadata_length: metadataLength,
    dataset,
    schema: normalizeWireSchema(wireSchema),
    wire_schema: wireSchema,
    stype_in_code: stypeInCode,
    start_ts_ns: ns(startTsNs),
    end_ts_ns: ns(endTsNs),
    records_offset: recordsOffset,
  });
  return { header, recordsOffset };
}
