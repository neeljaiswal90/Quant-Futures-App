import { describe, expect, it } from 'vitest';
import { ns } from '../../../../strategy_runtime/src/contracts/time.js';
import type { DbnMbp1Record, DbnTradesRecord } from '../../../../strategy_runtime/src/data/dbn-types.js';
import {
  computeAtrSupertrend,
  computeStructuralTrend,
  createSnapshotFeatureState,
  updateOfiZForBar,
  type SnapshotPriceBar,
} from '../../../src/real-archive-execution/snapshot-features.js';

describe('QFA-410c real-archive snapshot features', () => {
  it('emits null OFI z-score during warmup and analytical z-score after the rolling window fills', () => {
    const state = createSnapshotFeatureState();
    const outputs = Array.from({ length: 31 }, (_, index) =>
      updateOfiZForBar(state, [trade(BigInt(index), 'B', index + 1)]));

    expect(outputs.slice(0, 30)).toEqual(Array.from({ length: 30 }, () => null));
    expect(outputs[30]).toBe(round4((31 - average(range(1, 30))) / populationStd(range(1, 30))));
  });

  it('keeps OFI z-score null for zero-variance rolling windows', () => {
    const state = createSnapshotFeatureState();
    const outputs = Array.from({ length: 31 }, (_, index) =>
      updateOfiZForBar(state, [trade(BigInt(index), 'B', 5)]));

    expect(outputs[30]).toBeNull();
  });

  it('uses QFA-401 MBP-1 quote OFI contribution in the rolling bar OFI', () => {
    const state = createSnapshotFeatureState();
    expect(updateOfiZForBar(state, [mbp1(0n, 100, 10, 101, 10)], 1)).toBeNull();
    expect(updateOfiZForBar(state, [mbp1(1n, 100, 15, 101, 10)], 1)).toBeNull();
    expect(state.bar_ofi_values).toEqual([0, 5]);
  });

  it('emits ATR supertrend warmup and deterministic up/down flips', () => {
    const uptrend = Array.from({ length: 16 }, (_, index) => bar(100 + index));
    expect(computeAtrSupertrend(uptrend.slice(0, 13)).direction).toBe('unknown');
    expect(computeAtrSupertrend(uptrend).direction).toBe('up');

    const reversal = [
      ...uptrend,
      bar(70, { high: 72, low: 68 }),
    ];
    expect(computeAtrSupertrend(reversal).direction).toBe('down');
  });

  it('classifies structural trend from a multi-bar regression slope', () => {
    expect(computeStructuralTrend(Array.from({ length: 20 }, (_, index) => bar(100 + index)), 1)).toBe('up');
    expect(computeStructuralTrend(Array.from({ length: 20 }, (_, index) => bar(120 - index)), 1)).toBe('down');
    expect(computeStructuralTrend(Array.from({ length: 20 }, () => bar(100)), 1)).toBe('range');
    expect(computeStructuralTrend(Array.from({ length: 19 }, (_, index) => bar(100 + index)), 1)).toBe('unknown');
  });
});

function trade(offsetNs: bigint, aggressorSide: DbnTradesRecord['aggressor_side'], size: number): DbnTradesRecord {
  return {
    schema: 'trades',
    ts_event: ns(offsetNs),
    ts_recv: ns(offsetNs),
    instrument_id: 1,
    price: 100n,
    size,
    aggressor_side: aggressorSide,
  };
}

function mbp1(offsetNs: bigint, bidPx: number, bidSize: number, askPx: number, askSize: number): DbnMbp1Record {
  return {
    schema: 'mbp-1',
    ts_event: ns(offsetNs),
    ts_recv: ns(offsetNs),
    instrument_id: 1,
    action: 'M',
    side: 'N',
    price: 0n,
    size: 0,
    levels: [{
      bid_px: BigInt(bidPx),
      bid_sz: bidSize,
      bid_ct: 1,
      ask_px: BigInt(askPx),
      ask_sz: askSize,
      ask_ct: 1,
    }],
  };
}

function bar(close: number, overrides: Partial<SnapshotPriceBar> = {}): SnapshotPriceBar {
  return {
    high: overrides.high ?? close + 0.5,
    low: overrides.low ?? close - 0.5,
    close,
  };
}

function range(start: number, end: number): readonly number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function populationStd(values: readonly number[]): number {
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
