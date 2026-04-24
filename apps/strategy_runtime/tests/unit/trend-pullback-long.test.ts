import { describe, expect, it } from 'vitest';
import {
  generateTrendPullbackLong,
  getActiveStrategyGenerator,
  TREND_PULLBACK_LONG_DEFAULTS,
  type StrategyFeatureSnapshot,
  type StrategyScalarMap,
} from '../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

const FIXTURE = STRATEGY_SYNTHETIC_FIXTURES.trend_pullback_long;

function withIndicators(
  overrides: StrategyScalarMap,
): StrategyFeatureSnapshot {
  return {
    ...FIXTURE.snapshot,
    indicators: {
      ...FIXTURE.snapshot.indicators,
      ...overrides,
    },
  };
}

function withStructure(
  overrides: StrategyScalarMap,
): StrategyFeatureSnapshot {
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

describe('STRAT-02 trend_pullback_long extraction', () => {
  it('emits a deterministic armed evaluation and candidate from the STRAT-00 fixture', () => {
    const result = generateTrendPullbackLong({
      strategy_id: 'trend_pullback_long',
      snapshot: FIXTURE.snapshot,
    });

    expect(result.evaluation).toMatchObject({
      strategy_id: 'trend_pullback_long',
      feature_snapshot_id: FIXTURE.fixture_id,
      gate_state: 'armed',
      evaluated_ts_ns: FIXTURE.snapshot.created_ts_ns,
      config: FIXTURE.snapshot.config,
    });
    expect(result.candidate).toMatchObject({
      candidate_id: `candidate-${FIXTURE.fixture_id}-trend_pullback_long`,
      strategy_id: 'trend_pullback_long',
      feature_snapshot_id: FIXTURE.fixture_id,
      direction: 'long',
      status: 'proposed',
      proposed_ts_ns: FIXTURE.snapshot.created_ts_ns,
      config: FIXTURE.snapshot.config,
    });
    expect(result.candidate?.entry_price).toBe(18599);
    expect(result.candidate?.stop_price).toBe(18591.75);
    expect(result.candidate?.targets).toEqual([
      { label: 'pt1', price: 18613.5, quantity_fraction: 0.5 },
      { label: 'pt2', price: 18627.5, quantity_fraction: 0.5 },
    ]);
    expect(result.candidate?.confidence).toBe(0.8428);
    expect(result.candidate?.reasons).toEqual(
      expect.arrayContaining([
        'trend_pullback_long:ema_stack_bullish',
        'trend_pullback_long:pullback_geometry_valid',
        'trend_pullback_long:flow_positive',
      ]),
    );
  });

  it('is available through the active strategy registry and leaves other strategies pending', () => {
    const generator = getActiveStrategyGenerator('trend_pullback_long');

    expect(generator({
      strategy_id: 'trend_pullback_long',
      snapshot: FIXTURE.snapshot,
    }).candidate?.strategy_id).toBe('trend_pullback_long');
    expect(() => getActiveStrategyGenerator('trend_pullback_short')).toThrow(
      'strategy trend_pullback_short is pending extraction',
    );
  });

  it('blocks when the bullish trend and EMA stack gates are not satisfied', () => {
    const notBullish = generateTrendPullbackLong({
      strategy_id: 'trend_pullback_long',
      snapshot: withIndicators({
        ema_9: 18580,
      }),
    });

    expect(notBullish.candidate).toBeUndefined();
    expect(notBullish.evaluation.gate_state).toBe('blocked');
    expect(notBullish.evaluation.reasons[0]).toBe('trend_pullback_long:ema_stack_not_bullish');
  });

  it('preserves z-EMA9, pullback geometry, and flow confirmation thresholds', () => {
    expect(generateTrendPullbackLong({
      strategy_id: 'trend_pullback_long',
      snapshot: withIndicators({ z_ema9: TREND_PULLBACK_LONG_DEFAULTS.z_ema9_max + 0.01 }),
    }).evaluation.reasons[0]).toBe('trend_pullback_long:z_ema9_out_of_band');

    expect(generateTrendPullbackLong({
      strategy_id: 'trend_pullback_long',
      snapshot: withIndicators({ pullback_ratio: TREND_PULLBACK_LONG_DEFAULTS.pullback_ratio_min - 0.01 }),
    }).evaluation.reasons[0]).toBe('trend_pullback_long:pullback_ratio_out_of_band');

    expect(generateTrendPullbackLong({
      strategy_id: 'trend_pullback_long',
      snapshot: withIndicators({ z_ofi_blend: TREND_PULLBACK_LONG_DEFAULTS.flow_confirmation_min - 0.01 }),
    }).evaluation.reasons[0]).toBe('trend_pullback_long:flow_confirmation_below_threshold');
  });

  it('blocks when upside room cannot satisfy the minimum reward/risk', () => {
    const result = generateTrendPullbackLong({
      strategy_id: 'trend_pullback_long',
      snapshot: withStructure({
        nearest_resistance: 18600,
        choch_sell: 18600,
      }),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe('trend_pullback_long:insufficient_upside_room');
  });
});
