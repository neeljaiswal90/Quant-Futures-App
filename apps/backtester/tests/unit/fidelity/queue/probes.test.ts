import { describe, expect, it } from 'vitest';
import { ns } from '../../../../../strategy_runtime/src/contracts/time.js';
import type { DbnMbp1Record } from '../../../../../strategy_runtime/src/data/dbn-types.js';
import {
  DEFAULT_QUEUE_FIDELITY_POLICY_V1,
  generateQueueFidelityProbes,
} from '../../../../src/fidelity/queue/index.js';

describe('QFA-402 queue fidelity probe generation', () => {
  it('generates deterministic probes at a 1s cadence', () => {
    const records = [
      mbp1(1_000_000_000n),
      mbp1(2_000_000_000n, { bid_px: 101n, ask_px: 103n }),
    ];

    const first = generateQueueFidelityProbes(records);
    const second = generateQueueFidelityProbes(records);

    expect(first).toEqual(second);
    expect(first).toHaveLength(4);
    expect(first.map((probe) => probe.ts_ns)).toEqual([
      ns(1_000_000_000n),
      ns(1_000_000_000n),
      ns(2_000_000_000n),
      ns(2_000_000_000n),
    ]);
  });

  it('uses the best bid for buy probes', () => {
    const [probe] = generateQueueFidelityProbes([mbp1(1_000_000_000n, { bid_px: 99n })]);

    expect(probe).toMatchObject({
      side: 'buy',
      limit_price: 99n,
      quantity: DEFAULT_QUEUE_FIDELITY_POLICY_V1.order_quantity,
    });
  });

  it('uses the best ask for sell probes', () => {
    const [, probe] = generateQueueFidelityProbes([mbp1(1_000_000_000n, { ask_px: 104n })]);

    expect(probe).toMatchObject({
      side: 'sell',
      limit_price: 104n,
    });
  });

  it('skips probes when top-of-book size is unavailable', () => {
    const probes = generateQueueFidelityProbes([
      mbp1(1_000_000_000n, {
        bid_sz: 0,
        ask_sz: 0,
      }),
    ]);

    expect(probes).toEqual([]);
  });
});

function mbp1(
  ts: bigint,
  overrides: Partial<DbnMbp1Record['levels'][number]> = {},
): DbnMbp1Record {
  return {
    schema: 'mbp-1',
    ts_event: ns(ts),
    ts_recv: ns(ts),
    instrument_id: 1,
    action: 'A',
    side: 'B',
    price: 100n,
    size: 1,
    levels: [
      {
        bid_px: 100n,
        bid_sz: 10,
        bid_ct: 1,
        ask_px: 102n,
        ask_sz: 12,
        ask_ct: 1,
        ...overrides,
      },
    ],
  };
}
