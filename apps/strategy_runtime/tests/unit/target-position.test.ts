import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  makeFillId,
  makeOrderIntentId,
  makePositionId,
  ns,
  type Candidate,
  type SimulatedFill,
  type StrategyId,
} from '../../src/contracts/index.js';
import {
  applyInitialFillToTargetPosition,
  buildTargetPositionFromCandidate,
  computePartialTargetQuantities,
  resolveManagementProfile,
  summarizeTargetPositionForJournal,
  validateTargetPosition,
  type TargetPosition,
} from '../../src/management/index.js';
import { getActiveStrategyGenerator } from '../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

const OPENED_TS_NS = ns('1776957600000000000');
const FILL_TS_NS = ns('1776957601000000000');

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

function cloneCandidate(candidate: Candidate, overrides: Partial<Candidate>): Candidate {
  return {
    ...candidate,
    ...overrides,
  };
}

function buildPosition(strategyId: StrategyId, quantity = 3): TargetPosition {
  const candidate = fixtureCandidate(strategyId);
  const profile = resolveManagementProfile(strategyId).profile;
  return buildTargetPositionFromCandidate({
    candidate,
    profile,
    quantity,
    opened_ts_ns: OPENED_TS_NS,
    position_id: makePositionId(`position-${strategyId}-test`),
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

describe('MGMT-02 target-position model', () => {
  it('builds a valid long target position with side-correct stop, targets, and RR', () => {
    const position = buildPosition('trend_pullback_long', 2);

    expect(validateTargetPosition(position)).toEqual([]);
    expect(position).toMatchObject({
      lifecycle_state: 'planned',
      side: 'long',
      quantity: 2,
      remaining_quantity: 2,
      profile_id: 'trend_pullback_long_management_v1',
      profile_version: 1,
      initial_stop_price: expect.any(Number),
      active_stop_price: expect.any(Number),
    });
    expect(position.initial_stop_price).toBeLessThan(position.entry_price);
    expect(position.targets[0]?.price).toBeGreaterThan(position.entry_price);
    expect(position.targets[1]?.price).toBeGreaterThan(position.targets[0]?.price ?? 0);
    expect(position.risk_points).toBe(position.entry_price - position.initial_stop_price);
    expect(position.targets.map((target) => target.quantity)).toEqual([1, 1]);
  });

  it('builds a valid short target position with side-correct stop, targets, and RR', () => {
    const position = buildPosition('breakdown_retest_short', 2);

    expect(validateTargetPosition(position)).toEqual([]);
    expect(position.side).toBe('short');
    expect(position.initial_stop_price).toBeGreaterThan(position.entry_price);
    expect(position.targets[0]?.price).toBeLessThan(position.entry_price);
    expect(position.targets[1]?.price).toBeLessThan(position.targets[0]?.price ?? 0);
    expect(position.risk_points).toBe(position.initial_stop_price - position.entry_price);
  });

  it('rejects invalid long target order', () => {
    const candidate = fixtureCandidate('trend_pullback_long');
    const profile = resolveManagementProfile(candidate.strategy_id).profile;
    const invalid = cloneCandidate(candidate, {
      targets: [
        { label: 'pt1', price: candidate.entry_price + 10, quantity_fraction: 0.5 },
        { label: 'pt2', price: candidate.entry_price + 9, quantity_fraction: 0.5 },
      ],
    });

    expect(() => buildTargetPositionFromCandidate({
      candidate: invalid,
      profile,
      quantity: 2,
      opened_ts_ns: OPENED_TS_NS,
    })).toThrow('long management targets must be ordered entry < pt1 < pt2');
  });

  it('rejects invalid short target order', () => {
    const candidate = fixtureCandidate('trend_pullback_short');
    const profile = resolveManagementProfile(candidate.strategy_id).profile;
    const invalid = cloneCandidate(candidate, {
      targets: [
        { label: 'pt1', price: candidate.entry_price - 10, quantity_fraction: 0.5 },
        { label: 'pt2', price: candidate.entry_price - 9, quantity_fraction: 0.5 },
      ],
    });

    expect(() => buildTargetPositionFromCandidate({
      candidate: invalid,
      profile,
      quantity: 2,
      opened_ts_ns: OPENED_TS_NS,
    })).toThrow('short management targets must be ordered entry > pt1 > pt2');
  });

  it('computes partial target quantities deterministically', () => {
    const profile = resolveManagementProfile('breakout_retest_long').profile;

    const first = computePartialTargetQuantities({ total_quantity: 3, profile });
    const second = computePartialTargetQuantities({ total_quantity: 3, profile });

    expect(first).toEqual(second);
    expect(first).toEqual([
      { label: 'pt1', quantity: 1, quantity_fraction: 0.5 },
      { label: 'pt2', quantity: 2, quantity_fraction: 0.5 },
    ]);
  });

  it('assigns true 50/50 partial quantities for a two-contract replay position', () => {
    const candidate = fixtureCandidate('breakout_retest_long');
    const profile = resolveManagementProfile(candidate.strategy_id).profile;
    const planned = buildTargetPositionFromCandidate({
      candidate,
      profile,
      quantity: 2,
      opened_ts_ns: OPENED_TS_NS,
    });
    const open = applyInitialFillToTargetPosition(planned, makeFill(candidate, 2));

    expect(open.quantity).toBe(2);
    expect(open.remaining_quantity).toBe(2);
    expect(open.targets.map((target) => ({
      label: target.label,
      quantity: target.quantity,
      quantity_fraction: target.quantity_fraction,
    }))).toEqual([
      { label: 'pt1', quantity: 1, quantity_fraction: 0.5 },
      { label: 'pt2', quantity: 1, quantity_fraction: 0.5 },
    ]);
  });

  it('rejects target quantities that exceed total size', () => {
    const position = buildPosition('trend_pullback_long', 2);
    const invalid = {
      ...position,
      targets: position.targets.map((target) => ({
        ...target,
        quantity: 2,
      })),
    };

    expect(validateTargetPosition(invalid)).toContainEqual({
      path: '$.targets',
      code: 'invalid_quantity',
      message: 'target quantities exceed total quantity',
    });
  });

  it('preserves candidate and fill lineage when applying the initial fill', () => {
    const candidate = fixtureCandidate('breakout_retest_long');
    const profile = resolveManagementProfile(candidate.strategy_id).profile;
    const planned = buildTargetPositionFromCandidate({
      candidate,
      profile,
      quantity: 3,
      opened_ts_ns: OPENED_TS_NS,
    });
    const fill = makeFill(candidate, 3);

    const open = applyInitialFillToTargetPosition(planned, fill);
    const summary = summarizeTargetPositionForJournal(open);

    expect(open).toEqual(applyInitialFillToTargetPosition(planned, fill));
    expect(open).toMatchObject({
      lifecycle_state: 'open',
      position_id: planned.position_id,
      candidate_id: candidate.candidate_id,
      fill_id: fill.fill_id,
      entry_price: fill.price,
      quantity: 3,
      opened_ts_ns: fill.filled_ts_ns,
      updated_ts_ns: fill.filled_ts_ns,
    });
    expect(summary).toMatchObject({
      position_id: planned.position_id,
      candidate_id: candidate.candidate_id,
      fill_id: fill.fill_id,
      profile_id: 'breakout_retest_long_management_v1',
      position_status: 'open',
      realized_pnl_usd: 0,
      unrealized_pnl_usd: 0,
    });
  });

  it('validates profile metadata on target positions', () => {
    const position = buildPosition('trend_pullback_long', 2);
    const invalid = {
      ...position,
      profile_id: '',
      profile_version: 2,
    } as unknown as TargetPosition;

    expect(validateTargetPosition(invalid)).toEqual(
      expect.arrayContaining([
        {
          path: '$.profile_id',
          code: 'invalid_profile_metadata',
          message: 'must be a non-empty string',
        },
        {
          path: '$.profile_version',
          code: 'invalid_profile_metadata',
          message: 'must be 1',
        },
      ]),
    );
  });

  it('keeps active management modules free of deterministic-output hazards', () => {
    const managementDir = join(process.cwd(), 'apps/strategy_runtime/src/management');
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
