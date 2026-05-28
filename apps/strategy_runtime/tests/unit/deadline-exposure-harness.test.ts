import { describe, expect, it } from 'vitest';

import type { Candidate } from '../../src/contracts/candidate.js';
import type { SimulatedFill } from '../../src/contracts/execution.js';
import {
  makeCandidateId,
  makeConfigHash,
  makeFeatureSnapshotId,
  makeFillId,
  makeOrderIntentId,
} from '../../src/contracts/ids.js';
import type { InstrumentIdentity } from '../../src/contracts/market.js';
import type { StrategyId } from '../../src/contracts/strategy-ids.js';
import {
  ns,
  type UnixNs,
} from '../../src/contracts/time.js';
import { resolveManagementProfile } from '../../src/management/management-profiles.js';
import type { TargetPosition } from '../../src/management/target-position.js';
import {
  applyInitialFillToTargetPosition,
  buildTargetPositionFromCandidate,
} from '../../src/management/target-position.js';
import type { ManagementProfile } from '../../src/management/types.js';
import type { PositionManagerMarketInput } from '../../src/management/position-manager/index.js';
import { evaluateTimeStop } from '../../src/management/position-manager/time-stops.js';

const STRICT_STRATEGY_ID = 'regime_shock_reversion_short_v5_strict_deadline' as const;
const TRAIL_STRATEGY_ID = 'regime_shock_reversion_short_v5_trail_at_deadline' as const;
const OPENED_TS_NS = ns('1700000000000000000');
const NS_PER_MINUTE = 60_000_000_000n;

const MNQ: InstrumentIdentity = {
  root: 'MNQ',
  symbol: 'MNQH26',
  exchange: 'CME',
  currency: 'USD',
  contract_month: '2026-03',
  tick_size: 0.25,
  point_value: 2,
  price_decimals: 2,
};

describe('CYCLE4-DEADLINE-EXPOSURE-HARNESS-01', () => {
  it('resolves the registered v5 management profiles used by the controlled harness', () => {
    const strictProfile = resolveHarnessProfile(STRICT_STRATEGY_ID);
    const trailProfile = resolveHarnessProfile(TRAIL_STRATEGY_ID);

    expect(strictProfile.time_stop.at_deadline_extension).toBe('unconditional_exit');
    expect(trailProfile.time_stop.at_deadline_extension).toBe('activate_trail');
    expect(trailProfile.trailing_stop).toMatchObject({
      enabled: true,
      distance_ticks: 8,
      mode: 'post_pt1_ticks',
    });
  });

  it('exits the strict deadline profile at the normal constructed deadline', () => {
    const profile = resolveHarnessProfile(STRICT_STRATEGY_ID);
    const position = openShortPosition(STRICT_STRATEGY_ID, profile);
    const market = deadlineMarket(position, 99);

    const result = evaluateTimeStop(position, market);

    expect(position.time_stop.deadline_ts_ns).toBe(expectedDeadline(profile));
    expect(result.terminal_reason).toBe('time_stop');
    expect(result.position.lifecycle_state).toBe('closed');
    expect(result.position.remaining_quantity).toBe(0);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      action_type: 'TIME_STOP_EXIT',
      reason: 'time_stop:deadline_reached',
      exit_quantity: 2,
      exit_price: 99,
    });
    expect(result.reasons).toEqual(['time_stop:deadline_reached']);
  });

  it('activates trail at the short-side breakeven boundary when unrealizedR is exactly zero', () => {
    const profile = resolveHarnessProfile(TRAIL_STRATEGY_ID);
    const position = openShortPosition(TRAIL_STRATEGY_ID, profile);
    const market = deadlineMarket(position, 100);

    const result = evaluateTimeStop(position, market);

    expect(position.initial_stop_price).toBeGreaterThan(position.entry_price);
    expect(position.time_stop.deadline_ts_ns).toBe(expectedDeadline(profile));
    expect(result.terminal_reason).toBeUndefined();
    expect(result.position.lifecycle_state).toBe('open');
    expect(result.position.remaining_quantity).toBe(2);
    expect(result.position.trailing_stop.active).toBe(true);
    expect(result.position.active_stop_price).toBe(100);
    expect(result.actions).toEqual([{
      action_type: 'ACTIVATE_TRAIL',
      reason: 'time_stop:activated_trail_at_deadline',
      new_stop_price: 100,
    }]);
  });

  it('applies short-side BE-floor and no-widening invariants when activating trail', () => {
    const profile = resolveHarnessProfile(TRAIL_STRATEGY_ID);
    const position = openShortPosition(TRAIL_STRATEGY_ID, profile);
    const favorableMark = 99;
    const rawTrailStop = favorableMark + profile.trailing_stop.distance_ticks * MNQ.tick_size;
    const beFlooredStop = position.entry_price;

    const floorResult = evaluateTimeStop(position, deadlineMarket(position, favorableMark));

    expect(favorableMark).toBeLessThan(position.entry_price);
    expect(rawTrailStop).toBe(101);
    expect(rawTrailStop).toBeGreaterThan(position.entry_price);
    expect(floorResult.position.active_stop_price).toBe(beFlooredStop);
    expect(floorResult.actions[0]).toMatchObject({
      action_type: 'ACTIVATE_TRAIL',
      reason: 'time_stop:activated_trail_at_deadline',
      new_stop_price: beFlooredStop,
    });

    const alreadyTighterPosition: TargetPosition = {
      ...position,
      active_stop_price: 99.5,
    };
    const noWideningResult = evaluateTimeStop(
      alreadyTighterPosition,
      deadlineMarket(alreadyTighterPosition, favorableMark),
    );

    expect(alreadyTighterPosition.active_stop_price).toBeLessThan(beFlooredStop);
    expect(noWideningResult.position.active_stop_price).toBe(99.5);
    expect(noWideningResult.actions[0]).toMatchObject({
      action_type: 'ACTIVATE_TRAIL',
      reason: 'time_stop:activated_trail_at_deadline',
      new_stop_price: 99.5,
    });
  });

  it('falls back to deadline exit for activate_trail when unrealizedR is negative', () => {
    const profile = resolveHarnessProfile(TRAIL_STRATEGY_ID);
    const position = openShortPosition(TRAIL_STRATEGY_ID, profile);
    const market = deadlineMarket(position, 100.75);

    const result = evaluateTimeStop(position, market);

    expect(result.terminal_reason).toBe('time_stop');
    expect(result.position.lifecycle_state).toBe('closed');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      action_type: 'TIME_STOP_EXIT',
      reason: 'time_stop:deadline_reached',
      exit_quantity: 2,
      exit_price: 100.75,
    });
  });
});

