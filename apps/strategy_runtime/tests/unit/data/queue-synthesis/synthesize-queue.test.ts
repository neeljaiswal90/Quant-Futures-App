import { describe, expect, it } from 'vitest';
import { ns } from '../../../../src/contracts/time.js';
import type {
  DbnMboRecord,
  DbnMbp1Record,
  DbnRecord,
  DbnTbboRecord,
  DbnTradesRecord,
} from '../../../../src/data/dbn-types.js';
import { synthesizeQueue } from '../../../../src/data/queue-synthesis/queue-synthesizer.js';
import type {
  PassiveFillEstimate,
  PassiveOrderProbe,
  QueueStateSnapshot,
  QueueSynthesisOptions,
  QueueSynthesisOutput,
} from '../../../../src/data/queue-synthesis/types.js';

/**
 * Module under test: src/data/queue-synthesis/queue-synthesizer.ts
 * Ticket: QFA-105 Session 2b
 */

describe('QFA-105 synthesizeQueue market snapshots', () => {
  it('emits QueueStateSnapshot output in mbp_proxy mode', async () => {
    const outputs = await collect(
      synthesizeQueue(records([mbp1(1_000n, { bid_sz: 12, ask_sz: 8 })]), makeOptions({
        input_schemas: ['mbp-1'],
        mode: 'mbp_proxy',
      })),
    );

    const snapshots = queueSnapshots(outputs);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      type: 'queue_state_snapshot',
      side: 'bid',
      price: 20_000_000_000n,
      estimated_queue_ahead: 12n,
      estimated_visible_size: 12n,
    });
    expect(snapshots[0]?.source_metadata.quality_flags).toEqual(
      expect.arrayContaining(['visible_size_proxy', 'definition_missing', 'manifest_unverified']),
    );
  });

  it('emits QueueStateSnapshot output in tbbo_trade_proxy mode', async () => {
    const outputs = await collect(
      synthesizeQueue(records([tbbo(1_000n, { aggressor_side: 'N', bid_sz: 10, ask_sz: 11 })]), makeOptions()),
    );

    const snapshots = queueSnapshots(outputs);
    expect(snapshots.some((snapshot) => snapshot.side === 'bid' && snapshot.estimated_visible_size === 10n)).toBe(
      true,
    );
    expect(snapshots[0]?.source_metadata.quality_flags).toEqual(
      expect.arrayContaining(['definition_missing', 'manifest_unverified']),
    );
  });

  it('emits QueueStateSnapshot output in mbo_reconstruction mode', async () => {
    const outputs = await collect(
      synthesizeQueue(records([mbo(1_000n, { action: 'A', side: 'B', size: 7 })]), makeOptions({
        input_schemas: ['mbo'],
        mode: 'mbo_reconstruction',
      })),
    );

    expect(queueSnapshots(outputs)).toEqual([
      expect.objectContaining({
        type: 'queue_state_snapshot',
        side: 'bid',
        price: 20_000_000_000n,
        estimated_queue_ahead: 7n,
        estimated_visible_size: 7n,
      }),
    ]);
  });

  it('updates visible queue state from MBP-1 in mbp_trades_proxy mode', async () => {
    const outputs = await collect(
      synthesizeQueue(records([mbp1(1_000n, { bid_sz: 14, ask_sz: 9 })]), makeOptions({
        input_schemas: ['mbp-1', 'trades'],
        mode: 'mbp_trades_proxy',
      })),
    );

    const snapshots = queueSnapshots(outputs);
    expect(snapshots).toEqual([
      expect.objectContaining({
        side: 'bid',
        estimated_queue_ahead: 14n,
        estimated_visible_size: 14n,
        source_metadata: expect.objectContaining({ mode: 'mbp_trades_proxy' }),
      }),
      expect.objectContaining({
        side: 'ask',
        estimated_queue_ahead: 9n,
        estimated_visible_size: 9n,
        source_metadata: expect.objectContaining({ mode: 'mbp_trades_proxy' }),
      }),
    ]);
    expect(snapshots[0]?.source_metadata.quality_flags).toEqual(
      expect.arrayContaining(['visible_size_proxy', 'definition_missing', 'manifest_unverified']),
    );
  });

  it('uses buy-aggressor trades to deplete ask-side queue in mbp_trades_proxy mode', async () => {
    const outputs = await collect(
      synthesizeQueue(records([
        mbp1(1_000n),
        trade(1_010n, { aggressor_side: 'B', price: 20_000_000_001n, size: 4 }),
      ]), makeOptions({
        input_schemas: ['mbp-1', 'trades'],
        mode: 'mbp_trades_proxy',
      })),
    );

    expect(queueSnapshots(outputs)).toContainEqual(
      expect.objectContaining({
        side: 'ask',
        price: 20_000_000_001n,
        estimated_trade_depletion: 4n,
        source_metadata: expect.objectContaining({ mode: 'mbp_trades_proxy' }),
      }),
    );
  });

  it('uses sell-aggressor trades to deplete bid-side queue in mbp_trades_proxy mode', async () => {
    const outputs = await collect(
      synthesizeQueue(records([
        mbp1(1_000n),
        trade(1_010n, { aggressor_side: 'A', price: 20_000_000_000n, size: 3 }),
      ]), makeOptions({
        input_schemas: ['mbp-1', 'trades'],
        mode: 'mbp_trades_proxy',
      })),
    );

    expect(queueSnapshots(outputs)).toContainEqual(
      expect.objectContaining({
        side: 'bid',
        price: 20_000_000_000n,
        estimated_trade_depletion: 3n,
        source_metadata: expect.objectContaining({ mode: 'mbp_trades_proxy' }),
      }),
    );
  });

  it('ignores unknown-aggressor trades in mbp_trades_proxy mode', async () => {
    const outputs = await collect(
      synthesizeQueue(records([
        mbp1(1_000n),
        trade(1_010n, { aggressor_side: 'N', price: 20_000_000_000n, size: 99 }),
      ]), makeOptions({
        input_schemas: ['mbp-1', 'trades'],
        mode: 'mbp_trades_proxy',
      })),
    );

    expect(queueSnapshots(outputs)).toHaveLength(2);
    expect(queueSnapshots(outputs).some((snapshot) => snapshot.estimated_trade_depletion > 0n)).toBe(false);
  });

  it('produces a different estimate than mbp_proxy when trades deplete the probe side', async () => {
    const marketRecords = [
      mbp1(1_000n),
      trade(1_050n, { aggressor_side: 'A', price: 20_000_000_000n, size: 30 }),
    ];
    const passiveProbe = probe(1_100n, { side: 'buy', limit_price: 20_000_000_000n });

    const mbpOnlyOutputs = await collect(
      synthesizeQueue(records(marketRecords), makeOptions({
        input_schemas: ['mbp-1'],
        mode: 'mbp_proxy',
      }), probes([passiveProbe])),
    );
    const mbpTradesOutputs = await collect(
      synthesizeQueue(records(marketRecords), makeOptions({
        input_schemas: ['mbp-1', 'trades'],
        mode: 'mbp_trades_proxy',
      }), probes([passiveProbe])),
    );

    expect(passiveEstimates(mbpOnlyOutputs)[0]?.estimated_fill_probability_ppm).toBe(0);
    expect(passiveEstimates(mbpTradesOutputs)[0]?.estimated_fill_probability_ppm).toBe(1_000_000);
  });

  it('keeps tbbo_trade_proxy trade depletion behavior unchanged', async () => {
    const outputs = await collect(
      synthesizeQueue(records([
        tbbo(1_000n, { aggressor_side: 'N' }),
        trade(1_010n, { aggressor_side: 'B', price: 20_000_000_001n, size: 4 }),
      ]), makeOptions()),
    );

    expect(queueSnapshots(outputs)).toContainEqual(
      expect.objectContaining({
        side: 'ask',
        price: 20_000_000_001n,
        estimated_trade_depletion: 4n,
        source_metadata: expect.objectContaining({ mode: 'tbbo_trade_proxy' }),
      }),
    );
  });

  it('keeps PassiveFillEstimate shape unchanged for mbp_trades_proxy', async () => {
    const outputs = await collect(
      synthesizeQueue(
        records([mbp1(1_000n)]),
        makeOptions({
          input_schemas: ['mbp-1', 'trades'],
          mode: 'mbp_trades_proxy',
        }),
        probes([probe(1_100n)]),
      ),
    );

    expect(Object.keys(passiveEstimates(outputs)[0] ?? {}).sort()).toEqual([
      'effective_ts_ns',
      'estimated_fill_probability_ppm',
      'estimated_fill_quantity',
      'instrument_id',
      'limit_price',
      'order_quantity',
      'raw_symbol',
      'side',
      'source_metadata',
      'ts_ns',
      'type',
    ]);
  });

  it('rejects OHLCV-only input before consuming the record stream', async () => {
    let consumed = false;
    async function* ohlcvSource(): AsyncIterableIterator<DbnRecord> {
      consumed = true;
      yield {
        schema: 'ohlcv-1m',
        ts_event: ns(1_000n),
        instrument_id: 1,
        open: 20_000_000_000n,
        high: 20_000_000_000n,
        low: 20_000_000_000n,
        close: 20_000_000_000n,
        volume: 1n,
      };
    }

    await expect(collect(synthesizeQueue(ohlcvSource(), makeOptions({
      input_schemas: ['ohlcv-1m'],
      mode: 'auto',
    })))).rejects.toThrow(/ohlcv_queue_synthesis_forbidden/);
    expect(consumed).toBe(false);
  });

  it('emits no PassiveFillEstimate when no probes are supplied', async () => {
    const outputs = await collect(
      synthesizeQueue(records([tbbo(1_000n), trade(1_100n, { size: 10 })]), makeOptions()),
    );

    expect(outputs.every((output) => output.type === 'queue_state_snapshot')).toBe(true);
  });

  it('rejects BuiltBar-shaped runtime input rather than treating bars as queue truth', async () => {
    const builtBarLike = {
      type: 'bar',
      schema: 'bar',
      ts_event: ns(1_000n),
      instrument_id: 1,
    } as unknown as DbnRecord;

    await expect(
      collect(synthesizeQueue(records([builtBarLike]), makeOptions({
        input_schemas: ['mbo'],
        mode: 'mbo_reconstruction',
      }))),
    ).rejects.toThrow(/unsupported_input_schema/);
  });
});

