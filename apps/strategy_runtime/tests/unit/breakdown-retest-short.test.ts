import { describe, expect, it } from 'vitest';
import {
  BREAKDOWN_RETEST_SHORT_DEFAULTS,
  generateBreakdownRetestShort,
  getActiveStrategyGenerator,
  listExecutableStrategyIds,
  type StrategyFeatureSnapshot,
  type StrategyScalarMap,
} from '../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

const FIXTURE = STRATEGY_SYNTHETIC_FIXTURES.breakdown_retest_short;

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

describe('STRAT-05 breakdown_retest_short extraction', () => {
  it('emits a deterministic bearish breakdown retest candidate from the STRAT-00 fixture', () => {
    const result = generateBreakdownRetestShort({
      strategy_id: 'breakdown_retest_short',
      snapshot: FIXTURE.snapshot,
    });

    expect(result.evaluation).toMatchObject({
      strategy_id: 'breakdown_retest_short',
      feature_snapshot_id: FIXTURE.fixture_id,
      gate_state: 'armed',
      evaluated_ts_ns: FIXTURE.snapshot.created_ts_ns,
      config: FIXTURE.snapshot.config,
    });
    expect(result.candidate).toMatchObject({
      candidate_id: `candidate-${FIXTURE.fixture_id}-breakdown_retest_short`,
      strategy_id: 'breakdown_retest_short',
      setup_type: 'breakdown_retest_short',
      setup_family: 'breakout_retest',
      feature_snapshot_id: FIXTURE.fixture_id,
      direction: 'short',
      status: 'proposed',
      proposed_ts_ns: FIXTURE.snapshot.created_ts_ns,
      config: FIXTURE.snapshot.config,
    });
    expect(result.candidate?.entry_price).toBe(18491);
    expect(result.candidate?.stop_price).toBe(18507.75);
    expect(result.candidate?.risk_points).toBe(16.8713);
    expect(result.candidate?.targets).toEqual([
      { label: 'pt1', price: 18457.25, quantity_fraction: 0.5 },
      { label: 'pt2', price: 18423.5, quantity_fraction: 0.5 },
    ]);
    expect(result.candidate?.reward_risk).toEqual([
      { label: 'pt1', reward_risk: 1.9933 },
      { label: 'pt2', reward_risk: 3.9937 },
    ]);
    expect(result.candidate?.confidence).toBe(0.805);
    expect(result.candidate?.reasons).toEqual(
      expect.arrayContaining([
        'breakdown_retest_short:breakdown_confirmed',
        'breakdown_retest_short:retest_reject',
        'breakdown_retest_short:flow_negative',
      ]),
    );
  });

  it('activates all four V1 deterministic strategies', () => {
    expect(listExecutableStrategyIds()).toEqual([
      'trend_pullback_long',
      'trend_pullback_short',
      'breakout_retest_long',
      'breakdown_retest_short',
    ]);
    expect(getActiveStrategyGenerator('breakdown_retest_short')({
      strategy_id: 'breakdown_retest_short',
      snapshot: FIXTURE.snapshot,
    }).candidate?.strategy_id).toBe('breakdown_retest_short');
  });

  it('rejects missing or unconfirmed breakdown structure', () => {
    const missingBrokenSupport = generateBreakdownRetestShort({
      strategy_id: 'breakdown_retest_short',
      snapshot: withStructure({
        broken_support: null,
      }),
    });
    const missingRetestReject = generateBreakdownRetestShort({
      strategy_id: 'breakdown_retest_short',
      snapshot: withStructure({
        retest_reject: false,
      }),
    });

    expect(missingBrokenSupport.candidate).toBeUndefined();
    expect(missingBrokenSupport.evaluation.reasons[0]).toBe(
      'breakdown_retest_short:broken_support_missing',
    );
    expect(missingRetestReject.evaluation.reasons[0]).toBe(
      'breakdown_retest_short:retest_not_rejected',
    );
  });

  it('rejects retests too far from the broken support level', () => {
    const result = generateBreakdownRetestShort({
      strategy_id: 'breakdown_retest_short',
      snapshot: withStructure({
        broken_support: 18502,
      }),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe('breakdown_retest_short:retest_distance_out_of_band');
  });

  it('rejects bullish or neutral trend state before breakdown geometry', () => {
    const bullish = generateBreakdownRetestShort({
      strategy_id: 'breakdown_retest_short',
      snapshot: withSnapshot({
        structure: {
          ...FIXTURE.snapshot.structure,
          trend: 'up',
        },
      }),
    });
    const neutral = generateBreakdownRetestShort({
      strategy_id: 'breakdown_retest_short',
      snapshot: withSnapshot({
        structure: {
          ...FIXTURE.snapshot.structure,
          trend: 'range',
        },
      }),
    });

    expect(bullish.candidate).toBeUndefined();
    expect(bullish.evaluation.reasons[0]).toBe('breakdown_retest_short:structure_trend_not_down');
    expect(neutral.evaluation.reasons[0]).toBe('breakdown_retest_short:structure_trend_not_down');
  });

  it('rejects weak downside flow confirmation on the retest', () => {
    const result = generateBreakdownRetestShort({
      strategy_id: 'breakdown_retest_short',
      snapshot: withIndicators({
        z_ofi_blend: BREAKDOWN_RETEST_SHORT_DEFAULTS.flow_confirmation_min - 0.01,
      }),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe(
      'breakdown_retest_short:flow_confirmation_below_threshold',
    );
  });

  it('rejects insufficient downside room before candidate emission', () => {
    const result = generateBreakdownRetestShort({
      strategy_id: 'breakdown_retest_short',
      snapshot: withStructure({
        choch_buy: 18480,
      }),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe('breakdown_retest_short:insufficient_downside_room');
  });

  it('rejects invalid PT1/PT2 reward-risk after the room gate passes', () => {
    const result = generateBreakdownRetestShort({
      strategy_id: 'breakdown_retest_short',
      snapshot: withStructure({
        choch_buy: 18463.5,
        pivot_support_1: 18500,
      }),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe('breakdown_retest_short:targets_invalid');
  });

  it('keeps sigma/structure stop and confidence deterministic across repeated runs', () => {
    const first = generateBreakdownRetestShort({
      strategy_id: 'breakdown_retest_short',
      snapshot: FIXTURE.snapshot,
    });
    const second = generateBreakdownRetestShort({
      strategy_id: 'breakdown_retest_short',
      snapshot: FIXTURE.snapshot,
    });

    expect(first.candidate?.stop_price).toBe(18507.75);
    expect(first.candidate?.confidence).toBe(0.805);
    expect(first).toEqual(second);
  });
});