function resolveHarnessProfile(strategyId: StrategyId): ManagementProfile {
  return resolveManagementProfile(strategyId, { allow_fallback: false }).profile;
}

function openShortPosition(strategyId: StrategyId, profile: ManagementProfile): TargetPosition {
  const candidate = makeShortCandidate(strategyId);
  const planned = buildTargetPositionFromCandidate({
    candidate,
    profile,
    quantity: 2,
    opened_ts_ns: OPENED_TS_NS,
  });
  return applyInitialFillToTargetPosition(planned, makeEntryFill(candidate));
}

function makeShortCandidate(strategyId: StrategyId): Candidate {
  return {
    candidate_id: makeCandidateId(`candidate-${strategyId}`),
    strategy_id: strategyId,
    setup_type: strategyId,
    setup_family: 'regime_shock_reversion',
    instrument: MNQ,
    feature_snapshot_id: makeFeatureSnapshotId(`feature-${strategyId}`),
    direction: 'short',
    status: 'proposed',
    proposed_ts_ns: OPENED_TS_NS,
    entry_price: 100,
    stop_price: 102,
    risk_points: 2,
    targets: [
      { label: 'pt1', price: 98, quantity_fraction: 0.5 },
      { label: 'pt2', price: 96, quantity_fraction: 0.5 },
    ],
    reward_risk: [
      { label: 'pt1', reward_risk: 1 },
      { label: 'pt2', reward_risk: 2 },
    ],
    confidence: 0.75,
    config: TEST_CONFIG,
    reasons: ['cycle4_deadline_exposure_harness:synthetic_short_candidate'],
  };
}

function makeEntryFill(candidate: Candidate): SimulatedFill {
  return {
    fill_id: makeFillId(`fill-${candidate.strategy_id}`),
    order_intent_id: makeOrderIntentId(`entry-${candidate.strategy_id}`),
    instrument: MNQ,
    side: 'sell',
    quantity: 2,
    price: candidate.entry_price,
    liquidity: 'taker',
    exchange_fee_usd: 0,
    commission_usd: 0,
    slippage_points: 0,
    filled_ts_ns: OPENED_TS_NS,
    config: TEST_CONFIG,
  };
}

function deadlineMarket(position: TargetPosition, markPrice: number): PositionManagerMarketInput {
  if (position.time_stop.deadline_ts_ns === undefined) {
    throw new Error('expected deadline_ts_ns to be constructed by applyInitialFillToTargetPosition');
  }
  return {
    event_ts_ns: position.time_stop.deadline_ts_ns,
    mark_price: markPrice,
  };
}

function expectedDeadline(profile: ManagementProfile): UnixNs {
  return ns(BigInt(OPENED_TS_NS) + BigInt(profile.time_stop.max_hold_minutes) * NS_PER_MINUTE);
}

const TEST_CONFIG = {
  config_hash: makeConfigHash('a'.repeat(64)),
  config_version: 1,
} as const;
