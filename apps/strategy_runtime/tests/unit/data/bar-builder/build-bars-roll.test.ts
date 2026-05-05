import { describe, expect, it } from 'vitest';
import { ns } from '../../../../src/contracts/time.js';
import { buildBars, type BuildBarsOptions } from '../../../../src/data/bar-builder/bar-builder.js';
import { BarBuilderInputError } from '../../../../src/data/bar-builder/bar-builder-input-error.js';
import { DEFAULT_MNQ_ROLL_POLICY } from '../../../../src/data/bar-builder/roll-policy.js';
import type { DbnDefinitionRecord, DbnOhlcv1mRecord, DbnRecord, DbnTradesRecord } from '../../../../src/data/dbn-types.js';

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

function definition(instrumentId: number, rawSymbol: string, expiration: string | bigint): DbnDefinitionRecord {
  return {
    schema: 'definition',
    ts_event: ns('1767365600000000000'),
    ts_recv: ns('1767365600000000000'),
    instrument_id: instrumentId,
    raw_symbol: rawSymbol,
    expiration: ns(expiration),
    tick_size: 1n,
    multiplier: 2,
  };
}

function trade(ts: string | bigint, instrumentId: number, price = 100n, size = 1): DbnTradesRecord {
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

function ohlcv(ts: string | bigint, instrumentId: number, close: bigint): DbnOhlcv1mRecord {
  return {
    schema: 'ohlcv-1m',
    ts_event: ns(ts),
    instrument_id: instrumentId,
    open: close,
    high: close,
    low: close,
    close,
    volume: 10n,
  };
}

describe('QFA-104 Session 2b roll handling', () => {
  it('splits a time bucket at roll and emits old bar, boundary, and new bar in order', async () => {
    const outputs = await collect(
      [
        definition(101, 'MNQH6', '1772928000000000000'),
        trade('1767365705000000000', 101, 100n, 2),
        trade('1767365720000000000', 101, 105n, 1),
        definition(202, 'MNQM6', '1780704000000000000'),
        trade('1767365723000000000', 202, 110n, 3),
      ],
      {
        bar_spec: '1m',
        manifest_symbol: 'MNQ',
        roll_policy: DEFAULT_MNQ_ROLL_POLICY,
        input_schemas: ['definition', 'trades'],
        corpus_tier: 'B',
      },
    );

    expect(outputs).toHaveLength(3);
    expect(outputs[0]).toMatchObject({
      type: 'bar',
      raw_symbol: 'MNQH6',
      close_reason: 'contract_roll',
      is_complete: false,
    });
    expect(outputs[1]).toMatchObject({
      type: 'contract_roll_boundary',
      previous_contract: { raw_symbol: 'MNQH6' },
      next_contract: { raw_symbol: 'MNQM6' },
      forced_closed_bar_id: (outputs[0] as { type: 'bar'; bar_id: string }).bar_id,
    });
    expect(outputs[2]).toMatchObject({
      type: 'bar',
      raw_symbol: 'MNQM6',
      open_reason: 'contract_roll',
      roll_boundary_id: (outputs[1] as { type: 'contract_roll_boundary'; boundary_id: string }).boundary_id,
    });
    expect((outputs[0] as { type: 'bar'; bar_id: string }).bar_id).not.toBe(
      (outputs[2] as { type: 'bar'; bar_id: string }).bar_id,
    );
  });

  it('resets tick, volume, and dollar accumulators at roll', async () => {
    const tickOutputs = await collect(
      [trade('1767365701000000000', 101, 100n, 2), trade('1767365702000000000', 202, 101n, 3), trade('1767365703000000000', 202, 102n, 4)],
      {
        bar_spec: 'tick:ticks:2',
        manifest_symbol: 'MNQ',
        roll_policy: DEFAULT_MNQ_ROLL_POLICY,
        input_schemas: ['trades'],
        corpus_tier: 'B',
      },
    );
    expect(tickOutputs[0]).toMatchObject({ type: 'bar', volume: 2n, close_reason: 'contract_roll' });
    expect(tickOutputs[2]).toMatchObject({ type: 'bar', volume: 7n, close_reason: 'target_reached' });

    const volumeOutputs = await collect(
      [trade('1767365701000000000', 101, 100n, 2), trade('1767365702000000000', 202, 101n, 3), trade('1767365703000000000', 202, 102n, 2)],
      {
        bar_spec: 'tick:volume:5',
        manifest_symbol: 'MNQ',
        roll_policy: DEFAULT_MNQ_ROLL_POLICY,
        input_schemas: ['trades'],
        corpus_tier: 'B',
      },
    );
    expect(volumeOutputs[0]).toMatchObject({ type: 'bar', volume: 2n, close_reason: 'contract_roll' });
    expect(volumeOutputs[2]).toMatchObject({ type: 'bar', volume: 5n, close_reason: 'target_reached' });

    const dollarOutputs = await collect(
      [trade('1767365701000000000', 101, 100n, 2), trade('1767365702000000000', 202, 101n, 2), trade('1767365703000000000', 202, 102n, 1)],
      {
        bar_spec: 'tick:dollar:304',
        manifest_symbol: 'MNQ',
        roll_policy: DEFAULT_MNQ_ROLL_POLICY,
        input_schemas: ['trades'],
        corpus_tier: 'B',
      },
    );
    expect(dollarOutputs[0]).toMatchObject({ type: 'bar', volume: 2n, close_reason: 'contract_roll' });
    expect(dollarOutputs[2]).toMatchObject({ type: 'bar', volume: 3n, close_reason: 'target_reached' });
  });

  it('throws for resolvable manifest concrete mismatch and root mismatch', async () => {
    const concreteError = await expectInputError(
      [definition(202, 'MNQM6', '1780704000000000000'), trade('1767365701000000000', 202, 101n, 2)],
      {
        bar_spec: '1m',
        manifest_symbol: 'MNQH6',
        roll_policy: DEFAULT_MNQ_ROLL_POLICY,
        input_schemas: ['definition', 'trades'],
        corpus_tier: 'B',
      },
    );
    expect(concreteError.issues[0]?.code).toBe('manifest_concrete_mismatch');

    const rootError = await expectInputError(
      [trade('1767365701000000000', 101, 101n, 2)],
      {
        bar_spec: '1m',
        manifest_symbol: 'ES',
        roll_policy: DEFAULT_MNQ_ROLL_POLICY,
        input_schemas: ['trades'],
        corpus_tier: 'B',
      },
    );
    expect(rootError.issues[0]?.code).toBe('incompatible_root');
  });

  it('fails closed for ohlcv-only mid-bucket roll changes', async () => {
    const error = await expectInputError(
      [ohlcv('1767365700000000000', 101, 100n), ohlcv('1767365760000000000', 101, 101n), ohlcv('1767365820000000000', 202, 102n)],
      {
        bar_spec: '5m',
        manifest_symbol: 'MNQ',
        roll_policy: DEFAULT_MNQ_ROLL_POLICY,
        input_schemas: ['ohlcv-1m'],
        corpus_tier: 'C',
      },
    );
    expect(error.issues[0]?.code).toBe('roll_unsplittable_aggregate');
  });
});
