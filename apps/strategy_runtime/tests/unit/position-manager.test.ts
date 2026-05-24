import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createJournalEventEnvelope,
  makeCausationId,
  makeEventId,
  makeFillId,
  makeOrderIntentId,
  makePositionId,
  makeRunId,
  makeSessionId,
  ns,
  validateJournalEventEnvelope,
  type Candidate,
  type SimulatedFill,
  type StrategyId,
} from '../../src/contracts/index.js';
import {
  applyInitialFillToTargetPosition,
  buildTargetPositionFromCandidate,
  evaluatePositionManager,
  isBreakEvenTriggerMet,
  resolveManagementProfile,
  type ManagementProfile,
  type PositionManagerMarketInput,
  type TargetPosition,
} from '../../src/management/index.js';
import { getActiveStrategyGenerator } from '../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

const OPENED_TS_NS = ns('1776957600000000000');
const FILL_TS_NS = ns('1776957601000000000');
const NEXT_TS_NS = ns('1776957660000000000');
const LATE_TS_NS = ns('1776961201000000000');

function fixtureCandidate(strategyId: StrategyId): Candidate {
  const result = getActiveStrategyGenerator(strategyId)({
    strategy_id: strategyId,
    snapshot: STRATEGY_SYNTHETIC_FIXTURES[strategyId].snapshot,
  });
  if (result.candidate === undefined) {
    throw new Error(`expected ${strategyId} fixture candidate`);
  }
  return result.candidate;
}

function cloneProfile(
  profile: ManagementProfile,
  overrides: Partial<ManagementProfile>,
): ManagementProfile {
  return {
    ...profile,
    ...overrides,
  };
}

function profileWithoutTrailing(strategyId: StrategyId): ManagementProfile {
  const profile = resolveManagementProfile(strategyId).profile;
  return cloneProfile(profile, {
    trailing_stop: {
      enabled: false,
      mode: 'disabled',
      activation: 'after_pt1',
      distance_ticks: 0,
      action: 'ACTIVATE_TRAIL',
    },
  });
}

function makeFill(candidate: Candidate, quantity = 3): SimulatedFill {
  return {
    fill_id: makeFillId(`fill-${candidate.candidate_id}`),
    order_intent_id: makeOrderIntentId(`order-${candidate.candidate_id}`),
    instrument: candidate.instrument,
    side: candidate.direction === 'long' ? 'buy' : 'sell',
    quantity,
    price: candidate.entry_price,
    liquidity: 'taker',
    exchange_fee_usd: 1.05,
    commission_usd: 1.2,
    slippage_points: 0,
    filled_ts_ns: FILL_TS_NS,
    config: candidate.config,
  };
}

function openPosition(strategyId: StrategyId, profile = resolveManagementProfile(strategyId).profile) {
  const candidate = fixtureCandidate(strategyId);
  const planned = buildTargetPositionFromCandidate({
    candidate,
    profile,
    quantity: 3,
    opened_ts_ns: OPENED_TS_NS,
    position_id: makePositionId(`position-${strategyId}`),
  });
  return {
    candidate,
    profile,
    position: applyInitialFillToTargetPosition(planned, makeFill(candidate, 3)),
  };
}

function market(
  position: TargetPosition,
  overrides: Partial<PositionManagerMarketInput> = {},
): PositionManagerMarketInput {
  const markPrice = overrides.mark_price ?? position.entry_price;
  const tickSize = typeof position.instrument.tick_size === 'number' && position.instrument.tick_size > 0
    ? position.instrument.tick_size
    : 0.25;
  return {
    event_ts_ns: NEXT_TS_NS,
    mark_price: markPrice,
    high_price: position.entry_price,
    low_price: position.entry_price,
    bid_px: markPrice - tickSize,
    ask_px: markPrice + tickSize,
    authority: 'authoritative',
    ...overrides,
  };
}

function withFailSafe(
  position: TargetPosition,
  overrides: Partial<TargetPosition['fail_safe']>,
): TargetPosition {
  return {
    ...position,
    fail_safe: {
      ...position.fail_safe,
      ...overrides,
    },
  };
}

function withPt1Touched(position: TargetPosition): TargetPosition {
  return {
    ...position,
    pt1_touched: true,
  };
}

function withoutBidPx(input: PositionManagerMarketInput): PositionManagerMarketInput {
  const { bid_px: _bidPx, ...withoutBid } = input;
  return withoutBid;
}

function markAtUnrealizedR(position: TargetPosition, unrealizedR: number): number {
  return position.side === 'long'
    ? position.entry_price + (unrealizedR * position.risk_points)
    : position.entry_price - (unrealizedR * position.risk_points);
}