export function makeOptions(overrides: Partial<QueueSynthesisOptions> = {}): QueueSynthesisOptions {
  return {
    instrument_root: 'MNQ',
    manifest_symbol: 'MNQH6',
    input_schemas: ['tbbo', 'trades'],
    corpus_tier: 'A',
    mode: 'tbbo_trade_proxy',
    passive_order_quantity: 5n,
    fill_horizon_ns: 100n,
    depletion_lookback_ns: 100n,
    allow_unverified_identity: true,
    ...overrides,
  };
}

export async function collect(iterable: AsyncIterable<QueueSynthesisOutput>): Promise<QueueSynthesisOutput[]> {
  const outputs: QueueSynthesisOutput[] = [];
  for await (const output of iterable) {
    outputs.push(output);
  }
  return outputs;
}

export async function* records(items: readonly DbnRecord[]): AsyncIterableIterator<DbnRecord> {
  for (const item of items) {
    yield item;
  }
}

export function queueSnapshots(outputs: readonly QueueSynthesisOutput[]): QueueStateSnapshot[] {
  return outputs.filter((output): output is QueueStateSnapshot => output.type === 'queue_state_snapshot');
}

function passiveEstimates(outputs: readonly QueueSynthesisOutput[]): PassiveFillEstimate[] {
  return outputs.filter((output): output is PassiveFillEstimate => output.type === 'passive_fill_estimate');
}

