import { describe, expect, it } from 'vitest';

import {
  generateOpeningRangeBoxBreakoutLong,
  generateOpeningRangeBoxBreakoutShort,
  generateOpeningRangeBoxFadeLong,
  generateOpeningRangeBoxFadeShort,
  generateOpeningRangeBoxRegimeLong,
  generateOpeningRangeBoxRegimeShort,
  type StrategyFeatureSnapshot,
} from '../../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../../fixtures/strategies/synthetic-feature-snapshots.js';

function withContext(
  base: StrategyFeatureSnapshot,
  context: Partial<StrategyFeatureSnapshot['context']>,
): StrategyFeatureSnapshot {
  return { ...base, context: { ...base.context, ...context } };
}

function withPrice(base: StrategyFeatureSnapshot, price: number): StrategyFeatureSnapshot {
  return {
    ...base,
    last_trade_price: price,
    quote: { bid_px: price - 0.125, ask_px: price + 0.125, mid_px: price },
  };
}

describe('opening_range_box_breakout_long', () => {
  const fixture = STRATEGY_SYNTHETIC_FIXTURES.opening_range_box_breakout_long.snapshot;

  it('arms when price clears the box high within the chase limit', () => {
    const result = generateOpeningRangeBoxBreakoutLong({
      strategy_id: 'opening_range_box_breakout_long',
      snapshot: fixture,
    });

    expect(result.evaluation.gate_state).toBe('armed');
    expect(result.candidate?.direction).toBe('long');
    // entry = box_high(18600) + 2 ticks(0.5) = 18600.5; stop = box_low(18595) - 2 ticks = 18594.5.
    expect(result.candidate?.entry_price).toBe(18600.5);
    expect(result.candidate?.stop_price).toBe(18594.5);
    expect(result.candidate?.targets.map((t) => t.quantity_fraction)).toEqual([0.5, 0.5]);
    expect(result.evaluation.reasons).toContain('opening_range_box_breakout_long:mode_breakout');
  });

  it('blocks when the box is not yet ready', () => {
    const result = generateOpeningRangeBoxBreakoutLong({
      strategy_id: 'opening_range_box_breakout_long',
      snapshot: withContext(fixture, { ten_am_box_ready: false }),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.gate_state).toBe('blocked');
    expect(result.evaluation.reasons[0]).toBe('opening_range_box_breakout_long:box_not_ready');
  });

  it('blocks when price has run beyond the chase limit', () => {
    const result = generateOpeningRangeBoxBreakoutLong({
      strategy_id: 'opening_range_box_breakout_long',
      snapshot: withPrice(fixture, 18610),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons).toContain(
      'opening_range_box_breakout_long:breakout_beyond_chase_limit',
    );
  });
});

describe('opening_range_box_breakout_short', () => {
  const fixture = STRATEGY_SYNTHETIC_FIXTURES.opening_range_box_breakout_short.snapshot;

  it('arms when price breaks the box low within the chase limit', () => {
    const result = generateOpeningRangeBoxBreakoutShort({
      strategy_id: 'opening_range_box_breakout_short',
      snapshot: fixture,
    });

    expect(result.evaluation.gate_state).toBe('armed');
    expect(result.candidate?.direction).toBe('short');
    // entry = box_low(18595) - 2 ticks(0.5) = 18594.5; stop = box_high(18600) + 2 ticks = 18600.5.
    expect(result.candidate?.entry_price).toBe(18594.5);
    expect(result.candidate?.stop_price).toBe(18600.5);
  });

  it('blocks when price has not broken below the box low', () => {
    const result = generateOpeningRangeBoxBreakoutShort({
      strategy_id: 'opening_range_box_breakout_short',
      snapshot: withPrice(fixture, 18598),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons).toContain(
      'opening_range_box_breakout_short:no_downside_breakout',
    );
  });
});

describe('opening_range_box_fade_long', () => {
  const fixture = STRATEGY_SYNTHETIC_FIXTURES.opening_range_box_fade_long.snapshot;

  it('arms on a false breakdown that reclaimed inside the box', () => {
    const result = generateOpeningRangeBoxFadeLong({
      strategy_id: 'opening_range_box_fade_long',
      snapshot: fixture,
    });

    expect(result.evaluation.gate_state).toBe('armed');
    expect(result.candidate?.direction).toBe('long');
    expect(result.evaluation.reasons).toContain('opening_range_box_fade_long:mode_fade');
    expect(result.evaluation.reasons.some((r) => r.startsWith('box_fade_poke_ticks:'))).toBe(true);
  });

  it('blocks when price is still below the box low (no reclaim)', () => {
    const result = generateOpeningRangeBoxFadeLong({
      strategy_id: 'opening_range_box_fade_long',
      snapshot: withPrice(fixture, 18594),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons).toContain(
      'opening_range_box_fade_long:price_not_back_inside_box',
    );
  });
});

describe('opening_range_box_fade_short', () => {
  const fixture = STRATEGY_SYNTHETIC_FIXTURES.opening_range_box_fade_short.snapshot;

  it('arms on a false breakout that fell back inside the box', () => {
    const result = generateOpeningRangeBoxFadeShort({
      strategy_id: 'opening_range_box_fade_short',
      snapshot: fixture,
    });

    expect(result.evaluation.gate_state).toBe('armed');
    expect(result.candidate?.direction).toBe('short');
    expect(result.evaluation.reasons).toContain('opening_range_box_fade_short:mode_fade');
  });

  it('blocks when price is still above the box high (no reclaim)', () => {
    const result = generateOpeningRangeBoxFadeShort({
      strategy_id: 'opening_range_box_fade_short',
      snapshot: withPrice(fixture, 18601),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons).toContain(
      'opening_range_box_fade_short:price_not_back_inside_box',
    );
  });
});

describe('opening_range_box_regime_long', () => {
  const fixture = STRATEGY_SYNTHETIC_FIXTURES.opening_range_box_regime_long.snapshot;

  it('routes a trending tape to breakout logic and arms', () => {
    const result = generateOpeningRangeBoxRegimeLong({
      strategy_id: 'opening_range_box_regime_long',
      snapshot: fixture,
    });

    expect(result.evaluation.gate_state).toBe('armed');
    expect(result.candidate?.direction).toBe('long');
    expect(result.evaluation.reasons).toContain('opening_range_box_regime_long:mode_breakout');
  });

  it('routes a ranging tape (low ADX) to fade logic', () => {
    // Range regime: low ADX + range trend dispatches to the fade path. The
    // regime fixture's bars carry a false-breakdown poke, and pulling price back
    // inside the box arms the fade leg — proving the dispatcher chose fade.
    const rangeSnapshot = withPrice({
      ...fixture,
      structure: { ...fixture.structure, trend: 'range' },
      indicators: { ...fixture.indicators, adx_14: 12 },
    }, 18597);
    const result = generateOpeningRangeBoxRegimeLong({
      strategy_id: 'opening_range_box_regime_long',
      snapshot: rangeSnapshot,
    });

    expect(result.evaluation.gate_state).toBe('armed');
    expect(result.candidate?.direction).toBe('long');
    expect(result.evaluation.reasons).toContain('opening_range_box_regime_long:mode_fade');
  });
});

describe('opening_range_box_regime_short', () => {
  const fixture = STRATEGY_SYNTHETIC_FIXTURES.opening_range_box_regime_short.snapshot;

  it('routes a trending tape to breakout logic and arms', () => {
    const result = generateOpeningRangeBoxRegimeShort({
      strategy_id: 'opening_range_box_regime_short',
      snapshot: fixture,
    });

    expect(result.evaluation.gate_state).toBe('armed');
    expect(result.candidate?.direction).toBe('short');
    expect(result.evaluation.reasons).toContain('opening_range_box_regime_short:mode_breakout');
  });

  it('blocks when the session is not RTH', () => {
    const result = generateOpeningRangeBoxRegimeShort({
      strategy_id: 'opening_range_box_regime_short',
      snapshot: { ...fixture, session: { ...fixture.session, is_rth: false } },
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe('opening_range_box_regime_short:session_not_rth');
  });
});