function target(position: TargetPosition, label: 'pt1' | 'pt2' | 'runner') {
  const found = position.targets.find((item) => item.label === label);
  if (found === undefined) {
    throw new Error(`missing ${label}`);
  }
  return found;
}

describe('MGMT-03 position-manager FSM', () => {
  it('manages a long position through PT1 then PT2 without duplicate target fills', () => {
    const { profile, position } = openPosition('trend_pullback_long', profileWithoutTrailing('trend_pullback_long'));
    const pt1 = position.targets.find((target) => target.label === 'pt1');
    const pt2 = position.targets.find((target) => target.label === 'pt2');
    if (pt1 === undefined || pt2 === undefined) throw new Error('missing test targets');

    const afterPt1 = evaluatePositionManager({
      position,
      profile,
      market: market(position, {
        mark_price: pt1.price,
        high_price: pt1.price,
        low_price: position.entry_price,
      }),
    });

    expect(afterPt1.fsm_state).toBe('BREAKEVEN_ARMED');
    expect(afterPt1.updated_position.remaining_quantity).toBe(2);
    expect(afterPt1.actions.map((action) => action.action_type)).toEqual([
      'TAKE_PARTIAL',
      'MARK_BREAKEVEN',
    ]);

    const duplicatePt1 = evaluatePositionManager({
      position: afterPt1.updated_position,
      profile,
      market: market(afterPt1.updated_position, {
        mark_price: pt1.price,
        high_price: pt1.price,
        low_price: afterPt1.updated_position.active_stop_price + 1,
      }),
    });

    expect(duplicatePt1.actions.map((action) => action.action_type)).toEqual([]);
    expect(duplicatePt1.updated_position.remaining_quantity).toBe(2);

    const afterPt2 = evaluatePositionManager({
      position: afterPt1.updated_position,
      profile,
      market: market(afterPt1.updated_position, {
        mark_price: pt2.price,
        high_price: pt2.price,
        low_price: afterPt1.updated_position.active_stop_price + 1,
      }),
    });

    expect(afterPt2.fsm_state).toBe('EXITED');
    expect(afterPt2.updated_position.remaining_quantity).toBe(0);
    expect(afterPt2.actions.map((action) => action.action_type)).toEqual(['TAKE_PROFIT']);
  });

  it('manages a short position through PT1 then PT2', () => {
    const { profile, position } = openPosition('trend_pullback_short', profileWithoutTrailing('trend_pullback_short'));
    const pt1 = position.targets.find((target) => target.label === 'pt1');
    const pt2 = position.targets.find((target) => target.label === 'pt2');
    if (pt1 === undefined || pt2 === undefined) throw new Error('missing test targets');

    const afterPt1 = evaluatePositionManager({
      position,
      profile,
      market: market(position, {
        mark_price: pt1.price,
        high_price: position.entry_price,
        low_price: pt1.price,
      }),
    });
    const afterPt2 = evaluatePositionManager({
      position: afterPt1.updated_position,
      profile,
      market: market(afterPt1.updated_position, {
        mark_price: pt2.price,
        high_price: afterPt1.updated_position.active_stop_price - 1,
        low_price: pt2.price,
      }),
    });

    expect(afterPt1.actions.map((action) => action.action_type)).toEqual([
      'TAKE_PARTIAL',
      'MARK_BREAKEVEN',
    ]);
    expect(afterPt2.fsm_state).toBe('EXITED');
    expect(afterPt2.actions.map((action) => action.action_type)).toEqual(['TAKE_PROFIT']);
  });

  it('exits a long position when the stop is hit', () => {
    const { profile, position } = openPosition('trend_pullback_long');
    const stopPosition = withFailSafe(position, { enabled: false });
    const result = evaluatePositionManager({
      position: stopPosition,
      profile,
      market: market(stopPosition, {
        mark_price: stopPosition.active_stop_price,
        high_price: stopPosition.entry_price,
        low_price: stopPosition.active_stop_price,
      }),
    });

    expect(result.fsm_state).toBe('EXITED');
    expect(result.updated_position.remaining_quantity).toBe(0);
    expect(result.actions).toMatchObject([
      {
        action_type: 'EXIT_FULL',
        reason: 'stop:hit',
        exit_quantity: 3,
        exit_price: stopPosition.active_stop_price,
      },
    ]);
  });

  it('exits a short position when the stop is hit', () => {
    const { profile, position } = openPosition('trend_pullback_short');
    const stopPosition = withFailSafe(position, { enabled: false });
    const result = evaluatePositionManager({
      position: stopPosition,
      profile,
      market: market(stopPosition, {
        mark_price: stopPosition.active_stop_price,
        high_price: stopPosition.active_stop_price,
        low_price: stopPosition.entry_price,
      }),
    });

    expect(result.fsm_state).toBe('EXITED');
    expect(result.updated_position.remaining_quantity).toBe(0);
    expect(result.actions[0]?.action_type).toBe('EXIT_FULL');
  });

  it('combined-bar stop+PT1 sets pt1_touched flag through terminal stop for short positions', () => {
    const { profile, position } = openPosition('trend_pullback_short', profileWithoutTrailing('trend_pullback_short'));
    const stopPosition = withFailSafe(position, { enabled: false });
    const pt1 = target(stopPosition, 'pt1');
    const combinedBar = market(stopPosition, {
      mark_price: stopPosition.active_stop_price,
      high_price: stopPosition.active_stop_price,
      low_price: pt1.price,
    });

    const result = evaluatePositionManager({
      position: stopPosition,
      profile,
      market: combinedBar,
    });

    expect(result.updated_position.pt1_touched).toBe(true);
    expect(isBreakEvenTriggerMet(result.updated_position, combinedBar)).toBe(true);
    expect(result.updated_position.targets.find((item) => item.label === 'pt1')).toMatchObject({
      status: 'cancelled',
      filled_quantity: 0,
    });
    expect(result.fsm_state).toBe('EXITED');
    expect(result.actions.map((action) => action.action_type)).toEqual(['EXIT_FULL']);
    expect(result.actions[0]).toMatchObject({
      reason: 'stop:hit',
      exit_price: stopPosition.active_stop_price,
    });
  });

  it('combined-bar stop+PT1 still records stop fill rather than PT1 fill', () => {
    const { profile, position } = openPosition('trend_pullback_short', profileWithoutTrailing('trend_pullback_short'));
    const stopPosition = withFailSafe(position, { enabled: false });
    const pt1 = target(stopPosition, 'pt1');
    const result = evaluatePositionManager({
      position: stopPosition,
      profile,
      market: market(stopPosition, {
        mark_price: stopPosition.active_stop_price,
        high_price: stopPosition.active_stop_price,
        low_price: pt1.price,
      }),
    });

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      action_type: 'EXIT_FULL',
      reason: 'stop:hit',
      exit_quantity: stopPosition.remaining_quantity,
      exit_price: stopPosition.active_stop_price,
    });
    expect(result.actions.map((action) => action.target_label)).toEqual([undefined]);
    expect(result.updated_position.targets.find((item) => item.label === 'pt1')).toMatchObject({
      status: 'cancelled',
      filled_quantity: 0,
    });
  });

  it('non-combined-bar PT1 then next-bar stop arms break-even before the stop', () => {
    const { profile, position } = openPosition('trend_pullback_short', profileWithoutTrailing('trend_pullback_short'));
    const pt1 = target(position, 'pt1');
    const afterPt1 = evaluatePositionManager({
      position,
      profile,
      market: market(position, {
        mark_price: pt1.price,
        high_price: position.entry_price,
        low_price: pt1.price,
      }),
    });

    expect(afterPt1.updated_position.pt1_touched).toBe(true);
    expect(afterPt1.updated_position.break_even.moved).toBe(true);
    expect(afterPt1.actions.map((action) => action.action_type)).toEqual([
      'TAKE_PARTIAL',
      'MARK_BREAKEVEN',
    ]);
    expect(afterPt1.management_action_payloads.map((payload) => payload.action_type)).toContain('MARK_BREAKEVEN');

    const breakEvenStop = afterPt1.updated_position.active_stop_price;
    const afterStop = evaluatePositionManager({
      position: afterPt1.updated_position,
      profile,
      market: market(afterPt1.updated_position, {
        mark_price: breakEvenStop,
        high_price: breakEvenStop,
        low_price: breakEvenStop,
      }),
    });

    expect(afterStop.fsm_state).toBe('EXITED');
    expect(afterStop.actions[0]).toMatchObject({
      action_type: 'EXIT_FULL',
      reason: 'stop:hit',
      exit_price: breakEvenStop,
    });
  });

  it('non-combined-bar stop-only does not set pt1_touched', () => {
    const { profile, position } = openPosition('trend_pullback_short', profileWithoutTrailing('trend_pullback_short'));
    const stopPosition = withFailSafe(position, { enabled: false });
    const stopOnlyBar = market(stopPosition, {
      mark_price: stopPosition.active_stop_price,
      high_price: stopPosition.active_stop_price,
      low_price: stopPosition.entry_price,
    });

    const result = evaluatePositionManager({
      position: stopPosition,
      profile,
      market: stopOnlyBar,
    });

    expect(result.updated_position.pt1_touched).toBe(false);
    expect(isBreakEvenTriggerMet(result.updated_position, stopOnlyBar)).toBe(false);
    expect(result.actions.map((action) => action.action_type)).toEqual(['EXIT_FULL']);
  });

  it('combined-bar stop+PT1 sets pt1_touched flag through terminal stop for long positions', () => {
    const { profile, position } = openPosition('trend_pullback_long', profileWithoutTrailing('trend_pullback_long'));
    const stopPosition = withFailSafe(position, { enabled: false });
    const pt1 = target(stopPosition, 'pt1');
    const combinedBar = market(stopPosition, {
      mark_price: stopPosition.active_stop_price,
      high_price: pt1.price,
      low_price: stopPosition.active_stop_price,
    });

    const result = evaluatePositionManager({
      position: stopPosition,
      profile,
      market: combinedBar,
    });

    expect(result.updated_position.pt1_touched).toBe(true);
    expect(isBreakEvenTriggerMet(result.updated_position, combinedBar)).toBe(true);
    expect(result.updated_position.targets.find((item) => item.label === 'pt1')).toMatchObject({
      status: 'cancelled',
      filled_quantity: 0,
    });
    expect(result.fsm_state).toBe('EXITED');
    expect(result.actions).toMatchObject([{
      action_type: 'EXIT_FULL',
      reason: 'stop:hit',
      exit_price: stopPosition.active_stop_price,
    }]);
  });

  it('moves the stop to breakeven after the configured trigger', () => {
    const { profile, position } = openPosition('breakout_retest_long', profileWithoutTrailing('breakout_retest_long'));
    const pt1 = position.targets.find((target) => target.label === 'pt1');
    if (pt1 === undefined) throw new Error('missing pt1');

    const result = evaluatePositionManager({
      position,
      profile,
      market: market(position, {
        mark_price: pt1.price,
        high_price: pt1.price,
        low_price: position.entry_price,
      }),
    });

    expect(result.fsm_state).toBe('BREAKEVEN_ARMED');
    expect(result.updated_position.break_even.moved).toBe(true);
    expect(result.updated_position.active_stop_price).toBeGreaterThanOrEqual(position.entry_price);
    expect(result.actions.map((action) => action.action_type)).toContain('MARK_BREAKEVEN');
  });

  it('ratchets a long trailing stop upward only', () => {
    const { profile, position } = openPosition('trend_pullback_long');
    const pt1 = position.targets.find((target) => target.label === 'pt1');
    if (pt1 === undefined) throw new Error('missing pt1');

    const activated = evaluatePositionManager({
      position,
      profile,
      market: market(position, {
        mark_price: pt1.price,
        high_price: pt1.price,
        low_price: position.entry_price,
      }),
    });
    const activeStop = activated.updated_position.active_stop_price;
    const lowerHigh = evaluatePositionManager({
      position: activated.updated_position,
      profile,
      market: market(activated.updated_position, {
        mark_price: pt1.price - 1,
        high_price: pt1.price - 1,
        low_price: activeStop + 1,
      }),
    });
    const higherHigh = evaluatePositionManager({
      position: lowerHigh.updated_position,
      profile,
      market: market(lowerHigh.updated_position, {
        mark_price: pt1.price + 6,
        high_price: pt1.price + 6,
        low_price: activeStop + 1,
      }),
    });

    expect(activated.actions.map((action) => action.action_type)).toContain('ACTIVATE_TRAIL');
    expect(lowerHigh.updated_position.active_stop_price).toBe(activeStop);
    expect(higherHigh.updated_position.active_stop_price).toBeGreaterThan(activeStop);
    expect(higherHigh.actions.map((action) => action.action_type)).toContain('MOVE_STOP');
  });

  it('ratchets a short trailing stop downward only', () => {
    const { profile, position } = openPosition('trend_pullback_short');
    const pt1 = position.targets.find((target) => target.label === 'pt1');
    if (pt1 === undefined) throw new Error('missing pt1');

    const activated = evaluatePositionManager({
      position,
      profile,
      market: market(position, {
        mark_price: pt1.price,
        high_price: position.entry_price,
        low_price: pt1.price,
      }),
    });
    const activeStop = activated.updated_position.active_stop_price;
    const higherLow = evaluatePositionManager({
      position: activated.updated_position,
      profile,
      market: market(activated.updated_position, {
        mark_price: pt1.price + 1,
        high_price: activeStop - 1,
        low_price: pt1.price + 1,
      }),
    });
    const lowerLow = evaluatePositionManager({
      position: higherLow.updated_position,
      profile,
      market: market(higherLow.updated_position, {
        mark_price: pt1.price - 6,
        high_price: activeStop - 1,
        low_price: pt1.price - 6,
      }),
    });

    expect(activated.actions.map((action) => action.action_type)).toContain('ACTIVATE_TRAIL');
    expect(higherLow.updated_position.active_stop_price).toBe(activeStop);
    expect(lowerLow.updated_position.active_stop_price).toBeLessThan(activeStop);
    expect(lowerLow.actions.map((action) => action.action_type)).toContain('MOVE_STOP');
  });

  it('exits on time stop when unrealized R is below the pre-PT1 floor', () => {
    const { profile, position } = openPosition('breakout_retest_long');
    const exitPrice = markAtUnrealizedR(position, -0.3);
    const result = evaluatePositionManager({
      position,
      profile,
      market: market(position, {
        event_ts_ns: position.time_stop.deadline_ts_ns ?? LATE_TS_NS,
        mark_price: exitPrice,
        high_price: position.entry_price,
        low_price: exitPrice,
      }),
    });

    expect(result.fsm_state).toBe('TIME_STOP_EXIT');
    expect(result.actions).toMatchObject([
      {
        action_type: 'TIME_STOP_EXIT',
        reason: 'time_stop:deadline_reached',
      },
    ]);
  });

  it('MGMT-BUG-FIX-02 T1 exits long positions when max adverse R is exceeded', () => {
    const { profile, position } = openPosition('trend_pullback_long');
    const exitPrice = markAtUnrealizedR(position, -1.01);
    const result = evaluatePositionManager({
      position,
      profile,
      market: market(position, {
        mark_price: exitPrice,
        high_price: position.entry_price,
        low_price: exitPrice,
      }),
    });

    expect(result.fsm_state).toBe('FAILED_SAFE_EXIT');
    expect(result.actions).toMatchObject([{
      action_type: 'FAIL_SAFE_EXIT',
      reason: 'fail_safe:max_adverse_r_exceeded',
    }]);
  });

  it('MGMT-BUG-FIX-02 T2 exits short positions when max adverse R is exceeded', () => {
    const { profile, position } = openPosition('trend_pullback_short');
    const exitPrice = markAtUnrealizedR(position, -1.01);
    const result = evaluatePositionManager({
      position,
      profile,
      market: market(position, {
        mark_price: exitPrice,
        high_price: exitPrice,
        low_price: position.entry_price,
      }),
    });

    expect(result.fsm_state).toBe('FAILED_SAFE_EXIT');
    expect(result.actions).toMatchObject([{
      action_type: 'FAIL_SAFE_EXIT',
      reason: 'fail_safe:max_adverse_r_exceeded',
    }]);
  });

  it('MGMT-BUG-FIX-02 T3 holds long positions below the adverse-R boundary', () => {
    const { profile, position } = openPosition('trend_pullback_long');
    const markPrice = markAtUnrealizedR(position, -0.99);
    const result = evaluatePositionManager({
      position,
      profile,
      market: market(position, {
        mark_price: markPrice,
        high_price: position.entry_price,
        low_price: markPrice,
      }),
    });

    expect(result.actions.map((action) => action.action_type)).not.toContain('FAIL_SAFE_EXIT');
    expect(result.reasons).not.toContain('fail_safe:max_adverse_r_exceeded');
  });

  it('MGMT-BUG-FIX-02 T4 does not fail safe when spread equals the threshold', () => {
    const { profile, position } = openPosition('trend_pullback_long');
    const tick = position.instrument.tick_size;
    const result = evaluatePositionManager({
      position,
      profile,
      market: market(position, {
        bid_px: position.entry_price - (tick * 4),
        ask_px: position.entry_price + (tick * 4),
      }),
    });

    expect(result.actions.map((action) => action.action_type)).not.toContain('FAIL_SAFE_EXIT');
    expect(result.reasons).not.toContain('fail_safe:max_spread_ticks_exceeded');
  });

  it('MGMT-BUG-FIX-02 T5 fails safe when spread exceeds the threshold', () => {
    const { profile, position } = openPosition('trend_pullback_long');
    const tick = position.instrument.tick_size;
    const result = evaluatePositionManager({
      position,
      profile,
      market: market(position, {
        bid_px: position.entry_price - (tick * 5),
        ask_px: position.entry_price + (tick * 4),
      }),
    });

    expect(result.fsm_state).toBe('FAILED_SAFE_EXIT');
    expect(result.actions).toMatchObject([{
      action_type: 'FAIL_SAFE_EXIT',
      reason: 'fail_safe:max_spread_ticks_exceeded',
    }]);
  });

  it('MGMT-BUG-FIX-02 T6 exits pre-PT1 positions below the time-stop floor', () => {
    const { profile, position } = openPosition('trend_pullback_long');
    const exitPrice = markAtUnrealizedR(position, -0.3);
    const result = evaluatePositionManager({
      position,
      profile,
      market: market(position, {
        event_ts_ns: position.time_stop.deadline_ts_ns ?? LATE_TS_NS,
        mark_price: exitPrice,
        high_price: position.entry_price,
        low_price: exitPrice,
      }),
    });

    expect(result.fsm_state).toBe('TIME_STOP_EXIT');
    expect(result.actions).toMatchObject([{
      action_type: 'TIME_STOP_EXIT',
      reason: 'time_stop:deadline_reached',
    }]);
  });

  it('MGMT-BUG-FIX-02 T7 holds pre-PT1 positions at the time-stop floor', () => {
    const { profile, position } = openPosition('trend_pullback_long');
    const result = evaluatePositionManager({
      position,
      profile,
      market: market(position, {
        event_ts_ns: position.time_stop.deadline_ts_ns ?? LATE_TS_NS,
        mark_price: position.entry_price,
        high_price: position.entry_price,
        low_price: position.entry_price,
      }),
    });

    expect(result.actions).toEqual([]);
    expect(result.reasons).toContain('time_stop:held_past_deadline_pre_pt1');
  });

  it('MGMT-BUG-FIX-02 T8 exits post-PT1 positions below breakeven at deadline', () => {
    const { profile, position } = openPosition('trend_pullback_long');
    const pt1Position = withPt1Touched(position);
    const exitPrice = markAtUnrealizedR(pt1Position, -0.01);
    const result = evaluatePositionManager({
      position: pt1Position,
      profile,
      market: market(pt1Position, {
        event_ts_ns: pt1Position.time_stop.deadline_ts_ns ?? LATE_TS_NS,
        mark_price: exitPrice,
        high_price: pt1Position.entry_price,
        low_price: exitPrice,
      }),
    });

    expect(result.fsm_state).toBe('TIME_STOP_EXIT');
    expect(result.actions).toMatchObject([{
      action_type: 'TIME_STOP_EXIT',
      reason: 'time_stop:deadline_reached',
    }]);
  });

  it('MGMT-BUG-FIX-02 T9a fails closed when live-authoritative spread inputs are incomplete', () => {
    const { profile, position } = openPosition('trend_pullback_long');
    const tick = position.instrument.tick_size;
    const result = evaluatePositionManager({
      position,
      profile,
      market: withoutBidPx(market(position, {
        ask_px: position.entry_price + tick,
        authority: 'authoritative',
      })),
    });

    expect(result.fsm_state).toBe('FAILED_SAFE_EXIT');
    expect(result.actions).toMatchObject([{
      action_type: 'FAIL_SAFE_EXIT',
      reason: 'fail_safe:spread_unavailable_in_live_authoritative',
    }]);
  });

  it('MGMT-BUG-FIX-02 T9b skips incomplete synthetic spread inputs outside authoritative mode', () => {
    const { profile, position } = openPosition('trend_pullback_long');
    const tick = position.instrument.tick_size;
    const result = evaluatePositionManager({
      position,
      profile,
      market: withoutBidPx(market(position, {
        ask_px: position.entry_price + tick,
        authority: 'warming',
      })),
    });

    expect(result.actions.map((action) => action.action_type)).not.toContain('FAIL_SAFE_EXIT');
    expect(result.reasons).not.toContain('fail_safe:spread_unavailable_in_live_authoritative');
  });

  it('MGMT-BUG-FIX-02 T9c preserves stale-market precedence over spread checks', () => {
    const { profile, position } = openPosition('trend_pullback_long');
    const tick = position.instrument.tick_size;
    const result = evaluatePositionManager({
      position,
      profile,
      market: withoutBidPx(market(position, {
        ask_px: position.entry_price + tick,
        authority: 'stale',
      })),
    });

    expect(result.fsm_state).toBe('FAILED_SAFE_EXIT');
    expect(result.actions).toMatchObject([{
      action_type: 'FAIL_SAFE_EXIT',
      reason: 'fail_safe:stale_market',
    }]);
  });

  it('MGMT-BUG-FIX-02 T10 skips adverse-R checks when position fail-safe is disabled', () => {
    const { profile, position } = openPosition('trend_pullback_long');
    const disabled = withFailSafe(position, { enabled: false });
    const exitPrice = markAtUnrealizedR(disabled, -1.01);
    const result = evaluatePositionManager({
      position: disabled,
      profile,
      market: market(disabled, {
        mark_price: exitPrice,
        high_price: disabled.entry_price,
        low_price: disabled.entry_price,
      }),
    });

    expect(result.actions.map((action) => action.action_type)).not.toContain('FAIL_SAFE_EXIT');
    expect(result.reasons).not.toContain('fail_safe:max_adverse_r_exceeded');
  });

  it('MGMT-BUG-FIX-02 T10b skips spread checks when position fail-safe is disabled', () => {
    const { profile, position } = openPosition('trend_pullback_long');
    const disabled = withFailSafe(position, { enabled: false });
    const tick = disabled.instrument.tick_size;
    const result = evaluatePositionManager({
      position: disabled,
      profile,
      market: market(disabled, {
        bid_px: disabled.entry_price - (tick * 5),
        ask_px: disabled.entry_price + (tick * 4),
      }),
    });

    expect(result.actions.map((action) => action.action_type)).not.toContain('FAIL_SAFE_EXIT');
    expect(result.reasons).not.toContain('fail_safe:max_spread_ticks_exceeded');
  });

  it('MGMT-BUG-FIX-02 T10c keeps structural checks active when position fail-safe is disabled', () => {
    const { position } = openPosition('trend_pullback_long');
    const disabled = withFailSafe(position, { enabled: false });
    const mismatchedProfile = resolveManagementProfile('trend_pullback_short').profile;
    const result = evaluatePositionManager({
      position: disabled,
      profile: mismatchedProfile,
      market: market(disabled),
    });

    expect(result.fsm_state).toBe('FAILED_SAFE_EXIT');
    expect(result.actions).toMatchObject([{
      action_type: 'FAIL_SAFE_EXIT',
      reason: 'fail_safe:profile_mismatch',
    }]);
  });

  it('MGMT-BUG-FIX-02 T11 exits long positions at the exact adverse-R boundary', () => {
    const { profile, position } = openPosition('trend_pullback_long');
    const exitPrice = markAtUnrealizedR(position, -1);
    const result = evaluatePositionManager({
      position,
      profile,
      market: market(position, {
        mark_price: exitPrice,
        high_price: position.entry_price,
        low_price: exitPrice,
      }),
    });

    expect(result.fsm_state).toBe('FAILED_SAFE_EXIT');
    expect(result.actions).toMatchObject([{
      action_type: 'FAIL_SAFE_EXIT',
      reason: 'fail_safe:max_adverse_r_exceeded',
    }]);
  });

  it('MGMT-BUG-FIX-02 T12 holds post-PT1 positions at breakeven on the deadline', () => {
    const { profile, position } = openPosition('trend_pullback_long');
    const pt1Position = withPt1Touched(position);
    const result = evaluatePositionManager({
      position: pt1Position,
      profile,
      market: market(pt1Position, {
        event_ts_ns: pt1Position.time_stop.deadline_ts_ns ?? LATE_TS_NS,
        mark_price: pt1Position.entry_price,
        high_price: pt1Position.entry_price,
        low_price: pt1Position.entry_price,
      }),
    });

    expect(result.actions.map((action) => action.action_type)).not.toContain('TIME_STOP_EXIT');
    expect(result.actions.map((action) => action.action_type)).not.toContain('EXIT_FULL');
    expect(result.reasons).toContain('time_stop:held_past_deadline_post_pt1');
  });

  it('MGMT-BUG-FIX-02 T13 applies time-stop unrealized R symmetrically for shorts', () => {
    const { profile, position } = openPosition('trend_pullback_short');
    const exitPrice = markAtUnrealizedR(position, -0.3);
    const result = evaluatePositionManager({
      position,
      profile,
      market: market(position, {
        event_ts_ns: position.time_stop.deadline_ts_ns ?? LATE_TS_NS,
        mark_price: exitPrice,
        high_price: exitPrice,
        low_price: position.entry_price,
      }),
    });

    expect(result.fsm_state).toBe('TIME_STOP_EXIT');
    expect(result.actions).toMatchObject([{
      action_type: 'TIME_STOP_EXIT',
      reason: 'time_stop:deadline_reached',
    }]);
  });

  it('MGMT-BUG-FIX-02 T14 fails closed for inverted live-authoritative quotes', () => {
    const { profile, position } = openPosition('trend_pullback_long');
    const tick = position.instrument.tick_size;
    const result = evaluatePositionManager({
      position,
      profile,
      market: market(position, {
        bid_px: position.entry_price + tick,
        ask_px: position.entry_price,
      }),
    });

    expect(result.fsm_state).toBe('FAILED_SAFE_EXIT');
    expect(result.actions).toMatchObject([{
      action_type: 'FAIL_SAFE_EXIT',
      reason: 'fail_safe:spread_unavailable_in_live_authoritative',
    }]);
  });

  it('fails safe for stale market input', () => {
    const { profile, position } = openPosition('trend_pullback_long');
    const result = evaluatePositionManager({
      position,
      profile,
      market: market(position, {
        is_stale: true,
      }),
    });

    expect(result.fsm_state).toBe('FAILED_SAFE_EXIT');
    expect(result.actions).toMatchObject([
      {
        action_type: 'FAIL_SAFE_EXIT',
        reason: 'fail_safe:stale_market',
      },
    ]);
  });

  it('produces stable action order and byte-equivalent output across repeated runs', () => {
    const { profile, position } = openPosition('trend_pullback_long');
    const pt1 = position.targets.find((target) => target.label === 'pt1');
    if (pt1 === undefined) throw new Error('missing pt1');
    const input = {
      position,
      profile,
      market: market(position, {
        mark_price: pt1.price,
        high_price: pt1.price,
        low_price: position.entry_price,
      }),
    };

    const first = evaluatePositionManager(input);
    const second = evaluatePositionManager(input);

    expect(first).toEqual(second);
    expect(first.actions.map((action) => action.action_type)).toEqual([
      'TAKE_PARTIAL',
      'MARK_BREAKEVEN',
      'ACTIVATE_TRAIL',
    ]);
    expect(deterministicStringify(first)).toBe(deterministicStringify(second));
  });

  it('returns OBS-01-valid journal payload summaries for position management outputs', () => {
    const { profile, position } = openPosition('breakout_retest_long', profileWithoutTrailing('breakout_retest_long'));
    const pt1 = position.targets.find((target) => target.label === 'pt1');
    if (pt1 === undefined) throw new Error('missing pt1');
    const result = evaluatePositionManager({
      position,
      profile,
      market: market(position, {
        mark_price: pt1.price,
        high_price: pt1.price,
        low_price: position.entry_price,
      }),
    });

    const positionEvent = createJournalEventEnvelope({
      event_id: makeEventId('position-manager-position-payload'),
      type: 'POSITION',
      ts_ns: NEXT_TS_NS,
      run_id: makeRunId('run-mgmt-03'),
      session_id: makeSessionId('2026-04-23-rth'),
      causation_id: makeCausationId('sim-fill-1'),
      payload: result.position_event_payload,
    });
    const tickEvent = createJournalEventEnvelope({
      event_id: makeEventId('position-manager-tick-payload'),
      type: 'MGMT_TICK',
      ts_ns: NEXT_TS_NS,
      run_id: makeRunId('run-mgmt-03'),
      session_id: makeSessionId('2026-04-23-rth'),
      causation_id: makeCausationId(positionEvent.event_id),
      payload: result.management_tick_payload,
    });
    const actionEvent = createJournalEventEnvelope({
      event_id: makeEventId('position-manager-action-payload'),
      type: 'MGMT_ACTION',
      ts_ns: NEXT_TS_NS,
      run_id: makeRunId('run-mgmt-03'),
      session_id: makeSessionId('2026-04-23-rth'),
      causation_id: makeCausationId(tickEvent.event_id),
      payload: result.management_action_payloads[0],
    });

    expect(validateJournalEventEnvelope(positionEvent)).toMatchObject({ ok: true, issues: [] });
    expect(validateJournalEventEnvelope(tickEvent)).toMatchObject({ ok: true, issues: [] });
    expect(validateJournalEventEnvelope(actionEvent)).toMatchObject({ ok: true, issues: [] });
    expect(result.management_action_payloads[0]).toMatchObject({
      action_type: 'TAKE_PARTIAL',
      target_label: 'pt1',
      exit_quantity: 1,
      exit_price: pt1.price,
    });
  });

  it('keeps active position-manager modules free of deterministic-output hazards', () => {
    const managementDir = join(process.cwd(), 'apps/strategy_runtime/src/management/position-manager');
    const patterns = [
      'Date.now',
      'new Date(',
      'Math.random',
      'toLocaleString',
      'localeCompare',
    ];

    for (const file of readdirSync(managementDir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(managementDir, file), 'utf8');
      for (const pattern of patterns) {
        expect(source, `${file} must not contain ${pattern}`).not.toContain(pattern);
      }
    }
  });
});

function deterministicStringify(value: unknown): string {
  if (typeof value === 'bigint') {
    return JSON.stringify(value.toString());
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }
  if (value === undefined) {
    return '';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => deterministicStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${deterministicStringify(record[key])}`)
    .join(',')}}`;
}
