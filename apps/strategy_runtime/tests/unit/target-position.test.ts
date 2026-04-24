import { describe, expect, it } from 'vitest';
import { getContractSpec } from '../../src/risk/contracts.js';
import {
  DEFAULT_POSITION_TARGET_CONFIG,
  computeTargetPosition,
  describeTargetAction,
} from '../../src/management/target-position.js';

const contract = getContractSpec('MNQ1!');

describe('Target-position sizing', () => {
  it('computes a target position bounded by risk, soft cap, and hard cap', () => {
    const result = computeTargetPosition({
      stop_distance_pts: 12,
      contract,
      equity: 25_000,
      max_risk_per_trade_pct: 0.5,
      confidence_raw: 0.75,
      confidence_source: 'management_pop_t2',
      regime: 'trending_up',
      session_bucket: 'NY_AM',
      daily_loss_pct: 0,
      max_daily_loss_pct: 2,
      hard_cap: 10,
      config: DEFAULT_POSITION_TARGET_CONFIG,
    });

    expect(result.q_target).toBeGreaterThan(0);
    expect(result.bound_by_all.length).toBeGreaterThan(0);
    expect(result.stop_distance_ticks).toBeGreaterThan(0);
  });

  it('describes reduce, flatten, cooldown, and stale-input actions', () => {
    expect(describeTargetAction(-2, 5, 0, 0)).toEqual({ kind: 'REDUCE', qty: 2 });
    expect(describeTargetAction(-5, 0, 0, 0)).toEqual({ kind: 'FLATTEN_PENDING', qty: 0 });
    expect(describeTargetAction(-1, 5, 1, 0)).toEqual({ kind: 'HOLD_PERSISTENCE', qty: 1 });
    expect(describeTargetAction(-1, 5, 0, 5)).toEqual({ kind: 'HOLD_COOLDOWN', qty: 1 });
    expect(describeTargetAction(-1, 5, 0, 0, false, true)).toEqual({ kind: 'HOLD_STALE_INPUT', qty: 0 });
  });
});
