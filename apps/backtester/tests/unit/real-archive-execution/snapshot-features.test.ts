import { describe, expect, it } from 'vitest';
import { ns } from '../../../../strategy_runtime/src/contracts/time.js';
import type { DbnMbp1Record, DbnTradesRecord } from '../../../../strategy_runtime/src/data/dbn-types.js';
import {
  computeAdx14,
  computeAtr14,
  computeAtrSupertrend,
  computeStructuralTrend,
  createSignedShockMeasurement,
  createSnapshotContextState,
  createSnapshotFeatureState,
  updateSnapshotContextForBar,
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

  it('emits ATR14 and ADX14 only after the warmup horizon', () => {
    const uptrend = Array.from({ length: 15 }, (_, index) => bar(100 + index, {
      high: 101 + index,
      low: 99 + index,
    }));

    expect(computeAtr14(uptrend.slice(0, 14))).toBeNull();
    expect(computeAdx14(uptrend.slice(0, 14))).toBeNull();
    expect(computeAtr14(uptrend)).toBeGreaterThan(0);
    expect(computeAdx14(uptrend)).toBeGreaterThan(0);
  });

  it('classifies structural trend from a multi-bar regression slope', () => {
    expect(computeStructuralTrend(Array.from({ length: 20 }, (_, index) => bar(100 + index)), 1)).toBe('up');
    expect(computeStructuralTrend(Array.from({ length: 20 }, (_, index) => bar(120 - index)), 1)).toBe('down');
    expect(computeStructuralTrend(Array.from({ length: 20 }, () => bar(100)), 1)).toBe('range');
    expect(computeStructuralTrend(Array.from({ length: 19 }, (_, index) => bar(100 + index)), 1)).toBe('unknown');
  });

  it('emits seeded context values and ADR-0022 daily VIX freshness semantics', () => {
    const state = createSnapshotContextState({
      prior_day_close: 101,
      prior_day_high: 105,
      prior_day_low: 99,
      vix_value: 18.25,
      vix_fresh: true,
      vix_prior_close_percentile: 0.733333,
      regime_label: 'high',
    });

    const context = updateSnapshotContextForBar(state, {
      bar: contextBar(0n, { open: 100, high: 102, low: 98, close: 101 }),
      rth_start_ts_ns: 0n,
    });

    expect(context).toMatchObject({
      prior_day_close: 101,
      prior_day_high: 105,
      prior_day_low: 99,
      today_open: 100,
      vix_value: 18.25,
      vix_fresh: true,
      vix_prior_close_percentile: 0.733333,
      regime_label: 'high',
      opening_range_high: 102,
      opening_range_low: 98,
      opening_range_minutes_elapsed: 0,
      session_vwap: null,
      session_vwap_band_sigma_pts: null,
      overnight_return_bps: -99.0099,
      signed_shock_vwap: {
        value: null,
        anchor_type: 'vwap',
        anchor_value: null,
        sigma_basis: 'atr_14',
        sigma_basis_value: null,
      },
      signed_shock_prior_close: {
        value: null,
        anchor_type: 'prior_close',
        anchor_value: null,
        sigma_basis: 'atr_14',
        sigma_basis_value: null,
      },
    });
  });

  it('tracks session VWAP and VWAP-band sigma at session scope', () => {
    const state = createSnapshotContextState({ prior_day_close: 100 });
    let context = updateSnapshotContextForBar(state, {
      bar: contextBar(0n, { open: 101, high: 101, low: 101, close: 101, volume: 10 }),
      rth_start_ts_ns: 0n,
    });
    expect(context.session_vwap).toBe(101);
    expect(context.overnight_return_bps).toBe(100);
    expect(context.session_vwap_band_sigma_pts).toBeNull();

    for (let index = 1; index < 30; index += 1) {
      context = updateSnapshotContextForBar(state, {
        bar: contextBar(BigInt(index) * 60_000_000_000n, {
          open: 100 + index,
          high: 101 + index,
          low: 99 + index,
          close: 100 + index,
          volume: 10,
        }),
        rth_start_ts_ns: 0n,
      });
    }

    expect(context.session_vwap).toBe(114.5333);
    expect(context.session_vwap_band_sigma_pts).toBeGreaterThan(0);
  });

  it('enforces ADR-0023 SignedShockMeasurement invariants', () => {
    expect(createSignedShockMeasurement({
      price: 104,
      anchor_type: 'vwap',
      anchor_value: 100,
      sigma_basis: 'atr_14',
      sigma_basis_value: 2,
    })).toEqual({
      value: 2,
      anchor_type: 'vwap',
      anchor_value: 100,
      sigma_basis: 'atr_14',
      sigma_basis_value: 2,
    });
    expect(createSignedShockMeasurement({
      price: 104,
      anchor_type: 'prior_close',
      anchor_value: null,
      sigma_basis: 'atr_14',
      sigma_basis_value: 2,
    })).toEqual({
      value: null,
      anchor_type: 'prior_close',
      anchor_value: null,
      sigma_basis: 'atr_14',
      sigma_basis_value: 2,
    });
    expect(createSignedShockMeasurement({
      price: 104,
      anchor_type: 'vwap',
      anchor_value: 100,
      sigma_basis: 'atr_14',
      sigma_basis_value: 0,
    })).toEqual({
      value: null,
      anchor_type: 'vwap',
      anchor_value: 100,
      sigma_basis: 'atr_14',
      sigma_basis_value: null,
    });
  });

  it('falls closed for missing context inputs before the RTH open', () => {
    const state = createSnapshotContextState();
    const context = updateSnapshotContextForBar(state, {
      bar: contextBar(-60_000_000_000n, { open: 100, high: 102, low: 98, close: 101 }),
      rth_start_ts_ns: 0n,
    });

    expect(context).toMatchObject({
      prior_day_close: null,
      prior_day_high: null,
      prior_day_low: null,
      today_open: null,
      vix_value: null,
      vix_fresh: false,
      vix_prior_close_percentile: null,
      regime_label: 'unknown',
      opening_range_high: null,
      opening_range_low: null,
      opening_range_minutes_elapsed: 0,
    });
  });

  it('locks opening range at exactly OPENING_RANGE_MINUTES and leaves it fixed', () => {
    const state = createSnapshotContextState();
    updateSnapshotContextForBar(state, {
      bar: contextBar(0n, { open: 100, high: 101, low: 99, close: 100 }),
      rth_start_ts_ns: 0n,
    });
    updateSnapshotContextForBar(state, {
      bar: contextBar(29n * 60_000_000_000n, { open: 100, high: 103, low: 98, close: 101 }),
      rth_start_ts_ns: 0n,
    });
    const atBoundary = updateSnapshotContextForBar(state, {
      bar: contextBar(30n * 60_000_000_000n, { open: 100, high: 200, low: 1, close: 101 }),
      rth_start_ts_ns: 0n,
    });

    expect(atBoundary.opening_range_high).toBe(103);
    expect(atBoundary.opening_range_low).toBe(98);
    expect(atBoundary.opening_range_minutes_elapsed).toBe(30);

    const afterBoundary = updateSnapshotContextForBar(state, {
      bar: contextBar(31n * 60_000_000_000n, { open: 100, high: 250, low: 0, close: 101 }),
      rth_start_ts_ns: 0n,
    });
    expect(afterBoundary.opening_range_high).toBe(103);
    expect(afterBoundary.opening_range_low).toBe(98);
    expect(afterBoundary.opening_range_minutes_elapsed).toBe(30);
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

function contextBar(
  startTsNs: bigint,
  prices: {
    readonly open: number;
    readonly high: number;
    readonly low: number;
    readonly close: number;
    readonly volume?: number;
  },
): SnapshotPriceBar & { readonly open: number; readonly start_ts_ns: bigint; readonly volume?: number } {
  return {
    start_ts_ns: startTsNs,
    ...prices,
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
