import { describe, expect, it } from 'vitest';

import { STRATEGY_CONFIG_PATHS } from '../../src/run-spec-builder.js';

describe('STRAT-V5 run-spec config paths', () => {
  it('maps v5_strict_deadline to its strategy YAML file', () => {
    expect(STRATEGY_CONFIG_PATHS.regime_shock_reversion_short_v5_strict_deadline).toBe(
      'config/strategies/regime_shock_reversion_short_v5_strict_deadline.yaml',
    );
  });

  it('maps v5_trail_at_deadline to its strategy YAML file', () => {
    expect(STRATEGY_CONFIG_PATHS.regime_shock_reversion_short_v5_trail_at_deadline).toBe(
      'config/strategies/regime_shock_reversion_short_v5_trail_at_deadline.yaml',
    );
  });
});