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

function ohlcv(
  ts: string | bigint,
  instrumentId = 101,
  open = 100n,
  high = 110n,
  low = 95n,
  close = 105n,
  volume = 10n,
): DbnOhlcv1mRecord {
  return {
    schema: 'ohlcv-1m',
    ts_event: ns(ts),
    instrument_id: instrumentId,
    open,
    high,
    low,
    close,
    volume,
  };
}

describe('QFA-104 Session 2b buildBars time bars', () => {
  it('emits 1m trade-aggregated bars', async () => {
    const outputs = await collect(
      [
        trade('1767365705000000000', 101, 100n, 2),
        trade('1767365720000000000', 101, 110n, 1),
        trade('1767365740000000000', 101, 90n, 3),
      ],
      {
        bar_spec: '1m',
        manifest_symbol: 'MNQ',
        roll_policy: DEFAULT_MNQ_ROLL_POLICY,
        input_schemas: ['trades'],
        corpus_tier: 'B',
      },
    );

    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      type: 'bar',
      open: 100n,
      high: 110n,
      low: 90n,
      close: 90n,
      volume: 6n,
      open_reason: 'stream_start',
      close_reason: 'stream_end',
      bucket_start_ts_ns: ns('1767365700000000000'),
      bucket_end_ts_ns: ns('1767365760000000000'),
    });
  });

  it('emits 5m ohlcv-aggregated bars', async () => {
    const outputs = await collect(
      [
        ohlcv('1767365700000000000', 101, 100n, 105n, 99n, 104n, 10n),
        ohlcv('1767365760000000000', 101, 104n, 108n, 103n, 107n, 12n),
        ohlcv('1767365820000000000', 101, 107n, 109n, 102n, 103n, 8n),
        ohlcv('1767365880000000000', 101, 103n, 106n, 100n, 105n, 7n),
        ohlcv('1767365940000000000', 101, 105n, 112n, 104n, 111n, 9n),
      ],
      {
        bar_spec: '5m',
        manifest_symbol: 'MNQ',
        roll_policy: DEFAULT_MNQ_ROLL_POLICY,
        input_schemas: ['ohlcv-1m'],
        corpus_tier: 'C',
      },
    );

    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      type: 'bar',
      open: 100n,
      high: 112n,
      low: 99n,
      close: 111n,
      volume: 46n,
      source_metadata: {
        construction_method: 'ohlcv_aggregation',
        quality_flags: expect.arrayContaining(['ohlcv_source', 'definition_missing', 'manifest_unverified']),
      },
    });
  });

  it('passes through 1m ohlcv bars', async () => {
    const outputs = await collect(
      [ohlcv('1767365700000000000', 101, 100n, 105n, 99n, 104n, 10n)],
      {
        bar_spec: '1m',
        manifest_symbol: 'MNQ',
        roll_policy: DEFAULT_MNQ_ROLL_POLICY,
        input_schemas: ['ohlcv-1m'],
        corpus_tier: 'C',
      },
    );

    expect(outputs[0]).toMatchObject({
      type: 'bar',
      close_reason: 'bar_boundary',
      is_complete: true,
      source_metadata: { construction_method: 'ohlcv_passthrough' },
    });
  });

  it('rejects 30s from ohlcv-only', async () => {
    const error = await expectInputError(
      [ohlcv('1767365700000000000')],
      {
        bar_spec: '30s',
        manifest_symbol: 'MNQ',
        roll_policy: DEFAULT_MNQ_ROLL_POLICY,
        input_schemas: ['ohlcv-1m'],
        corpus_tier: 'C',
      },
    );
    expect(error.issues[0]?.code).toBe('subminute_from_ohlcv');
  });

  it('carries manifest_symbol_check and quality flags on every built bar', async () => {
    const outputs = await collect(
      [trade('1767365705000000000')],
      {
        bar_spec: '1m',
        manifest_symbol: 'MNQH6',
        roll_policy: DEFAULT_MNQ_ROLL_POLICY,
        input_schemas: ['trades'],
        corpus_tier: 'B',
      },
    );
    expect(outputs[0]).toMatchObject({
      type: 'bar',
      manifest_symbol_check: { status: 'unverified' },
      source_metadata: {
        quality_flags: expect.arrayContaining(['definition_missing', 'manifest_unverified']),
      },
    });
  });
});
