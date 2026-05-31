import { describe, expect, it } from 'vitest';

import type { ManagementProfile } from '../../../src/management/types.js';
import type { TargetPosition } from '../../../src/management/target-position.js';
import type { PositionManagerMarketInput } from '../../../src/management/position-manager/index.js';
import { evaluatePositionManager } from '../../../src/management/position-manager/index.js';
import { evaluateFailSafe } from '../../../src/management/position-manager/fail-safe.js';

const profile = {
  profile_id: 'regime_shock_reversion_short_v2_management_v1',
  profile_version: 1,
} as unknown as ManagementProfile;

const instrument = {
  symbol: 'MNQ',
  root: 'MNQ',
  exchange: 'CME',
  tick_size: 0.25,
  point_value: 2,
  currency: 'USD',
};

function target(
  label: 'pt1' | 'pt2',
  price: number,
  rewardRisk: number,
): TargetPosition['targets'][number] {
  return {
    label,
    price,
    quantity: label === 'pt1' ? 0 : 1,
    filled_quantity: 0,
    reward_risk: rewardRisk,
    status: 'pending',
  } as TargetPosition['targets'][number];
}

function position(overrides: Partial<TargetPosition> = {}): TargetPosition {
  const side = overrides.side ?? 'short';
  const entry = overrides.entry_price ?? 20000;
  const initialStop = overrides.initial_stop_price ?? (side === 'long' ? 19990 : 20010);
  const activeStop = overrides.active_stop_price ?? initialStop;
  const targets = side === 'long'
    ? [target('pt1', 20010, 1), target('pt2', 20020, 2)]
    : [target('pt1', 19990, 1), target('pt2', 19980, 2)];
  return {
    position_id: 'position-stop-priority-correction' as never,
    candidate_id: 'candidate-stop-priority-correction' as never,
    fill_id: 'fill-stop-priority-correction' as never,
    strategy_id: 'regime_shock_reversion_short_v2' as never,
    instrument,
    side,
    lifecycle_state: 'open',
    quantity: 1,
    remaining_quantity: 1,
    entry_price: entry,
    initial_stop_price: initialStop,
    active_stop_price: activeStop,
    risk_points: 10,
    pt1_touched: false,
    targets,
    break_even: { enabled: false, trigger: 'after_pt1', moved: false, offset_ticks: 0 },
    trailing_stop: { enabled: false, active: false, mode: 'post_pt1_ticks', distance_ticks: 8 },
    time_stop: { enabled: false, max_hold_minutes: 30, at_deadline_extension: 'enforce_floor' },
    fail_safe: { enabled: true, max_adverse_r: 1, max_spread_ticks: 8 },
    profile_id: 'regime_shock_reversion_short_v2_management_v1' as never,
    profile_version: 1,
    profile_hash: 'profile-hash-stop-priority-correction',
    opened_ts_ns: '1' as never,
    updated_ts_ns: '1' as never,
    realized_pnl_usd: 0,
    unrealized_pnl_usd: 0,
    reasons: [],
    ...overrides,
  } as unknown as TargetPosition;
}

function market(overrides: Partial<PositionManagerMarketInput>): PositionManagerMarketInput {
  return {
    event_ts_ns: '2' as never,
    mark_price: 20000,
    authority: 'authoritative',
    ...overrides,
  };
}

