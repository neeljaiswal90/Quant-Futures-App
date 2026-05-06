import { describe, expect, it } from 'vitest';
import { ns } from '../../../../src/contracts/time.js';
import { synthesizeQueue } from '../../../../src/data/queue-synthesis/queue-synthesizer.js';
import type {
  PassiveFillEstimate,
  PassiveOrderProbe,
  QueueSynthesisOutput,
} from '../../../../src/data/queue-synthesis/types.js';
import {
  collect,
  makeOptions,
  records,
  tbbo,
  trade,
} from './synthesize-queue.test.js';

/**
 * Module under test: src/data/queue-synthesis/queue-synthesizer.ts
 * Ticket: QFA-105 Session 2b
 */

describe('QFA-105 synthesizeQueue passive probes', () => {
  it('emits a PassiveFillEstimate for a valid caller-supplied probe', async () => {
    const outputs = await collect(
      synthesizeQueue(
        records([tbbo(1_000n, { aggressor_side: 'N', bid_sz: 10 }), trade(1_050n, { size: 12 })]),
        makeOptions(),
        probes([probe({ ts_ns: ns(1_100n) })]),
      ),
    );

    expect(passiveEstimates(outputs)).toEqual([
      expect.objectContaining({
        type: 'passive_fill_estimate',
        estimated_fill_quantity: 2n,
        estimated_fill_probability_ppm: 800_000,
      }),
    ]);
  });

  it('computes partial, full, and no-fill estimates with bounded ppm probabilities', async () => {
    const partial = passiveEstimates(
      await collect(
        synthesizeQueue(
          records([tbbo(1_000n, { aggressor_side: 'N', bid_sz: 10 }), trade(1_050n, { size: 12 })]),
          makeOptions(),
          probes([probe({ ts_ns: ns(1_100n) })]),
        ),
      ),
    )[0]!;
    const full = passiveEstimates(
      await collect(
        synthesizeQueue(
          records([tbbo(1_000n, { aggressor_side: 'N', bid_sz: 10 }), trade(1_050n, { size: 20 })]),
          makeOptions(),
          probes([probe({ ts_ns: ns(1_100n) })]),
        ),
      ),
    )[0]!;
    const noFill = passiveEstimates(
      await collect(
        synthesizeQueue(
          records([tbbo(1_000n, { aggressor_side: 'N', bid_sz: 10 }), trade(1_050n, { size: 5 })]),
          makeOptions(),
          probes([probe({ ts_ns: ns(1_100n) })]),
        ),
      ),
    )[0]!;

    expect(partial.estimated_fill_quantity).toBe(2n);
    expect(partial.estimated_fill_quantity).toBeLessThan(partial.order_quantity);
    expect(full.estimated_fill_quantity).toBe(full.order_quantity);
    expect(full.estimated_fill_probability_ppm).toBe(1_000_000);
    expect(noFill.estimated_fill_quantity).toBe(0n);
    for (const estimate of [partial, full, noFill]) {
      expect(estimate.estimated_fill_probability_ppm).toBeGreaterThanOrEqual(0);
      expect(estimate.estimated_fill_probability_ppm).toBeLessThanOrEqual(1_000_000);
    }
  });

  it('emits an unverified zero-fill estimate when queue ahead is unknown', async () => {
    const outputs = await collect(
      synthesizeQueue(
        records([trade(1_050n, { size: 20 })]),
        makeOptions(),
        probes([probe({ ts_ns: ns(1_100n) })]),
      ),
    );

    expect(passiveEstimates(outputs)).toEqual([
      expect.objectContaining({
        estimated_fill_probability_ppm: 0,
        estimated_fill_quantity: 0n,
        source_metadata: expect.objectContaining({
          confidence: 'unverified',
          quality_flags: expect.arrayContaining(['queue_ahead_unknown']),
        }),
      }),
    ]);
  });

  it('emits the queue-state-unavailable placeholder for valid probes before evidence', async () => {
    const outputs = await collect(
      synthesizeQueue(
        records([tbbo(1_000n, { aggressor_side: 'N', bid_sz: 10 })]),
        makeOptions(),
        probes([probe({ ts_ns: ns(500n) })]),
      ),
    );

    expect(passiveEstimates(outputs)).toEqual([
      expect.objectContaining({
        estimated_fill_probability_ppm: 0,
        estimated_fill_quantity: 0n,
        source_metadata: expect.objectContaining({
          confidence: 'unverified',
          quality_flags: expect.arrayContaining(['queue_state_unavailable']),
        }),
      }),
    ]);
  });

  it('evaluates same-timestamp probes after all same-timestamp market records', async () => {
    const outputs = await collect(
      synthesizeQueue(
        records([tbbo(1_000n, { aggressor_side: 'N', bid_sz: 10 }), trade(1_000n, { size: 15 })]),
        makeOptions(),
        probes([probe({ ts_ns: ns(1_000n) })]),
      ),
    );

    expect(passiveEstimates(outputs)[0]).toMatchObject({
      estimated_fill_quantity: 5n,
      estimated_fill_probability_ppm: 1_000_000,
    });
  });

  it('does not let future records alter an estimate emitted before them', async () => {
    const baseline = await collect(
      synthesizeQueue(
        records([tbbo(1_000n, { aggressor_side: 'N', bid_sz: 10 }), trade(1_050n, { size: 12 })]),
        makeOptions(),
        probes([probe({ ts_ns: ns(1_100n) })]),
      ),
    );
    const withFuture = await collect(
      synthesizeQueue(
        records([
          tbbo(1_000n, { aggressor_side: 'N', bid_sz: 10 }),
          trade(1_050n, { size: 12 }),
          trade(1_200n, { size: 100 }),
        ]),
        makeOptions(),
        probes([probe({ ts_ns: ns(1_100n) })]),
      ),
    );

    expect(passiveEstimates(withFuture)[0]).toEqual(passiveEstimates(baseline)[0]);
  });

  it('is replay-deterministic for identical records, options, and probes', async () => {
    const run = () =>
      collect(
        synthesizeQueue(
          records([tbbo(1_000n, { aggressor_side: 'N', bid_sz: 10 }), trade(1_050n, { size: 12 })]),
          makeOptions(),
          probes([probe({ ts_ns: ns(1_100n) })]),
        ),
      );

    expect(await run()).toEqual(await run());
  });

  it('fails closed on non-monotonic market records and probe streams', async () => {
    await expect(
      collect(
        synthesizeQueue(
          records([trade(2_000n), trade(1_000n)]),
          makeOptions({ input_schemas: ['trades', 'tbbo'] }),
        ),
      ),
    ).rejects.toThrow(/non_monotonic_source/);

    await expect(
      collect(
        synthesizeQueue(
          records([tbbo(1_000n)]),
          makeOptions(),
          probes([probe({ ts_ns: ns(1_000n) }), probe({ ts_ns: ns(500n) })]),
        ),
      ),
    ).rejects.toThrow(/non_monotonic_source/);
  });
});

function passiveEstimates(outputs: readonly QueueSynthesisOutput[]): PassiveFillEstimate[] {
  return outputs.filter((output): output is PassiveFillEstimate => output.type === 'passive_fill_estimate');
}

function probe(overrides: Partial<PassiveOrderProbe> = {}): PassiveOrderProbe {
  return {
    ts_ns: ns(1_100n),
    instrument_id: 1,
    raw_symbol: null,
    side: 'buy',
    limit_price: 20_000_000_000n,
    order_quantity: 5n,
    latency_ns: 0n,
    ...overrides,
  };
}

async function* probes(items: readonly PassiveOrderProbe[]): AsyncIterableIterator<PassiveOrderProbe> {
  for (const item of items) {
    yield item;
  }
}
