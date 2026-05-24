import { describe, expect, it } from 'vitest';

import {
  generateRegimeShockReversionShortV3,
  type StrategyFeatureSnapshot,
  type StrategyFeatureSnapshotRegime,
} from '../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

describe('regime_shock_reversion_short_v3 gate stack', () => {
  it('arms on calm-bucket VIX percentile below the over-fire band', () => {
    const result = generateRegimeShockReversionShortV3({
      strategy_id: 'regime_shock_reversion_short_v3',
      snapshot: withRegimeShockAndVix('high', 2.5, 0.5),
    });

    expect(result.candidate?.direction).toBe('short');
    expect(result.evaluation.gate_state).toBe('armed');
    expect(result.evaluation.reasons).toContain('vix_pct:0.5');
    expect(result.evaluation.reasons).toContain('signed_shock_vwap:2.5');
  });

  it('arms on extreme-bucket VIX percentile above the over-fire band', () => {
    const result = generateRegimeShockReversionShortV3({
      strategy_id: 'regime_shock_reversion_short_v3',
      snapshot: withRegimeShockAndVix('high', 2.5, 0.92),
    });

    expect(result.candidate?.direction).toBe('short');
    expect(result.evaluation.gate_state).toBe('armed');
    expect(result.evaluation.reasons).toContain('vix_pct:0.92');
  });

  it('rejects VIX percentile inside the over-fire band', () => {
    const result = generateRegimeShockReversionShortV3({
      strategy_id: 'regime_shock_reversion_short_v3',
      snapshot: withRegimeShockAndVix('high', 2.5, 0.75),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe(
      'regime_shock_reversion_short_v3:vix_in_overfire_band',
    );
  });

  it('fails closed when VIX percentile is unavailable', () => {
    const result = generateRegimeShockReversionShortV3({
      strategy_id: 'regime_shock_reversion_short_v3',
      snapshot: withRegimeShockAndVix('high', 2.5, null),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe(
      'regime_shock_reversion_short_v3:vix_percentile_unavailable',
    );
  });

  it('rejects exactly at the inclusive lower over-fire boundary', () => {
    const result = generateRegimeShockReversionShortV3({
      strategy_id: 'regime_shock_reversion_short_v3',
      snapshot: withRegimeShockAndVix('high', 2.5, 0.67),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe(
      'regime_shock_reversion_short_v3:vix_in_overfire_band',
    );
  });

  it('arms exactly at the exclusive upper over-fire boundary', () => {
    const result = generateRegimeShockReversionShortV3({
      strategy_id: 'regime_shock_reversion_short_v3',
      snapshot: withRegimeShockAndVix('high', 2.5, 0.85),
    });

    expect(result.candidate?.direction).toBe('short');
    expect(result.evaluation.gate_state).toBe('armed');
    expect(result.evaluation.reasons).toContain('vix_pct:0.85');
  });

  it('keeps the v2 high-regime shock threshold after the VIX gate clears', () => {
    const result = generateRegimeShockReversionShortV3({
      strategy_id: 'regime_shock_reversion_short_v3',
      snapshot: withRegimeShockAndVix('high', 1.5, 0.92),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe(
      'regime_shock_reversion_short_v3:high_regime_shock_below_pos_threshold',
    );
  });

  it('keeps the v2 fail-closed regime-label behavior after the VIX gate clears', () => {
    const result = generateRegimeShockReversionShortV3({
      strategy_id: 'regime_shock_reversion_short_v3',
      snapshot: withRegimeShockAndVix('unknown', 2.5, 0.92),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe(
      'regime_shock_reversion_short_v3:missing_regime_label',
    );
  });
});

function withRegimeShockAndVix(
  regime: StrategyFeatureSnapshotRegime,
  shock: number,
  vixPercentile: number | null,
): StrategyFeatureSnapshot {
  const base = STRATEGY_SYNTHETIC_FIXTURES.regime_shock_reversion_short_v3.snapshot;
  const anchor = 18600;
  const sigma = 6;
  const midPx = anchor + shock * sigma;
  return {
    ...base,
    quote: {
      bid_px: midPx - 0.125,
      ask_px: midPx + 0.125,
      mid_px: midPx,
    },
    last_trade_price: midPx,
    context: {
      ...base.context,
      regime_label: regime,
      vix_prior_close_percentile: vixPercentile,
      session_vwap: anchor,
      signed_shock_vwap: {
        value: shock,
        anchor_type: 'vwap',
        anchor_value: anchor,
        sigma_basis: 'atr_14',
        sigma_basis_value: sigma,
      },
    },
  };
}
