import { describe, expect, it } from 'vitest';
import {
  generateLiquiditySweepReversalLong,
  generateLiquiditySweepReversalShort,
} from '../../src/strategies/index.js';
import type { StrategyFeatureSnapshot } from '../../src/strategies/types.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

describe('liquidity_sweep_reversal_long: sizing uniformity across sweep cells', () => {
  const intensities = [0.5, 1, 2.5, 4] as const;
  const depthRatios = [0.2, 0.5, 0.7] as const;

  for (const intensity of intensities) {
    for (const depthRatio of depthRatios) {
      it(`keeps risk and target fractions fixed for intensity=${intensity}, depth=${depthRatio}`, () => {
        const result = generateLiquiditySweepReversalLong({
          strategy_id: 'liquidity_sweep_reversal_long',
          snapshot: withSweepCell(
            STRATEGY_SYNTHETIC_FIXTURES.liquidity_sweep_reversal_long.snapshot,
            'down',
            intensity,
            depthRatio,
          ),
        });

        expect(result.candidate).toBeDefined();
        expect(result.candidate?.risk_points).toBe(1.5);
        expect(result.candidate?.targets.map((target) => target.quantity_fraction)).toEqual([0.5, 0.5]);
      });
    }
  }
});

describe('liquidity_sweep_reversal_short: sizing uniformity across sweep cells', () => {
  const intensities = [0.5, 1, 2.5, 4] as const;
  const depthRatios = [0.2, 0.5, 0.7] as const;

  for (const intensity of intensities) {
    for (const depthRatio of depthRatios) {
      it(`keeps risk and target fractions fixed for intensity=${intensity}, depth=${depthRatio}`, () => {
        const result = generateLiquiditySweepReversalShort({
          strategy_id: 'liquidity_sweep_reversal_short',
          snapshot: withSweepCell(
            STRATEGY_SYNTHETIC_FIXTURES.liquidity_sweep_reversal_short.snapshot,
            'up',
            intensity,
            depthRatio,
          ),
        });

        expect(result.candidate).toBeDefined();
        expect(result.candidate?.risk_points).toBe(1.5);
        expect(result.candidate?.targets.map((target) => target.quantity_fraction)).toEqual([0.5, 0.5]);
      });
    }
  }
});

function withSweepCell(
  snapshot: StrategyFeatureSnapshot,
  direction: 'down' | 'up',
  intensity: number,
  depthRatio: number,
): StrategyFeatureSnapshot {
  const bars = snapshot.bars;
  const lastIndex = bars.length - 1;
  const prior = bars[lastIndex - 1]!;
  const current = bars[lastIndex]!;
  const sigmaPts = 2;
  const close = prior.close + (direction === 'down' ? -intensity * sigmaPts : intensity * sigmaPts);
  const depthImbalance = direction === 'down' ? depthRatio - 1 : 1 - depthRatio;
  return {
    ...snapshot,
    bars: bars.map((bar, index) => index === lastIndex
      ? {
          ...current,
          open: close,
          high: Math.max(close, current.high),
          low: Math.min(close, current.low),
          close,
        }
      : bar),
    quote: {
      bid_px: close - snapshot.instrument.tick_size / 2,
      ask_px: close + snapshot.instrument.tick_size / 2,
      mid_px: close,
    },
    indicators: {
      ...snapshot.indicators,
      sigma_pts: sigmaPts,
      z_ofi_blend: direction === 'down' ? -intensity : intensity,
    },
    microstructure: {
      ...snapshot.microstructure,
      values: {
        ...snapshot.microstructure.values,
        depth_imbalance: depthImbalance,
        ofi_z: direction === 'down' ? -intensity : intensity,
        bars_since_sweep: 0,
      },
    },
  };
}
