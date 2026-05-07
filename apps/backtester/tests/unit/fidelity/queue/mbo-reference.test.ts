import { describe, expect, it } from 'vitest';
import { ns } from '../../../../../strategy_runtime/src/contracts/time.js';
import type { DbnMboRecord } from '../../../../../strategy_runtime/src/data/dbn-types.js';
import {
  computeMboReferenceFillFraction,
  type QueueFidelityProbe,
} from '../../../../src/fidelity/queue/index.js';

describe('QFA-402 MBO reference fill fraction', () => {
  it('returns full fill when FIFO queue ahead is depleted before the horizon', () => {
    const result = computeMboReferenceFillFraction(probe({ quantity: 3n }), [
      mbo(500n, { action: 'A', order_id: 1n, size: 2 }),
      mbo(1_100n, { action: 'T', order_id: 1n, size: 2 }),
      mbo(1_200n, { action: 'A', order_id: 2n, size: 3 }),
      mbo(1_300n, { action: 'T', order_id: 2n, size: 3 }),
    ]);

    expect(result.reference_fill_probability_ppm).toBe(1_000_000);
  });

  it('returns no fill when executions do not deplete queue ahead', () => {
    const result = computeMboReferenceFillFraction(probe({ quantity: 1n }), [
      mbo(500n, { action: 'A', order_id: 1n, size: 5 }),
      mbo(1_100n, { action: 'T', order_id: 1n, size: 3 }),
    ]);

    expect(result.reference_fill_probability_ppm).toBe(0);
  });

  it('returns partial fill as proportional ppm', () => {
    const result = computeMboReferenceFillFraction(probe({ quantity: 4n }), [
      mbo(500n, { action: 'A', order_id: 1n, size: 2 }),
      mbo(1_100n, { action: 'T', order_id: 1n, size: 2 }),
      mbo(1_200n, { action: 'A', order_id: 2n, size: 2 }),
      mbo(1_300n, { action: 'T', order_id: 2n, size: 2 }),
    ]);

    expect(result.reference_fill_probability_ppm).toBe(500_000);
  });

  it('respects queue ahead before filling the virtual order', () => {
    const result = computeMboReferenceFillFraction(probe({ quantity: 1n }), [
      mbo(500n, { action: 'A', order_id: 1n, size: 3 }),
      mbo(1_100n, { action: 'T', order_id: 1n, size: 2 }),
      mbo(1_200n, { action: 'A', order_id: 2n, size: 1 }),
      mbo(1_300n, { action: 'T', order_id: 2n, size: 1 }),
    ]);

    expect(result.reference_fill_probability_ppm).toBe(0);
  });

  it('lets cancellations reduce queue ahead without filling the virtual order', () => {
    const result = computeMboReferenceFillFraction(probe({ quantity: 1n }), [
      mbo(500n, { action: 'A', order_id: 1n, size: 5 }),
      mbo(1_100n, { action: 'C', order_id: 1n, size: 5 }),
      mbo(1_200n, { action: 'A', order_id: 2n, size: 1 }),
      mbo(1_300n, { action: 'T', order_id: 2n, size: 1 }),
    ]);

    expect(result.reference_fill_probability_ppm).toBe(1_000_000);
  });

  it('is deterministic for identical FIFO/order_id input', () => {
    const records = [
      mbo(500n, { action: 'A', order_id: 1n, size: 1 }),
      mbo(500n, { action: 'A', order_id: 2n, size: 1 }),
      mbo(1_100n, { action: 'F', order_id: 1n, size: 1 }),
      mbo(1_200n, { action: 'F', order_id: 2n, size: 1 }),
      mbo(1_300n, { action: 'A', order_id: 3n, size: 1 }),
      mbo(1_400n, { action: 'F', order_id: 3n, size: 1 }),
    ];

    expect(computeMboReferenceFillFraction(probe({ quantity: 1n }), records)).toEqual(
      computeMboReferenceFillFraction(probe({ quantity: 1n }), records),
    );
  });
});

function probe(overrides: Partial<QueueFidelityProbe> = {}): QueueFidelityProbe {
  return {
    probe_id: 'probe-1',
    ts_ns: ns(1_000n),
    instrument_id: 1,
    raw_symbol: 'MNQH6',
    side: 'buy',
    limit_price: 100n,
    quantity: 1n,
    fill_horizon_ns: 1_000n,
    depletion_lookback_ns: 30_000n,
    ...overrides,
  };
}

function mbo(ts: bigint, overrides: Partial<DbnMboRecord> = {}): DbnMboRecord {
  return {
    schema: 'mbo',
    ts_event: ns(ts),
    ts_recv: ns(ts),
    instrument_id: 1,
    action: 'A',
    side: 'B',
    price: 100n,
    size: 1,
    order_id: 1n,
    ...overrides,
  };
}
