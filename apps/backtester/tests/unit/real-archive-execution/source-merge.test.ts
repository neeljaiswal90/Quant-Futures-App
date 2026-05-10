import { describe, expect, it } from 'vitest';
import { mergeMonotonicSources } from '../../../src/real-archive-execution/index.js';

interface TestRecord {
  readonly source: string;
  readonly ts_event: bigint;
  readonly sequence: number;
}

describe('mergeMonotonicSources', () => {
  it('merges interleaved source streams monotonically by ts_event', async () => {
    const output = await collect(mergeMonotonicSources<TestRecord>([
      source('mbp-1', 0, [1n, 3n, 5n]),
      source('trades', 1, [2n, 4n, 6n]),
    ]));

    expect(output.map((record) => record.ts_event)).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);
    expect(isMonotonic(output)).toBe(true);
  });

  it('uses deterministic tie-breaking by rank and then source order', async () => {
    const output = await collect(mergeMonotonicSources<TestRecord>([
      source('trades', 1, [10n, 10n]),
      source('mbp-1', 0, [10n, 10n]),
    ]));

    expect(output.map((record) => `${record.source}:${record.sequence}`)).toEqual([
      'mbp-1:0',
      'mbp-1:1',
      'trades:0',
      'trades:1',
    ]);
  });

  it('handles empty and single-record sources', async () => {
    const output = await collect(mergeMonotonicSources<TestRecord>([
      source('empty', 0, []),
      source('single', 1, [2n]),
      source('many', 2, [1n, 3n]),
    ]));

    expect(output.map((record) => `${record.source}:${record.ts_event}`)).toEqual([
      'many:1',
      'single:2',
      'many:3',
    ]);
  });

  it('preserves monotonic output for deterministic random k-way fixtures', async () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      const sources = Array.from({ length: 5 }, (_unused, index) =>
        source(`s${index}`, index, sortedRandomTimestamps(seed + index * 17, 40)),
      );

      const output = await collect(mergeMonotonicSources<TestRecord>(sources));

      expect(output).toHaveLength(200);
      expect(isMonotonic(output)).toBe(true);
    }
  });
});

function source(
  name: string,
  tieBreakRank: number,
  timestamps: readonly bigint[],
) {
  return {
    name,
    tieBreakRank,
    tsExtractor: (record: TestRecord) => record.ts_event,
    records: toAsync(timestamps.map((ts_event, sequence) => ({ source: name, ts_event, sequence }))),
  };
}

async function* toAsync<T>(values: readonly T[]): AsyncIterable<T> {
  for (const value of values) {
    yield value;
  }
}

async function collect<T>(records: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];
  for await (const record of records) {
    output.push(record);
  }
  return output;
}

function isMonotonic(records: readonly TestRecord[]): boolean {
  for (let index = 1; index < records.length; index += 1) {
    if (records[index]!.ts_event < records[index - 1]!.ts_event) {
      return false;
    }
  }
  return true;
}

function sortedRandomTimestamps(seed: number, count: number): readonly bigint[] {
  let state = BigInt(seed);
  const values: bigint[] = [];
  for (let index = 0; index < count; index += 1) {
    state = (state * 1103515245n + 12345n) % 2147483648n;
    values.push(state % 10_000n);
  }
  return values.sort((left, right) => Number(left - right));
}
