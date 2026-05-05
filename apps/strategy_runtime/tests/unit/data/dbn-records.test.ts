// Module under test: data/dbn-records; ticket QFA-102.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDbnHeader } from '../../../src/data/dbn-header.js';
import { parseDbnRecord } from '../../../src/data/dbn-records.js';

const FIXTURE_DIR = resolve('apps/strategy_runtime/tests/fixtures/dbn');

function readFirstRecord(fixtureName: string) {
  const buffer = readFileSync(resolve(FIXTURE_DIR, fixtureName));
  const { header, recordsOffset } = parseDbnHeader(buffer);
  return parseDbnRecord(buffer, recordsOffset, header.wire_schema).record;
}

describe('QFA-102 DBN record parsing', () => {
  it('parses MBO records', () => {
    const record = readFirstRecord('mbo-minimal.dbn');
    if (record.schema !== 'mbo') {
      throw new Error(`Expected mbo, received ${record.schema}`);
    }
    expect(record.instrument_id).toBe(42004946);
    expect(record.order_id).toBe(1001n);
  });

  it('parses MBP-1 records with one level', () => {
    const record = readFirstRecord('mbp-1-minimal.dbn');
    if (record.schema !== 'mbp-1') {
      throw new Error(`Expected mbp-1, received ${record.schema}`);
    }
    expect(record.levels).toHaveLength(1);
    expect(record.levels[0].bid_sz).toBe(12);
  });

  it('parses MBP-10 records with ten levels', () => {
    const record = readFirstRecord('mbp-10-minimal.dbn');
    if (record.schema !== 'mbp-10') {
      throw new Error(`Expected mbp-10, received ${record.schema}`);
    }
    expect(record.levels).toHaveLength(10);
    expect(record.levels[9].ask_sz).toBe(39);
  });

  it('parses trades records with aggressor side', () => {
    const record = readFirstRecord('trades-minimal.dbn');
    if (record.schema !== 'trades') {
      throw new Error(`Expected trades, received ${record.schema}`);
    }
    expect(record.aggressor_side).toBe('B');
  });

  it('parses TBBO records with top-of-book fields', () => {
    const record = readFirstRecord('tbbo-minimal.dbn');
    if (record.schema !== 'tbbo') {
      throw new Error(`Expected tbbo, received ${record.schema}`);
    }
    expect(record.bid_sz).toBe(22);
    expect(record.ask_sz).toBe(23);
  });

  it('parses OHLCV bars', () => {
    const record = readFirstRecord('ohlcv-1m-minimal.dbn');
    if (record.schema !== 'ohlcv-1m') {
      throw new Error(`Expected ohlcv-1m, received ${record.schema}`);
    }
    expect(record.open).toBe(10000000000n);
    expect(record.volume).toBe(345n);
  });

  it('maps status wire fields to status_code/reason_code/trading_event_code', () => {
    const record = readFirstRecord('status-minimal.dbn');
    if (record.schema !== 'status') {
      throw new Error(`Expected status, received ${record.schema}`);
    }
    expect(record.status_code).toBe(2);
    expect(record.reason_code).toBe(8);
    expect(record.trading_event_code).toBe(13);
    expect('reason' in record).toBe(false);
  });

  it('preserves statistics price and quantity independently', () => {
    const record = readFirstRecord('statistics-minimal.dbn');
    if (record.schema !== 'statistics') {
      throw new Error(`Expected statistics, received ${record.schema}`);
    }
    expect(record.stat_type).toBe(7);
    expect(record.price).toBe(19500500000000n);
    expect(record.quantity).toBe(123456n);
    expect('value' in record).toBe(false);
  });

  it('parses definition records with raw symbol, expiration, tick size, and multiplier', () => {
    const record = readFirstRecord('definition-minimal.dbn');
    if (record.schema !== 'definition') {
      throw new Error(`Expected definition, received ${record.schema}`);
    }
    expect(record.raw_symbol).toBe('MNQH6');
    expect(record.multiplier).toBe(2);
    expect(record.tick_size).toBe(250000000n);
  });

  it('normalizes bbo fixtures while preserving interval', () => {
    const bbo1s = readFirstRecord('bbo-1s-minimal.dbn');
    const bbo1m = readFirstRecord('bbo-1m-minimal.dbn');
    if (bbo1s.schema !== 'bbo') {
      throw new Error(`Expected bbo, received ${bbo1s.schema}`);
    }
    expect(bbo1s.bbo_interval).toBe('1s');
    if (bbo1m.schema !== 'bbo') {
      throw new Error(`Expected bbo, received ${bbo1m.schema}`);
    }
    expect(bbo1m.bbo_interval).toBe('1m');
  });
});
