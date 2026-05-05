// Module under test: data/parquet-schemas; ticket QFA-103.
import { describe, expect, it } from 'vitest';
import { ns } from '../../../src/contracts/time.js';
import type { DbnRecord } from '../../../src/data/dbn-types.js';
import {
  PARQUET_BIGINT_ENCODING_KEY,
  PARQUET_BIGINT_ENCODING_VALUE,
  PARQUET_FORMAT_VERSION_KEY,
  PARQUET_SCHEMA_KEY,
  ParquetCacheError,
  dbnToParquetRecord,
  parquetToDbnRecord,
} from '../../../src/data/parquet-schemas.js';

const ADVERSARIAL_VALUES = [
  0n,
  1n,
  -1n,
  (2n ** 63n) - 1n,
  -(2n ** 63n),
  (2n ** 53n) + 1n,
  -((2n ** 53n) + 1n),
  1234567890123456789n,
] as const;

describe('QFA-103 parquet schema conversions', () => {
  it('round-trips adversarial bigint values losslessly through decimal-string encoding', () => {
    for (const value of ADVERSARIAL_VALUES) {
      const record: DbnRecord = {
        schema: 'trades',
        ts_event: ns(value >= 0n ? value : 0n),
        ts_recv: ns(value >= 0n ? value : 0n),
        instrument_id: 1,
        price: value,
        size: 1,
        aggressor_side: 'B',
      };
      const parquetRow = dbnToParquetRecord(record);
      const roundTrip = parquetToDbnRecord(parquetRow, 'trades');
      expect(roundTrip).toEqual(record);
    }
  });

  it('rejects malformed bigint encodings on read', () => {
    expect(() => parquetToDbnRecord({ ts_event: '001', ts_recv: '0', instrument_id: 1, price: '0', size: 1, aggressor_side: 'B' }, 'trades')).toThrow(ParquetCacheError);
    expect(() => parquetToDbnRecord({ ts_event: '+1', ts_recv: '0', instrument_id: 1, price: '0', size: 1, aggressor_side: 'B' }, 'trades')).toThrow(ParquetCacheError);
    expect(() => parquetToDbnRecord({ ts_event: '1e3', ts_recv: '0', instrument_id: 1, price: '0', size: 1, aggressor_side: 'B' }, 'trades')).toThrow(ParquetCacheError);
  });

  it('exports stable metadata keys for bigint encoding and schema versioning', () => {
    expect(PARQUET_BIGINT_ENCODING_KEY).toBe('qfa_bigint_encoding');
    expect(PARQUET_BIGINT_ENCODING_VALUE).toBe('utf8_decimal_v1');
    expect(PARQUET_SCHEMA_KEY).toBe('qfa_schema');
    expect(PARQUET_FORMAT_VERSION_KEY).toBe('qfa_parquet_format_version');
  });
});
