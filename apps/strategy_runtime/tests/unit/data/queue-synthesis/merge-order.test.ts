import { describe, expect, it } from 'vitest';
import { ns } from '../../../../src/contracts/time.js';
import type { DbnRecord } from '../../../../src/data/dbn-types.js';
import {
  assertQueueSourceMonotonic,
  compareQueueMergeRecords,
  mergeQueueRecordSources,
  type QueueMergeRecord,
} from '../../../../src/data/queue-synthesis/merge-order.js';

/**
 * Module under test: src/data/queue-synthesis/merge-order.ts
 * Ticket: QFA-105 Session 2a
 */

describe('QFA-105 queue merge ordering', () => {
  it('sorts by ts_event first', () => {
    expect(compareQueueMergeRecords(wrap(record('trades', 1_000n)), wrap(record('trades', 2_000n)))).toBeLessThan(0);
  });

  it('sorts same-timestamp records by schema priority', () => {
    expect(compareQueueMergeRecords(wrap(record('definition', 1_000n)), wrap(record('mbo', 1_000n)))).toBeLessThan(0);
    expect(compareQueueMergeRecords(wrap(record('tbbo', 1_000n)), wrap(record('trades', 1_000n)))).toBeLessThan(0);
  });

  it('sorts same timestamp and schema by source index', () => {
    expect(
      compareQueueMergeRecords(
        wrap(record('trades', 1_000n), { source_index: 0 }),
        wrap(record('trades', 1_000n), { source_index: 1 }),
      ),
    ).toBeLessThan(0);
  });

  it('sorts same timestamp, schema, and source by record index', () => {
    expect(
      compareQueueMergeRecords(
        wrap(record('trades', 1_000n), { record_index: 0 }),
        wrap(record('trades', 1_000n), { record_index: 1 }),
      ),
    ).toBeLessThan(0);
  });

  it('fails closed on non-monotonic source arrays', () => {
    expect(() => assertQueueSourceMonotonic([record('trades', 2_000n), record('trades', 1_000n)])).toThrow(
      /non_monotonic_source/,
    );
  });

  it('merges adversarial same-timestamp sources deterministically across replays', async () => {
    const sources = [
      [record('trades', 1_000n, 1), record('ohlcv-1m', 2_000n, 1)],
      [record('definition', 1_000n, 2), record('mbo', 1_000n, 2)],
      [record('tbbo', 1_000n, 3), record('trades', 1_000n, 3)],
    ];

    const first = await collectMerge(sources);
    const second = await collectMerge(sources);

    expect(second).toEqual(first);
    expect(first.map((item) => `${item.record.schema}:${item.source_index}:${item.record_index}`)).toEqual([
      'definition:1:0',
      'mbo:1:1',
      'tbbo:2:0',
      'trades:0:0',
      'trades:2:1',
      'ohlcv-1m:0:1',
    ]);
  });

  it('fails closed when an async source is non-monotonic', async () => {
    await expect(collectMerge([[record('trades', 2_000n), record('trades', 1_000n)]])).rejects.toThrow(
      /non_monotonic_source/,
    );
  });
});

function wrap(recordValue: DbnRecord, overrides: Partial<QueueMergeRecord> = {}): QueueMergeRecord {
  return {
    record: recordValue,
    source_index: 0,
    record_index: 0,
    ...overrides,
  };
}

async function collectMerge(sources: readonly (readonly DbnRecord[])[]): Promise<QueueMergeRecord[]> {
  const iterables = sources.map((source) => asyncRecords(source));
  const merged: QueueMergeRecord[] = [];
  for await (const item of mergeQueueRecordSources(iterables)) {
    merged.push(item);
  }
  return merged;
}

async function* asyncRecords(records: readonly DbnRecord[]): AsyncIterableIterator<DbnRecord> {
  for (const item of records) {
    yield item;
  }
}

function record(schema: DbnRecord['schema'], ts: bigint, instrumentId = 1): DbnRecord {
  switch (schema) {
    case 'definition':
      return {
        schema,
        ts_event: ns(ts),
        instrument_id: instrumentId,
        ts_recv: ns(ts),
        raw_symbol: `MNQH${instrumentId}`,
        expiration: ns(1_800_000_000_000_000_000n),
        tick_size: 250_000_000n,
        multiplier: 2,
      };
    case 'status':
      return {
        schema,
        ts_event: ns(ts),
        instrument_id: instrumentId,
        ts_recv: ns(ts),
        status_code: 1,
        reason_code: 0,
        trading_event_code: 0,
        is_trading: 'Y',
        is_quoting: 'Y',
        is_short_sell_restricted: '~',
      };
    case 'mbo':
      return {
        schema,
        ts_event: ns(ts),
        instrument_id: instrumentId,
        ts_recv: ns(ts),
        action: 'A',
        side: 'B',
        price: 20_000_000_000n,
        size: 1,
        order_id: BigInt(instrumentId),
      };
    case 'tbbo':
      return {
        schema,
        ts_event: ns(ts),
        instrument_id: instrumentId,
        ts_recv: ns(ts),
        price: 20_000_000_000n,
        size: 1,
        aggressor_side: 'B',
        bid_px: 19_999_999_999n,
        bid_sz: 10,
        ask_px: 20_000_000_001n,
        ask_sz: 12,
      };
    case 'ohlcv-1m':
      return {
        schema,
        ts_event: ns(ts),
        instrument_id: instrumentId,
        open: 20_000_000_000n,
        high: 20_000_000_000n,
        low: 20_000_000_000n,
        close: 20_000_000_000n,
        volume: 1n,
      };
    default:
      return {
        schema: 'trades',
        ts_event: ns(ts),
        instrument_id: instrumentId,
        ts_recv: ns(ts),
        price: 20_000_000_000n,
        size: 1,
        aggressor_side: 'B',
      };
  }
}
