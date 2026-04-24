import { describe, expect, it } from 'vitest';
import {
  generateTrendPullbackShort,
  getActiveStrategyGenerator,
  listExecutableStrategyIds,
  TREND_PULLBACK_SHORT_DEFAULTS,
  type StrategyFeatureSnapshot,
  type StrategyScalarMap,
} from '../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

const FIXTURE = STRATEGY_SYNTHETIC_FIXTURES.trend_pullback_short;

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

describe('STRAT-03 trend_pullback_short extraction', () => {
  it('emits a deterministic bearish pullback candidate from the STRAT-00 fixture', () => {
    const result = generateTrendPullbackShort({
      strategy_id: 'trend_pullback_short',
      snapshot: FIXTURE.snapshot,
    });

    expect(result.evaluation).toMatchObject({
      strategy_id: 'trend_pullback_short',
      feature_snapshot_id: FIXTURE.fixture_id,
      gate_state: 'armed',
      evaluated_ts_ns: FIXTURE.snapshot.created_ts_ns,
      config: FIXTURE.snapshot.config,
    });
    expect(result.candidate).toMatchObject({
      candidate_id: `candidate-${FIXTURE.fixture_id}-trend_pullback_short`,
      strategy_id: 'trend_pullback_short',
      setup_type: 'trend_pullback_short',
      setup_family: 'trend_pullback',
      feature_snapshot_id: FIXTURE.fixture_id,
      direction: 'short',
      status: 'proposed',
      proposed_ts_ns: FIXTURE.snapshot.created_ts_ns,
      config: FIXTURE.snapshot.config,
    });
    expect(result.candidate?.entry_price).toBe(18542.75);
    expect(result.candidate?.stop_price).toBe(18550);
    expect(result.candidate?.risk_points).toBe(7.375);
    expect(result.candidate?.targets).toEqual([
      { label: 'pt1', price: 18526.25, quantity_fraction: 0.5 },
      { label: 'pt2', price: 18513.25, quantity_fraction: 0.5 },
    ]);
    expect(result.candidate?.reward_risk).toEqual([
      { label: 'pt1', reward_risk: 2.2203 },
      { label: 'pt2', reward_risk: 3.9831 },
    ]);
    expect(result.candidate?.confidence).toBe(0.8372);
    expect(result.candidate?.reasons).toEqual(
      expect.arrayContaining([
        'trend_pullback_short:ema_stack_bearish',
        'trend_pullback_short:pullback_geometry_valid',
        'trend_pullback_short:flow_negative',
      ]),
    );
  });

  it('keeps trend_pullback_short available through the active registry', () => {
    expect(listExecutableStrategyIds()).toEqual([
      'trend_pullback_long',
      'trend_pullback_short',
      'breakout_retest_long',
    ]);
    expect(getActiveStrategyGenerator('trend_pullback_short')({
      strategy_id: 'trend_pullback_short',
      snapshot: FIXTURE.snapshot,
    }).candidate?.strategy_id).toBe('trend_pullback_short');
    expect(() => getActiveStrategyGenerator('breakdown_retest_short')).toThrow(
      'strategy breakdown_retest_short is pending extraction',
    );
  });

  it('rejects bullish or neutral trend state before short-side geometry', () => {
    const bullish = generateTrendPullbackShort({
      strategy_id: 'trend_pullback_short',
      snapshot: withSnapshot({
        structure: {
          ...FIXTURE.snapshot.structure,
          trend: 'up',
        },
      }),
    });
    const neutral = generateTrendPullbackShort({
      strategy_id: 'trend_pullback_short',
      snapshot: withSnapshot({
        structure: {
          ...FIXTURE.snapshot.structure,
          trend: 'range',
        },
      }),
    });

    expect(bullish.candidate).toBeUndefined();
    expect(bullish.evaluation.reasons[0]).toBe('trend_pullback_short:structure_trend_not_down');
    expect(neutral.evaluation.reasons[0]).toBe('trend_pullback_short:structure_trend_not_down');
  });

  it('preserves short-side pullback ratio and downside flow rejection gates', () => {
    expect(generateTrendPullbackShort({
      strategy_id: 'trend_pullback_short',
      snapshot: withIndicators({
        pullback_ratio: TREND_PULLBACK_SHORT_DEFAULTS.pullback_ratio_max + 0.01,
      }),
    }).evaluation.reasons[0]).toBe('trend_pullback_short:pullback_ratio_out_of_band');

    expect(generateTrendPullbackShort({
      strategy_id: 'trend_pullback_short',
      snapshot: withIndicators({
        z_ofi_blend: TREND_PULLBACK_SHORT_DEFAULTS.flow_confirmation_min - 0.01,
      }),
    }).evaluation.reasons[0]).toBe('trend_pullback_short:flow_confirmation_below_threshold');
  });

  it('rejects insufficient downside room before candidate emission', () => {
    const result = generateTrendPullbackShort({
      strategy_id: 'trend_pullback_short',
      snapshot: withStructure({
        nearest_support: 18540,
      }),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe('trend_pullback_short:insufficient_downside_room');
  });

  it('rejects invalid PT1/PT2 reward-risk while preserving the downside-room distinction', () => {
    const result = generateTrendPullbackShort({
      strategy_id: 'trend_pullback_short',
      snapshot: withStructure({
        choch_buy: 18541.5,
        nearest_support: 18530,
      }),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe('trend_pullback_short:targets_invalid');
  });

  it('keeps sigma stop and confidence deterministic across repeated runs', () => {
    const first = generateTrendPullbackShort({
      strategy_id: 'trend_pullback_short',
      snapshot: FIXTURE.snapshot,
    });
    const second = generateTrendPullbackShort({
      strategy_id: 'trend_pullback_short',
      snapshot: FIXTURE.snapshot,
    });

    expect(first.candidate?.stop_price).toBe(18550);
    expect(first.candidate?.confidence).toBe(0.8372);
    expect(first).toEqual(second);
  });
});
