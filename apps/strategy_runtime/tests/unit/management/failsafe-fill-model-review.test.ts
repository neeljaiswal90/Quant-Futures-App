import { describe, expect, it } from 'vitest';

import type { ManagementProfile } from '../../../src/management/types.js';
import type { TargetPosition } from '../../../src/management/target-position.js';
import type { PositionManagerMarketInput } from '../../../src/management/position-manager/index.js';
import { evaluatePositionManager } from '../../../src/management/position-manager/index.js';
import { evaluateFailSafe } from '../../../src/management/position-manager/fail-safe.js';
import { evaluateStopHit } from '../../../src/management/position-manager/stops.js';

const profile = {
  profile_id: 'regime_shock_reversion_short_v2_management_v1',
  profile_version: 1,
} as unknown as ManagementProfile;

function shortPosition(overrides: Partial<TargetPosition> = {}): TargetPosition {
  return {
    position_id: 'position-fill-model-review' as never,
    candidate_id: 'candidate-fill-model-review' as never,
    fill_id: 'fill-fill-model-review' as never,
    strategy_id: 'regime_shock_reversion_short_v2' as never,
    instrument: {
      symbol: 'MNQ',
      root: 'MNQ',
      exchange: 'CME',
      tick_size: 0.25,
      point_value: 2,
      currency: 'USD',
    },
    side: 'short',
    lifecycle_state: 'open',
    quantity: 1,
    remaining_quantity: 1,
    entry_price: 20000,
    initial_stop_price: 20010,
    active_stop_price: 20010,
    risk_points: 10,
    pt1_touched: false,
    targets: [
      { label: 'pt1', price: 19990, quantity: 0, filled_quantity: 0, reward_risk: 1, status: 'pending' },
      { label: 'pt2', price: 19980, quantity: 1, filled_quantity: 0, reward_risk: 2, status: 'pending' },
    ],
    break_even: { enabled: false, trigger: 'after_pt1', moved: false, offset_ticks: 0 },
    trailing_stop: { enabled: false, active: false, mode: 'post_pt1_ticks', distance_ticks: 8 },
    time_stop: { enabled: false, max_hold_minutes: 30, at_deadline_extension: 'enforce_floor' },
    fail_safe: { enabled: true, max_adverse_r: 1, max_spread_ticks: 8 },
    profile_id: 'regime_shock_reversion_short_v2_management_v1' as never,
    profile_version: 1,
    profile_hash: 'profile-hash-fill-model-review',
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

describe('fail-safe fill model review', () => {
  it('exits a short stop at the declared active stop price', () => {
    const result = evaluateStopHit(shortPosition(), market({
      high_price: 20015,
      low_price: 20005,
      mark_price: 20012,
    }));

    expect(result.terminal_reason).toBe('stop_hit');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.exit_price).toBe(20010);
    expect(result.actions[0]?.realized_r).toBe(-1);
    expect(result.actions[0]?.realized_pnl_usd).toBe(-20);
  });

  it('triggers max adverse fail-safe at exactly 1R and exits at mark price', () => {
    const result = evaluateFailSafe(shortPosition(), profile, market({ mark_price: 20010 }));

    expect(result.terminal_reason).toBe('fail_safe');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.reason).toBe('fail_safe:max_adverse_r_exceeded');
    expect(result.actions[0]?.exit_price).toBe(20010);
    expect(result.actions[0]?.realized_r).toBe(-1);
    expect(result.actions[0]?.realized_pnl_usd).toBe(-20);
  });

  it('exits a 1.25R max adverse fail-safe at the adverse mark price', () => {
    const result = evaluateFailSafe(shortPosition(), profile, market({ mark_price: 20012.5 }));

    expect(result.terminal_reason).toBe('fail_safe');
    expect(result.actions[0]?.reason).toBe('fail_safe:max_adverse_r_exceeded');
    expect(result.actions[0]?.exit_price).toBe(20012.5);
    expect(result.actions[0]?.realized_r).toBe(-1.25);
    expect(result.actions[0]?.realized_pnl_usd).toBe(-25);
    expect((result.actions[0]?.realized_pnl_usd ?? 0) - (-20)).toBe(-5);
  });

  it('exits a 2R max adverse fail-safe at the adverse mark price', () => {
    const result = evaluateFailSafe(shortPosition(), profile, market({ mark_price: 20020 }));

    expect(result.terminal_reason).toBe('fail_safe');
    expect(result.actions[0]?.reason).toBe('fail_safe:max_adverse_r_exceeded');
    expect(result.actions[0]?.exit_price).toBe(20020);
    expect(result.actions[0]?.realized_r).toBe(-2);
    expect(result.actions[0]?.realized_pnl_usd).toBe(-40);
    expect((result.actions[0]?.realized_pnl_usd ?? 0) - (-20)).toBe(-20);
  });

  it('preempts a same-bar short stop with fail-safe because fail-safe runs first', () => {
    const sameBarMarket = market({
      high_price: 20025,
      low_price: 20008,
      mark_price: 20020,
    });
    const stop = evaluateStopHit(shortPosition(), sameBarMarket);
    const failSafe = evaluateFailSafe(shortPosition(), profile, sameBarMarket);
    const integrated = evaluatePositionManager({ position: shortPosition(), profile, market: sameBarMarket });

    expect(stop.terminal_reason).toBe('stop_hit');
    expect(stop.actions[0]?.exit_price).toBe(20010);
    expect(failSafe.terminal_reason).toBe('fail_safe');
    expect(failSafe.actions[0]?.exit_price).toBe(20020);
    expect(integrated.fsm_state).toBe('FAILED_SAFE_EXIT');
    expect(integrated.actions).toHaveLength(1);
    expect(integrated.actions[0]?.reason).toBe('fail_safe:max_adverse_r_exceeded');
    expect(integrated.actions[0]?.exit_price).toBe(20020);
  });

  it('uses mark price rather than ask price for an authoritative short-cover fail-safe', () => {
    const result = evaluateFailSafe(shortPosition(), profile, market({
      mark_price: 20020,
      bid_px: 20019.5,
      ask_px: 20020.5,
      authority: 'authoritative',
    }));

    expect(result.terminal_reason).toBe('fail_safe');
    expect(result.actions[0]?.reason).toBe('fail_safe:max_adverse_r_exceeded');
    expect(result.actions[0]?.exit_price).toBe(20020);
    expect(result.actions[0]?.exit_price).not.toBe(20020.5);
  });

  it('can emit a profitable spread fail-safe when the mark is favorable', () => {
    const result = evaluateFailSafe(shortPosition(), profile, market({
      mark_price: 19990,
      bid_px: 19985,
      ask_px: 20000,
      authority: 'authoritative',
    }));

    expect(result.terminal_reason).toBe('fail_safe');
    expect(result.actions[0]?.reason).toBe('fail_safe:max_spread_ticks_exceeded');
    expect(result.actions[0]?.exit_price).toBe(19990);
    expect(result.actions[0]?.realized_r).toBe(1);
    expect(result.actions[0]?.realized_pnl_usd).toBe(20);
  });
});
