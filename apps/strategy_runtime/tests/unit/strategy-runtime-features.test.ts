import { describe, expect, it } from 'vitest';
import { buildDynamicRewardPlan } from '../../src/features/dynamic-reward-plan.js';
import {
  buildBucketTableFromRows,
  lookupExpectancy,
} from '../../src/features/expectancy-engine.js';
import { makeConfig, makeSnapshot } from './helpers.js';

describe('Runtime feature extraction', () => {
  it('builds a dynamic reward plan using structure and management profiles', () => {
    const snap = makeSnapshot();
    const config = makeConfig();
    const setup = {
      direction: 'long' as const,
      setup_type: 'trend_pullback_long' as const,
      entry_low: 20_000,
      entry_high: 20_002,
      stop: 19_990,
      target_1: 20_015,
      target_2: 20_030,
      target_3: null,
      risk_pts: 10,
      rr_t1: 1.5,
      rr_t2: 3,
      confidence: 8.2,
      confidence_factors: ['fixture'],
      reason: 'fixture',
    };

    const plan = buildDynamicRewardPlan(setup, snap, 'trending_up', config);
    expect(plan.dynamic_min_rr).toBeGreaterThan(1);
    expect(plan.mgmt_pt1_offset_pts).toBeGreaterThan(0);
  });

  it('falls back from sparse full buckets to reduced-dimension expectancy lookup', () => {
    const table = buildBucketTableFromRows([
      { direction: 'long', z_ema9: 0.3, pullback_ratio: 0.4, z_ofi_blend: 0.6, realized_r_30s: 0.35 },
      { direction: 'long', z_ema9: 0.35, pullback_ratio: 0.42, z_ofi_blend: 0.7, realized_r_30s: 0.25 },
      { direction: 'long', z_ema9: 0.4, pullback_ratio: 0.45, z_ofi_blend: 0.8, realized_r_30s: 0.3 },
    ], { min_n: 1 });

    const estimate = lookupExpectancy(table, {
      direction: 'long',
      vector: {
        schema_version: '1.0.0',
        timestamp_unix: 1,
        direction: 'long',
        setup_type: 'trend_pullback_long',
        sigma_pts: 10,
        micro_atr: 8,
        room_atr: 12,
        session_atr: 40,
        z_ema9: 0.3,
        z_ema21: 0.4,
        z_vwap: 0.5,
        pullback_ratio: 0.41,
        impulse_maturity_bars: 3,
        regime: 'trending_up',
        ofi_10s: 1,
        ofi_30s: 2,
        z_ofi_10s: 0.5,
        z_ofi_30s: 0.6,
        z_ofi_blend: null,
        queue_imbalance_5: 0.1,
        microprice_offset_pts: 0.02,
        lob_state: 'fresh',
        ofi_reliability: 'sparse',
      },
      cost_r: 0.05,
      min_n: 1,
    });

    expect(estimate.bucket_source).toBe('backoff_1d');
    expect(estimate.expected_r_30s_post_cost).toBeGreaterThan(0);
  });
});