describe('MGMT-BUGFIX-FAILSAFE-FILL-MODEL-CORRECTION-01 stop priority', () => {
  it('routes same-bar short stop and max-adverse overlap to stop hit', () => {
    const short = position();
    const sameBar = market({
      mark_price: 20012,
      high_price: 20015,
      low_price: 20005,
    });

    const failSafe = evaluateFailSafe(short, profile, sameBar);
    const integrated = evaluatePositionManager({ position: short, profile, market: sameBar });

    expect(failSafe.actions).toEqual([]);
    expect(failSafe.reasons).toEqual(['fail_safe:declined_stop_overlap']);
    expect(failSafe.terminal_reason).toBeUndefined();
    expect(integrated.actions).toHaveLength(1);
    expect(integrated.actions[0]).toMatchObject({
      action_type: 'EXIT_FULL',
      reason: 'stop:hit',
      exit_quantity: 1,
      exit_price: 20010,
      realized_r: -1,
    });
    expect(integrated.management_action_payloads[0]).toMatchObject({
      action_type: 'EXIT_FULL',
      reason: 'stop:hit',
      exit_price: 20010,
    });
    expect(integrated.reasons).toEqual(['fail_safe:declined_stop_overlap', 'stop:hit']);
  });

  it('keeps max-adverse fail-safe when the declared stop is not touched', () => {
    const short = position({ active_stop_price: 20012 });
    const result = evaluateFailSafe(short, profile, market({
      mark_price: 20010,
      high_price: 20010,
    }));

    expect(result).toMatchObject({
      terminal_reason: 'fail_safe',
      reasons: ['fail_safe:max_adverse_r_exceeded'],
    });
    expect(result.actions[0]).toMatchObject({
      action_type: 'FAIL_SAFE_EXIT',
      reason: 'fail_safe:max_adverse_r_exceeded',
      exit_price: 20010,
      realized_r: -1,
    });
  });

  it('keeps missing-stop hard fail-safe precedence when active stop is invalid', () => {
    const result = evaluateFailSafe(
      position({ active_stop_price: 0 }),
      profile,
      market({ mark_price: 20010, high_price: 20015 }),
    );

    expect(result.terminal_reason).toBe('fail_safe');
    expect(result.actions[0]?.reason).toBe('fail_safe:missing_stop');
  });

  it.each([
    ['profile mismatch', position(), { profile_id: 'other_profile', profile_version: 1 }, market({ mark_price: 20012, high_price: 20015 }), 'fail_safe:profile_mismatch'],
    ['stale market', position(), profile, market({ mark_price: 20012, high_price: 20015, is_stale: true }), 'fail_safe:stale_market'],
    ['invalid market price', position(), profile, market({ mark_price: -1, high_price: 20015 }), 'fail_safe:invalid_market_price'],
    ['missing stop', position({ active_stop_price: 0 }), profile, market({ mark_price: 20012, high_price: 20015 }), 'fail_safe:missing_stop'],
    ['invalid quantity', position({ remaining_quantity: -1 }), profile, market({ mark_price: 20012, high_price: 20015 }), 'fail_safe:invalid_quantity'],
    ['invalid target position', position({ side: 'sideways' as never }), profile, market({ mark_price: 20012, high_price: 20015 }), 'fail_safe:invalid_target_position:$.side'],
  ])('preserves hard-class fail-safe precedence for %s', (_name, inputPosition, inputProfile, inputMarket, expectedReason) => {
    const result = evaluateFailSafe(
      inputPosition as TargetPosition,
      inputProfile as ManagementProfile,
      inputMarket as PositionManagerMarketInput,
    );

    expect(result.terminal_reason).toBe('fail_safe');
    expect(result.actions[0]?.action_type).toBe('FAIL_SAFE_EXIT');
    expect(result.actions[0]?.reason).toBe(expectedReason);
    expect(result.reasons).toEqual([expectedReason]);
  });

  it('preserves profitable max-spread fail-safe behavior', () => {
    const result = evaluateFailSafe(position(), profile, market({
      mark_price: 19990,
      high_price: 19995,
      bid_px: 19985,
      ask_px: 20000,
      authority: 'authoritative',
    }));

    expect(result.terminal_reason).toBe('fail_safe');
    expect(result.actions[0]).toMatchObject({
      action_type: 'FAIL_SAFE_EXIT',
      reason: 'fail_safe:max_spread_ticks_exceeded',
      exit_price: 19990,
      realized_r: 1,
    });
  });

  it('routes same-bar long stop and max-adverse overlap to stop hit', () => {
    const long = position({
      side: 'long',
      initial_stop_price: 19990,
      active_stop_price: 19990,
      strategy_id: 'trend_pullback_long' as never,
    });
    const sameBar = market({
      mark_price: 19988,
      high_price: 20005,
      low_price: 19985,
    });

    const failSafe = evaluateFailSafe(long, profile, sameBar);
    const integrated = evaluatePositionManager({ position: long, profile, market: sameBar });

    expect(failSafe.actions).toEqual([]);
    expect(failSafe.reasons).toEqual(['fail_safe:declined_stop_overlap']);
    expect(failSafe.terminal_reason).toBeUndefined();
    expect(integrated.actions[0]).toMatchObject({
      action_type: 'EXIT_FULL',
      reason: 'stop:hit',
      exit_price: 19990,
      realized_r: -1,
    });
  });
});
