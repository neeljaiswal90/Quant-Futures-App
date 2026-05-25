import { createHash as createHashForV5Registration } from 'node:crypto';
import { loadStrategyRuntimeConfig as loadStrategyRuntimeConfigForV5Registration } from '../../../src/config/strategy-config.js';
import {
  ACTIVE_STRATEGY_IDS as ACTIVE_STRATEGY_IDS_FOR_V5_REGISTRATION,
  ALL_STRATEGY_IDS as ALL_STRATEGY_IDS_FOR_V5_REGISTRATION,
  REGISTERED_INACTIVE_STRATEGY_IDS as REGISTERED_INACTIVE_STRATEGY_IDS_FOR_V5_REGISTRATION,
} from '../../../src/contracts/strategy-ids.js';
import { resolveManagementProfile as resolveManagementProfileForV5Registration } from '../../../src/management/management-profiles.js';
import { validateManagementProfile as validateManagementProfileForV5Registration } from '../../../src/management/types.js';
import {
  getStrategyGenerator as getStrategyGeneratorForV5Registration,
  listExecutableStrategyIds as listExecutableStrategyIdsForV5Registration,
  STRATEGY_REGISTRY as STRATEGY_REGISTRY_FOR_V5_REGISTRATION,
} from '../../../src/strategies/registry.js';
import { describe, expect, it } from 'vitest';

import {
  generateRegimeShockReversionShortV5StrictDeadline,
  type StrategyFeatureSnapshot,
  type StrategyFeatureSnapshotRegime,
} from '../../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../../fixtures/strategies/synthetic-feature-snapshots.js';

describe('regime_shock_reversion_short_v5_strict_deadline gate stack', () => {
  it('arms on high-regime positive VWAP shock above the tightened v2 threshold', () => {
    const result = generateRegimeShockReversionShortV5StrictDeadline({
      strategy_id: 'regime_shock_reversion_short_v5_strict_deadline',
      snapshot: withRegimeAndShock('high', 2.5),
    });

    expect(result.candidate?.direction).toBe('short');
    expect(result.evaluation.gate_state).toBe('armed');
    expect(result.evaluation.reasons).toContain('signed_shock_vwap:2.5');
  });

  it('blocks high-regime shocks below the v2 threshold', () => {
    const result = generateRegimeShockReversionShortV5StrictDeadline({
      strategy_id: 'regime_shock_reversion_short_v5_strict_deadline',
      snapshot: withRegimeAndShock('high', 1.5),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe(
      'regime_shock_reversion_short_v5_strict_deadline:high_regime_shock_below_pos_threshold',
    );
  });

  it('blocks low-regime shocks below the stricter low-regime threshold', () => {
    const result = generateRegimeShockReversionShortV5StrictDeadline({
      strategy_id: 'regime_shock_reversion_short_v5_strict_deadline',
      snapshot: withRegimeAndShock('low', 2.5),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe(
      'regime_shock_reversion_short_v5_strict_deadline:low_regime_shock_below_strict_pos_threshold',
    );
  });


  it('fails closed when the signed-shock feature is missing', () => {
    const snapshot = withRegimeAndShock('high', 2.5);
    const missingShockSnapshot = {
      ...snapshot,
      context: {
        ...snapshot.context,
        signed_shock_vwap: undefined,
      },
    } as unknown as StrategyFeatureSnapshot;

    expect(() => generateRegimeShockReversionShortV5StrictDeadline({
      strategy_id: 'regime_shock_reversion_short_v5_strict_deadline',
      snapshot: missingShockSnapshot,
    })).toThrow(/value/u);
  });
  it('fails closed when the regime label is unavailable', () => {
    const result = generateRegimeShockReversionShortV5StrictDeadline({
      strategy_id: 'regime_shock_reversion_short_v5_strict_deadline',
      snapshot: withRegimeAndShock('unknown', 2.5),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe(
      'regime_shock_reversion_short_v5_strict_deadline:missing_regime_label',
    );
  });
});

function withRegimeAndShock(
  regime: StrategyFeatureSnapshotRegime,
  shock: number,
): StrategyFeatureSnapshot {
  const base = STRATEGY_SYNTHETIC_FIXTURES.regime_shock_reversion_short_v5_strict_deadline.snapshot;
  const anchor = 18600;
  const sigma = 6;
  const midPx = anchor + shock * sigma;
  return {
    ...base,
    quote: {
      bid_px: midPx - 0.125,
      ask_px: midPx + 0.125,
      mid_px: midPx,
    },
    last_trade_price: midPx,
    context: {
      ...base.context,
      regime_label: regime,
      session_vwap: anchor,
      signed_shock_vwap: {
        value: shock,
        anchor_type: 'vwap',
        anchor_value: anchor,
        sigma_basis: 'atr_14',
        sigma_basis_value: sigma,
      },
    },
  };
}

describe('regime_shock_reversion_short_v5_strict_deadline registration', () => {
  const strategyId = 'regime_shock_reversion_short_v5_strict_deadline';

  it('resolves the expected ADR-0027 management profile', () => {
    const resolvedProfile = resolveManagementProfileForV5Registration(strategyId);
    const profile = resolvedProfile.profile;

    expect(profile.strategy_id).toBe(strategyId);
    expect(profile.time_stop.at_deadline_extension).toBe('unconditional_exit');
    expect(profile.reasons).toEqual([
      'management_profile:regime_shock_reversion_short_v5_strict_deadline',
      'initial_stop:candidate_stop',
      'partials:pt1_50_pt2_50',
    ]);

  });

  it('keeps the parameter lock hash stable across consecutive runtime config loads', () => {
    const first = loadStrategyRuntimeConfigForV5Registration({ cwd: process.cwd(), directory: 'config/strategies', required: true });
    const second = loadStrategyRuntimeConfigForV5Registration({ cwd: process.cwd(), directory: 'config/strategies', required: true });
    const hash = (value: unknown): string =>
      createHashForV5Registration('sha256').update(JSON.stringify(value)).digest('hex');

    expect(hash(first.strategies[strategyId])).toBe(hash(second.strategies[strategyId]));
  });

  it('registers as inactive while remaining generator-backed under the amended T8 semantics', () => {
    expect(REGISTERED_INACTIVE_STRATEGY_IDS_FOR_V5_REGISTRATION).toContain(strategyId);
    expect(ALL_STRATEGY_IDS_FOR_V5_REGISTRATION).toContain(strategyId);
    expect(ACTIVE_STRATEGY_IDS_FOR_V5_REGISTRATION).not.toContain(strategyId);
    expect(listExecutableStrategyIdsForV5Registration()).not.toContain(strategyId);
    expect(STRATEGY_REGISTRY_FOR_V5_REGISTRATION[strategyId]).toBeDefined();
    expect(getStrategyGeneratorForV5Registration(strategyId)).toBeDefined();
  });


});