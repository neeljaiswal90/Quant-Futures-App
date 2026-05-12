import { describe, expect, it } from 'vitest';
import {
  BREAKOUT_RETEST_LONG_DEFAULTS,
  generateBreakoutRetestLong,
  getActiveStrategyGenerator,
  listExecutableStrategyIds,
  type StrategyFeatureSnapshot,
  type StrategyScalarMap,
} from '../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

const FIXTURE = STRATEGY_SYNTHETIC_FIXTURES.breakout_retest_long;

function withIndicators(overrides: StrategyScalarMap): StrategyFeatureSnapshot {
  return {
    ...FIXTURE.snapshot,
    indicators: {
      ...FIXTURE.snapshot.indicators,
      ...overrides,
    },
  };
}

function withStructure(overrides: StrategyScalarMap): StrategyFeatureSnapshot {
  return {
    ...FIXTURE.snapshot,
    structure: {
      ...FIXTURE.snapshot.structure,
      values: {
        ...FIXTURE.snapshot.structure.values,
        ...overrides,
      },
    },
  };
}

function withSnapshot(overrides: Partial<StrategyFeatureSnapshot>): StrategyFeatureSnapshot {
  return {
    ...FIXTURE.snapshot,
    ...overrides,
  };
}

describe('STRAT-04 breakout_retest_long extraction', () => {
  it('emits a deterministic bullish breakout retest candidate from the STRAT-00 fixture', () => {
    const result = generateBreakoutRetestLong({
      strategy_id: 'breakout_retest_long',
      snapshot: FIXTURE.snapshot,
    });

    expect(result.evaluation).toMatchObject({
      strategy_id: 'breakout_retest_long',
      feature_snapshot_id: FIXTURE.fixture_id,
      gate_state: 'armed',
      evaluated_ts_ns: FIXTURE.snapshot.created_ts_ns,
      config: FIXTURE.snapshot.config,
    });
    expect(result.candidate).toMatchObject({
      candidate_id: `candidate-${FIXTURE.fixture_id}-breakout_retest_long`,
      strategy_id: 'breakout_retest_long',
      setup_type: 'breakout_retest_long',
      setup_family: 'breakout_retest',
      feature_snapshot_id: FIXTURE.fixture_id,
      direction: 'long',
      status: 'proposed',
      proposed_ts_ns: FIXTURE.snapshot.created_ts_ns,
      config: FIXTURE.snapshot.config,
    });
    expect(result.candidate?.entry_price).toBe(18620.5);
    expect(result.candidate?.stop_price).toBe(18605);
    expect(result.candidate?.risk_points).toBe(15.6025);
    expect(result.candidate?.targets).toEqual([
      { label: 'pt1', price: 18651.75, quantity_fraction: 0.5 },
      { label: 'pt2', price: 18683, quantity_fraction: 0.5 },
    ]);
    expect(result.candidate?.reward_risk).toEqual([
      { label: 'pt1', reward_risk: 1.9963 },
      { label: 'pt2', reward_risk: 3.9992 },
    ]);
    expect(result.candidate?.confidence).toBe(0.81);
    expect(result.candidate?.reasons).toEqual(
      expect.arrayContaining([
        'breakout_retest_long:breakout_confirmed',
        'breakout_retest_long:retest_hold',
        'breakout_retest_long:flow_positive',
      ]),
    );
  });

  it('keeps breakout_retest_long available after all V1 strategies are active', () => {
    expect(listExecutableStrategyIds()).toContain('breakout_retest_long');
    expect(getActiveStrategyGenerator('breakout_retest_long')({
      strategy_id: 'breakout_retest_long',
      snapshot: FIXTURE.snapshot,
    }).candidate?.strategy_id).toBe('breakout_retest_long');
  });

  it('rejects missing or unconfirmed breakout structure', () => {
    const missingBreakout = generateBreakoutRetestLong({
      strategy_id: 'breakout_retest_long',
      snapshot: withStructure({
        breakout_level: null,
      }),
    });
    const missingRetest = generateBreakoutRetestLong({
      strategy_id: 'breakout_retest_long',
      snapshot: withStructure({
        retest_hold: false,
      }),
    });

    expect(missingBreakout.candidate).toBeUndefined();
    expect(missingBreakout.evaluation.reasons[0]).toBe('breakout_retest_long:breakout_level_missing');
    expect(missingRetest.evaluation.reasons[0]).toBe('breakout_retest_long:retest_not_confirmed');
  });

  it('rejects retests too far from the breakout level', () => {
    const result = generateBreakoutRetestLong({
      strategy_id: 'breakout_retest_long',
      snapshot: withStructure({
        breakout_level: 18610,
      }),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe('breakout_retest_long:retest_distance_out_of_band');
  });

  it('rejects bearish or neutral trend state before breakout geometry', () => {
    const bearish = generateBreakoutRetestLong({
      strategy_id: 'breakout_retest_long',
      snapshot: withSnapshot({
        structure: {
          ...FIXTURE.snapshot.structure,
          trend: 'down',
        },
      }),
    });
    const neutral = generateBreakoutRetestLong({
      strategy_id: 'breakout_retest_long',
      snapshot: withSnapshot({
        structure: {
          ...FIXTURE.snapshot.structure,
          trend: 'range',
        },
      }),
    });

    expect(bearish.candidate).toBeUndefined();
    expect(bearish.evaluation.reasons[0]).toBe('breakout_retest_long:structure_trend_not_up');
    expect(neutral.evaluation.reasons[0]).toBe('breakout_retest_long:structure_trend_not_up');
  });

  it('rejects weak upside flow confirmation on the retest', () => {
    const result = generateBreakoutRetestLong({
      strategy_id: 'breakout_retest_long',
      snapshot: withIndicators({
        z_ofi_blend: BREAKOUT_RETEST_LONG_DEFAULTS.flow_confirmation_min - 0.01,
      }),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe('breakout_retest_long:flow_confirmation_below_threshold');
  });

  it('rejects insufficient upside room before candidate emission', () => {
    const result = generateBreakoutRetestLong({
      strategy_id: 'breakout_retest_long',
      snapshot: withStructure({
        nearest_resistance: 18628,
      }),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe('breakout_retest_long:insufficient_upside_room');
  });

  it('rejects invalid PT1/PT2 reward-risk after the room gate passes', () => {
    const result = generateBreakoutRetestLong({
      strategy_id: 'breakout_retest_long',
      snapshot: withStructure({
        nearest_resistance: 18642,
        pivot_resistance_1: 18600,
      }),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe('breakout_retest_long:targets_invalid');
  });

  it('keeps sigma/structure stop and confidence deterministic across repeated runs', () => {
    const first = generateBreakoutRetestLong({
      strategy_id: 'breakout_retest_long',
      snapshot: FIXTURE.snapshot,
    });
    const second = generateBreakoutRetestLong({
      strategy_id: 'breakout_retest_long',
      snapshot: FIXTURE.snapshot,
    });

    expect(first.candidate?.stop_price).toBe(18605);
    expect(first.candidate?.confidence).toBe(0.81);
    expect(first).toEqual(second);
  });
});
