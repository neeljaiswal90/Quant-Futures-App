import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REGIME_MEAN_REVERSION_LONG_CONFIG,
  type RegimeMeanReversionStrategyParameters,
} from '../../src/config/index.js';
import {
  computeSignedShock,
  computeVwapReference,
  validateRegimeMeanReversionParameters,
} from '../../src/strategies/index.js';
import type { StrategyFeatureSnapshot } from '../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

describe('regime mean reversion signed shock helpers', () => {
  it('computes session VWAP anchored signed shock', () => {
    const snapshot = makeSnapshot({
      midPx: 104.5,
      sigmaPts: 2,
      closes: [100, 102],
      volumes: [1, 3],
    });
    const parameters = {
      ...DEFAULT_REGIME_MEAN_REVERSION_LONG_CONFIG,
      vwap_reference: 'session_vwap' as const,
    };

    expect(computeVwapReference(snapshot, parameters)).toBe(101.5);
    expect(computeSignedShock(snapshot, parameters)).toBe(1.5);
  });

  it('uses only bars inside the opening-window VWAP horizon', () => {
    const snapshot = makeSnapshot({
      midPx: 104,
      sigmaPts: 2,
      closes: [100, 110],
      volumes: [1, 10],
    });
    const parameters = {
      ...DEFAULT_REGIME_MEAN_REVERSION_LONG_CONFIG,
      vwap_reference: 'opening_window_vwap' as const,
      opening_window_minutes: 1,
    };

    expect(computeVwapReference(snapshot, parameters)).toBe(100);
    expect(computeSignedShock(snapshot, parameters)).toBe(2);
  });

  it('fails closed when the configured reference is unavailable', () => {
    const snapshot = makeSnapshot({
      midPx: 104,
      sigmaPts: 2,
      closes: [100],
      volumes: [1],
      priorDayClose: null,
    });
    const parameters = {
      ...DEFAULT_REGIME_MEAN_REVERSION_LONG_CONFIG,
      vwap_reference: 'prior_day_close' as const,
    };

    expect(computeVwapReference(snapshot, parameters)).toBeNull();
    expect(computeSignedShock(snapshot, parameters)).toBeNull();
  });

  it('validates stricter low-regime thresholds and confidence ordering', () => {
    const invalid: RegimeMeanReversionStrategyParameters = {
      ...DEFAULT_REGIME_MEAN_REVERSION_LONG_CONFIG,
      low_shock_threshold_neg: DEFAULT_REGIME_MEAN_REVERSION_LONG_CONFIG.high_shock_threshold_neg,
      confidence_score_low: DEFAULT_REGIME_MEAN_REVERSION_LONG_CONFIG.confidence_score_high,
    };

    expect(validateRegimeMeanReversionParameters(invalid)).toEqual([
      'low_shock_threshold_neg_must_exceed_high_shock_threshold_neg',
      'confidence_score_low_must_be_less_than_high',
    ]);
  });
});

function makeSnapshot(input: {
  readonly midPx: number;
  readonly sigmaPts: number;
  readonly closes: readonly number[];
  readonly volumes: readonly number[];
  readonly priorDayClose?: number | null;
}): StrategyFeatureSnapshot {
  const base = STRATEGY_SYNTHETIC_FIXTURES.regime_mean_reversion_long.snapshot;
  const bars = input.closes.map((close, index) => ({
    ...base.bars[Math.min(index, base.bars.length - 1)]!,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: input.volumes[index] ?? 0,
  }));

  return {
    ...base,
    quote: {
      bid_px: input.midPx - 0.125,
      ask_px: input.midPx + 0.125,
      mid_px: input.midPx,
    },
    last_trade_price: input.midPx,
    bars,
    indicators: {
      ...base.indicators,
      sigma_pts: input.sigmaPts,
    },
    context: {
      ...base.context,
      prior_day_close: input.priorDayClose ?? base.context.prior_day_close,
    },
  };
}
