import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ns } from '../../../../../strategy_runtime/src/contracts/time.js';
import type { DbnLevel, DbnMbp10Record, DbnMbp1Record, DbnTradesRecord } from '../../../../../strategy_runtime/src/data/dbn-types.js';
import {
  buildMbp10ReferenceOfiBuckets,
  buildMbp1TradeSynthesizedOfiBuckets,
  DEFAULT_OFI_FIDELITY_POLICY_V1,
} from '../../../../src/fidelity/ofi/index.js';

const BASE_TS = 1_770_000_000_000_000_000n;

function level(input: Partial<DbnLevel> = {}): DbnLevel {
  return {
    bid_px: input.bid_px ?? 100n,
    bid_sz: input.bid_sz ?? 10,
    bid_ct: input.bid_ct ?? 1,
    ask_px: input.ask_px ?? 105n,
    ask_sz: input.ask_sz ?? 10,
    ask_ct: input.ask_ct ?? 1,
  };
}

function mbp1(offsetNs: bigint, top: DbnLevel): DbnMbp1Record {
  return {
    schema: 'mbp-1',
    ts_event: ns(BASE_TS + offsetNs),
    ts_recv: ns(BASE_TS + offsetNs),
    instrument_id: 1,
    action: 'M',
    side: 'N',
    price: 0n,
    size: 0,
    levels: [top],
  };
}

function mbp10(offsetNs: bigint, levels: readonly DbnLevel[]): DbnMbp10Record {
  return {
    schema: 'mbp-10',
    ts_event: ns(BASE_TS + offsetNs),
    ts_recv: ns(BASE_TS + offsetNs),
    instrument_id: 1,
    action: 'M',
    side: 'N',
    price: 0n,
    size: 0,
    levels,
  };
}

function trade(offsetNs: bigint, aggressorSide: DbnTradesRecord['aggressor_side'], size = 5): DbnTradesRecord {
  return {
    schema: 'trades',
    ts_event: ns(BASE_TS + offsetNs),
    ts_recv: ns(BASE_TS + offsetNs),
    instrument_id: 1,
    price: 101n,
    size,
    aggressor_side: aggressorSide,
  };
}

async function singleMbp1Contribution(current: DbnLevel): Promise<bigint> {
  const buckets = await buildMbp1TradeSynthesizedOfiBuckets([
    mbp1(0n, level()),
    mbp1(1n, current),
  ]);
  return buckets[0]!.ofi;
}

describe('QFA-401 OFI series', () => {
  it('MBP-1 synthesized quote OFI handles bid price up', async () => {
    await expect(singleMbp1Contribution(level({ bid_px: 101n, bid_sz: 7 }))).resolves.toBe(7n);
  });

  it('MBP-1 synthesized quote OFI handles bid price unchanged size delta', async () => {
    await expect(singleMbp1Contribution(level({ bid_sz: 15 }))).resolves.toBe(5n);
  });

  it('MBP-1 synthesized quote OFI handles bid price down', async () => {
    await expect(singleMbp1Contribution(level({ bid_px: 99n, bid_sz: 8 }))).resolves.toBe(-10n);
  });

  it('MBP-1 synthesized quote OFI handles ask price down', async () => {
    await expect(singleMbp1Contribution(level({ ask_px: 104n, ask_sz: 6 }))).resolves.toBe(-6n);
  });

  it('MBP-1 synthesized quote OFI handles ask price unchanged size delta', async () => {
    await expect(singleMbp1Contribution(level({ ask_sz: 14 }))).resolves.toBe(-4n);
  });

  it('MBP-1 synthesized quote OFI handles ask price up', async () => {
    await expect(singleMbp1Contribution(level({ ask_px: 106n, ask_sz: 8 }))).resolves.toBe(10n);
  });

  it('MBP-10 depth-aware reference sums multiple levels deterministically', async () => {
    const buckets = await buildMbp10ReferenceOfiBuckets([
      mbp10(0n, [level(), level({ bid_px: 90n, ask_px: 110n })]),
      mbp10(1n, [level({ bid_px: 101n, bid_sz: 7 }), level({ bid_px: 90n, ask_px: 109n, ask_sz: 3 })]),
    ], { ...DEFAULT_OFI_FIDELITY_POLICY_V1, reference_depth_levels: 2 });

    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.ofi).toBe(4n);
  });

  it('MBP-10 missing levels contribute zero and are counted', async () => {
    const buckets = await buildMbp10ReferenceOfiBuckets([
      mbp10(0n, [level()]),
      mbp10(1n, [level({ bid_sz: 15 })]),
    ], { ...DEFAULT_OFI_FIDELITY_POLICY_V1, reference_depth_levels: 3 });

    expect(buckets[0]?.ofi).toBe(5n);
    expect(buckets[0]?.missing_depth_level_count).toBe(2);
  });

  it('trades buy-aggressor contributes positive size', async () => {
    const buckets = await buildMbp1TradeSynthesizedOfiBuckets([trade(0n, 'B', 12)]);
    expect(buckets[0]?.ofi).toBe(12n);
  });

  it('trades sell-aggressor contributes negative size', async () => {
    const buckets = await buildMbp1TradeSynthesizedOfiBuckets([trade(0n, 'A', 12)]);
    expect(buckets[0]?.ofi).toBe(-12n);
  });

  it('unknown aggressor side contributes zero and increments unknown-side count', async () => {
    const buckets = await buildMbp1TradeSynthesizedOfiBuckets([trade(0n, 'N', 12)]);
    expect(buckets[0]?.ofi).toBe(0n);
    expect(buckets[0]?.unknown_trade_side_count).toBe(1);
  });

  it('bucketing is deterministic for unsorted input timestamps', async () => {
    const sorted = await buildMbp1TradeSynthesizedOfiBuckets([
      mbp1(0n, level()),
      mbp1(1_000_000_000n, level({ bid_sz: 15 })),
    ]);
    const unsorted = await buildMbp1TradeSynthesizedOfiBuckets([
      mbp1(1_000_000_000n, level({ bid_sz: 15 })),
      mbp1(0n, level()),
    ]);

    expect(unsorted).toEqual(sorted);
  });

  it('does not require a TBBO fixture for QFA-401 v1', async () => {
    const buckets = await buildMbp1TradeSynthesizedOfiBuckets([mbp1(0n, level()), trade(1n, 'B', 3)]);
    expect(buckets[0]?.ofi).toBe(3n);
  });
});

describe('QFA-401 Tier A archive inventory', () => {
  const archiveRoot = 'D:/qfa-cache/databento/tier-a-feb-mar-2026';
  const archiveIt = existsSync(archiveRoot) ? it : it.skip;

  archiveIt('documents the current Tier A schema inventory: TBBO present, QFA-401 uses MBP-10/MBP-1/trades', () => {
    const expected = new Map([
      ['manifest-feb-2026.json', '05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c'],
      ['manifest-mar-2026.json', 'cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f'],
    ]);

    for (const [manifestName, expectedHash] of expected) {
      const manifestPath = join(archiveRoot, manifestName);
      const content = readFileSync(manifestPath);
      const actualHash = createHash('sha256').update(content).digest('hex');
      const manifest = JSON.parse(content.toString('utf8')) as { readonly event_schemas: readonly string[] };

      expect(actualHash).toBe(expectedHash);
      expect(manifest.event_schemas).toEqual(['mbo', 'mbp-1', 'mbp-10', 'tbbo', 'trades']);
      expect(manifest.event_schemas).toEqual(expect.arrayContaining(['mbp-10', 'mbp-1', 'trades']));
    }
  });
});
