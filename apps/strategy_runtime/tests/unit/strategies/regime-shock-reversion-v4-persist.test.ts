import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ConfigValidationError,
  loadStrategyRuntimeConfig,
} from '../../../src/config/index.js';
import {
  ACTIVE_STRATEGY_IDS,
  ALL_STRATEGY_IDS,
  REGISTERED_INACTIVE_STRATEGY_IDS,
} from '../../../src/contracts/strategy-ids.js';
import { resolveManagementProfile } from '../../../src/management/management-profiles.js';
import {
  generateRegimeShockReversionShortV4Persist,
  getStrategyGenerator,
  listExecutableStrategyIds,
  STRATEGY_REGISTRY,
  type StrategyFeatureSnapshot,
} from '../../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../../fixtures/strategies/synthetic-feature-snapshots.js';

const STRATEGY_ID = 'regime_shock_reversion_short_v4_persist' as const;
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('regime_shock_reversion_short_v4_persist gate stack', () => {
  it('arms when the last K shocks meet the high-regime threshold', () => {
    const result = generateRegimeShockReversionShortV4Persist({
      strategy_id: STRATEGY_ID,
      snapshot: withShockAndRecent(2.5, [0.5, 2.1, 2.25, 2.5]),
    });

    expect(result.evaluation.gate_state).toBe('armed');
    expect(result.candidate?.strategy_id).toBe(STRATEGY_ID);
    expect(result.evaluation.reasons).toContain('signed_shock_vwap_persist_3:2.1,2.25,2.5');
  });

  it('rejects when one of the last K shocks is below threshold', () => {
    const result = generateRegimeShockReversionShortV4Persist({
      strategy_id: STRATEGY_ID,
      snapshot: withShockAndRecent(2.5, [2.1, 1.5, 2.5]),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe(`${STRATEGY_ID}:shock_persistence_not_confirmed`);
  });

  it('rejects when one of the last K values is null', () => {
    const result = generateRegimeShockReversionShortV4Persist({
      strategy_id: STRATEGY_ID,
      snapshot: withShockAndRecent(2.5, [2.1, null, 2.5]),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe(`${STRATEGY_ID}:persistent_signed_shock_unavailable`);
  });

  it('rejects when recent values are unavailable', () => {
    const result = generateRegimeShockReversionShortV4Persist({
      strategy_id: STRATEGY_ID,
      snapshot: withShockAndRecent(2.5, null),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe(`${STRATEGY_ID}:recent_signed_shock_unavailable`);
  });

  it('rejects when fewer than K recent values are present', () => {
    const result = generateRegimeShockReversionShortV4Persist({
      strategy_id: STRATEGY_ID,
      snapshot: withShockAndRecent(2.5, [2.25, 2.5]),
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe(`${STRATEGY_ID}:recent_signed_shock_insufficient_history`);
  });

  it('preserves inherited roll-block fail-closed behavior', () => {
    const base = withShockAndRecent(2.5, [2.1, 2.25, 2.5]);
    const result = generateRegimeShockReversionShortV4Persist({
      strategy_id: STRATEGY_ID,
      snapshot: {
        ...base,
        session: {
          ...base.session,
          is_roll_block: true,
        },
      },
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe(`${STRATEGY_ID}:roll_block_active`);
  });

  it('preserves short-side target and stop construction', () => {
    const result = generateRegimeShockReversionShortV4Persist({
      strategy_id: STRATEGY_ID,
      snapshot: withShockAndRecent(2.5, [2.1, 2.25, 2.5]),
    });

    expect(result.candidate).toEqual(expect.objectContaining({
      direction: 'short',
      entry_price: 18615,
      stop_price: 18619.75,
      risk_points: 4.75,
    }));
    expect(result.candidate?.targets).toEqual([
      { label: 'pt1', price: 18609.25, quantity_fraction: 0.5 },
      { label: 'pt2', price: 18605.5, quantity_fraction: 0.5 },
    ]);
  });
});

describe('regime_shock_reversion_short_v4_persist registration and config', () => {
  it('registers as inactive while remaining generator-backed for explicit replay', () => {
    expect(REGISTERED_INACTIVE_STRATEGY_IDS).toContain(STRATEGY_ID);
    expect(ALL_STRATEGY_IDS).toContain(STRATEGY_ID);
    expect(ACTIVE_STRATEGY_IDS).not.toContain(STRATEGY_ID);
    expect(listExecutableStrategyIds()).toEqual([]);
    expect(STRATEGY_REGISTRY[STRATEGY_ID]).toEqual(expect.objectContaining({
      enabled_in_v1: false,
      extraction_ticket: 'CYCLE4-V4-COMBINED-01',
      setup_family: 'regime_shock_reversion',
    }));
    expect(getStrategyGenerator(STRATEGY_ID)).toBe(generateRegimeShockReversionShortV4Persist);
  });

  it('resolves a distinct v4 persistence management profile id', () => {
    const resolved = resolveManagementProfile(STRATEGY_ID, { allow_fallback: false });

    expect(resolved.profile.profile_id).toBe('regime_shock_reversion_short_v4_persist_management_v1');
    expect(resolved.profile.strategy_id).toBe(STRATEGY_ID);
    expect(resolved.profile.reasons).toEqual([
      'management_profile:regime_shock_reversion_short_v4_persist',
      'initial_stop:candidate_stop',
      'partials:pt1_50_pt2_50',
    ]);
  });

  it('loads the committed persistence config and rejects invalid persistence bounds', () => {
    const loaded = loadStrategyRuntimeConfig({ cwd: process.cwd(), directory: 'config/strategies', required: true });
    expect(loaded.strategies[STRATEGY_ID].shock_persistence_bars).toBe(3);

    const root = mkdtempSync(join(tmpdir(), 'v4-persist-config-'));
    tempDirs.push(root);
    cpSync(join(process.cwd(), 'config/strategies'), root, { recursive: true });
    writeFileSync(join(root, 'regime_shock_reversion_short_v4_persist.yaml'), [
      'version: 1',
      `strategy_id: ${STRATEGY_ID}`,
      'parameters:',
      '  vwap_reference: session_vwap',
      '  opening_window_minutes: 30',
      '  high_shock_threshold_neg: 2.20',
      '  high_shock_threshold_pos: 2.00',
      '  low_shock_threshold_neg: 2.90',
      '  low_shock_threshold_pos: 2.70',
      '  stop_sigma_multiple: 0.8',
      '  target_1_rr: 1.2',
      '  target_2_rr: 2.0',
      '  confidence_score_high: 0.72',
      '  confidence_score_low: 0.58',
      '  minimum_target_rr: 1.0',
      '  shock_persistence_bars: 0',
      '',
    ].join('\n'));

    expect(() => loadStrategyRuntimeConfig({ directory: root, required: true })).toThrow(ConfigValidationError);
  });
});

function withShockAndRecent(
  shock: number,
  recentValues: readonly (number | null)[] | null,
): StrategyFeatureSnapshot {
  const base = STRATEGY_SYNTHETIC_FIXTURES.regime_shock_reversion_short_v4_persist.snapshot;
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
      regime_label: 'high',
      session_vwap: anchor,
      signed_shock_vwap: {
        value: shock,
        anchor_type: 'vwap',
        anchor_value: anchor,
        sigma_basis: 'atr_14',
        sigma_basis_value: sigma,
      },
      signed_shock_vwap_recent_values: recentValues,
    },
  };
}