async function* probes(items: readonly PassiveOrderProbe[]): AsyncIterableIterator<PassiveOrderProbe> {
  for (const item of items) {
    yield item;
  }
}

function probe(ts: bigint, overrides: Partial<PassiveOrderProbe> = {}): PassiveOrderProbe {
  return {
    ts_ns: ns(ts),
    instrument_id: 1,
    raw_symbol: null,
    side: 'buy',
    limit_price: 20_000_000_000n,
    order_quantity: 5n,
    latency_ns: 0n,
    ...overrides,
  };
}

export function mbp1(ts: bigint, overrides: Partial<DbnMbp1Record['levels'][number]> = {}): DbnMbp1Record {
  return {
    schema: 'mbp-1',
    ts_event: ns(ts),
    instrument_id: 1,
    ts_recv: ns(ts),
    action: 'A',
    side: 'B',
    price: 20_000_000_000n,
    size: 1,
    levels: [
      {
        bid_px: 20_000_000_000n,
        bid_sz: 10,
        bid_ct: 2,
        ask_px: 20_000_000_001n,
        ask_sz: 12,
        ask_ct: 3,
        ...overrides,
      },
    ],
  };
}

export function tbbo(ts: bigint, overrides: Partial<DbnTbboRecord> = {}): DbnTbboRecord {
  return {
    schema: 'tbbo',
    ts_event: ns(ts),
    instrument_id: 1,
    ts_recv: ns(ts),
    price: 20_000_000_000n,
    size: 1,
    aggressor_side: 'A',
    bid_px: 20_000_000_000n,
    bid_sz: 10,
    ask_px: 20_000_000_001n,
    ask_sz: 12,
    ...overrides,
  };
}

export function trade(ts: bigint, overrides: Partial<DbnTradesRecord> = {}): DbnTradesRecord {
  return {
    schema: 'trades',
    ts_event: ns(ts),
    instrument_id: 1,
    ts_recv: ns(ts),
    price: 20_000_000_000n,
    size: 1,
    aggressor_side: 'A',
    ...overrides,
  };
}

export function mbo(ts: bigint, overrides: Partial<DbnMboRecord> = {}): DbnMboRecord {
  return {
    schema: 'mbo',
    ts_event: ns(ts),
    instrument_id: 1,
    ts_recv: ns(ts),
    action: 'A',
    side: 'B',
    price: 20_000_000_000n,
    size: 1,
    order_id: 1n,
    ...overrides,
  };
}
