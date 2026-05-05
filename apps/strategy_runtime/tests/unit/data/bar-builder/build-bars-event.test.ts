import { describe, expect, it } from 'vitest';
import { ns } from '../../../../src/contracts/time.js';
import { buildBars, type BuildBarsOptions } from '../../../../src/data/bar-builder/bar-builder.js';
import { BarBuilderInputError } from '../../../../src/data/bar-builder/bar-builder-input-error.js';
import { DEFAULT_MNQ_ROLL_POLICY } from '../../../../src/data/bar-builder/roll-policy.js';
import type { DbnOhlcv1mRecord, DbnRecord, DbnTradesRecord } from '../../../../src/data/dbn-types.js';

async function* toAsync(records: readonly DbnRecord[]) {
  for (const record of records) {
    yield record;
  }
}

async function collect(records: readonly DbnRecord[], options: BuildBarsOptions) {
  const outputs = [];
  for await (const output of buildBars(toAsync(records), options)) {
    outputs.push(output);
  }
  return outputs;
}

async function expectInputError(records: readonly DbnRecord[], options: BuildBarsOptions) {
  try {
    await collect(records, options);
  } catch (error) {
    expect(error).toBeInstanceOf(BarBuilderInputError);
    return error as BarBuilderInputError;
  }
  throw new Error('expected BarBuilderInputError');
}

function trade(ts: string | bigint, instrumentId = 101, price = 100n, size = 1): DbnTradesRecord {
  return {
    schema: 'trades',
    ts_event: ns(ts),
    ts_recv: ns(ts),
    instrument_id: instrumentId,
    price,
    size,
    aggressor_side: 'B',
  };
}

function ohlcv(ts: string | bigint): DbnOhlcv1mRecord {
  return {
    schema: 'ohlcv-1m',
    ts_event: ns(ts),
    instrument_id: 101,
    open: 100n,
    high: 110n,
    low: 95n,
    close: 105n,
    volume: 10n,
  };
}

describe('QFA-104 Session 2b buildBars event bars', () => {
  it('emits tick bars from individual trades', async () => {
    const outputs = await collect(
      [trade('1767365701000000000', 101, 100n, 2), trade('1767365702000000000', 101, 110n, 3)],
      {
        bar_spec: 'tick:ticks:2',
        manifest_symbol: 'MNQ',
        roll_policy: DEFAULT_MNQ_ROLL_POLICY,
        input_schemas: ['trades'],
        corpus_tier: 'B',
      },
    );
    expect(outputs[0]).toMatchObject({
      type: 'bar',
      open: 100n,
      high: 110n,
      low: 100n,
      close: 110n,
      volume: 5n,
      close_reason: 'target_reached',
    });
  });

  it('emits volume bars using bigint accumulation', async () => {
    const outputs = await collect(
      [trade('1767365701000000000', 101, 100n, 2), trade('1767365702000000000', 101, 101n, 3)],
      {
        bar_spec: 'tick:volume:5',
        manifest_symbol: 'MNQ',
        roll_policy: DEFAULT_MNQ_ROLL_POLICY,
        input_schemas: ['trades'],
        corpus_tier: 'B',
      },
    );
    expect(outputs[0]).toMatchObject({ type: 'bar', volume: 5n, close_reason: 'target_reached' });
  });

  it('emits dollar bars using deterministic integer accumulation', async () => {
    const outputs = await collect(
      [trade('1767365701000000000', 101, 100n, 2), trade('1767365702000000000', 101, 101n, 3)],
      {
        bar_spec: 'tick:dollar:503',
        manifest_symbol: 'MNQ',
        roll_policy: DEFAULT_MNQ_ROLL_POLICY,
        input_schemas: ['trades'],
        corpus_tier: 'B',
      },
    );
    expect(outputs[0]).toMatchObject({ type: 'bar', volume: 5n, close_reason: 'target_reached' });
  });

  it('rejects tick, volume, and dollar bars from ohlcv-only inputs', async () => {
    for (const spec of ['tick:ticks:10', 'tick:volume:10', 'tick:dollar:1000']) {
      const error = await expectInputError(
        [ohlcv('1767365700000000000')],
        {
          bar_spec: spec,
          manifest_symbol: 'MNQ',
          roll_policy: DEFAULT_MNQ_ROLL_POLICY,
          input_schemas: ['ohlcv-1m'],
          corpus_tier: 'C',
        },
      );
      expect(error.issues[0]?.code).toBe('incompatible_input_schema');
    }
  });
});
