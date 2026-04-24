import { describe, expect, it } from 'vitest';
import { getContractSpec } from '../../src/risk/contracts.js';
import {
  buildDefaultProfileFromConfig,
  getManagementProfile,
  getSetupFamily,
  resolveProfile,
} from '../../src/management/management-profiles.js';
import type { ManagementProfile } from '../../src/management/types.js';
import { makeConfig } from './helpers.js';

const contract = getContractSpec('MNQ1!');

describe('Management profiles', () => {
  it('maps active setup ids to the intended families', () => {
    expect(getSetupFamily('trend_pullback_long')).toBe('trend_pullback');
    expect(getSetupFamily('trend_pullback_short')).toBe('trend_pullback');
    expect(getSetupFamily('breakout_retest_long')).toBe('breakout_retest');
    expect(getSetupFamily('breakdown_retest_short')).toBe('breakout_retest');
  });

  it('resolves ATR-based offsets and safety spacing', () => {
    const profile: ManagementProfile = {
      name: 'trend_pullback',
      family: 'trend_pullback',
      pt1_offset_atr: 0.5,
      pt2_offset_atr: 0.51,
      pt1_offset_pts_fallback: 6,
      pt2_offset_pts_fallback: 15,
      pt1_exit_fraction: 0.5,
      pt2_exit_fraction: 0.25,
      pt1_move_to_be: true,
      pt1_activate_trailing: true,
      trail_atr_post_t1: 0.3,
      trail_ticks_post_t1_fallback: 12,
      breakeven_trigger_r: 0.5,
      pre_t1_trail_trigger_r: 0.75,
      pre_t1_trail_atr: 0.4,
      pre_t1_trail_ticks_fallback: 18,
      time_stop_minutes: 25,
      time_stop_max_r_pre_t1: 0.25,
      time_stop_max_r_post_t1: 1,
    };

    const resolved = resolveProfile(profile, 10, contract);
    expect(resolved.pt1_offset_pts).toBeCloseTo(5, 3);
    expect(resolved.pt2_offset_pts).toBeGreaterThanOrEqual(resolved.pt1_offset_pts + contract.tick_size * 4);
    expect(resolved.trail_ticks_post_t1).toBeGreaterThan(0);
  });

  it('falls back to fixed config when no explicit family profile exists', () => {
    const config = makeConfig();
    const defaultProfile = buildDefaultProfileFromConfig(config);
    const selected = getManagementProfile('trend_pullback_short', 'trending_down', config);
    expect(defaultProfile.pt1_offset_pts_fallback).toBe(config.pt1_offset_pts);
    expect(selected.name).toBe('legacy_default');
  });
});
