import { describe, expect, it } from 'vitest';

import { DEFAULT_STRATEGY_RUNTIME_CONFIG } from '../../../src/config/index.js';
import {
  ACTIVE_STRATEGY_IDS,
  ALL_STRATEGY_IDS,
  REGISTERED_INACTIVE_STRATEGY_IDS,
} from '../../../src/contracts/strategy-ids.js';
import {
  generateRegimeShockReversionShortV2,
  generateRegimeShockReversionShortV2Utc1618Exclusion,
  getStrategyGenerator,
  listExecutableStrategyIds,
  STRATEGY_REGISTRY,
  type StrategyFeatureSnapshot,
} from '../../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../../fixtures/strategies/synthetic-feature-snapshots.js';

const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion' as const;
const BASE_STRATEGY_ID = 'regime_shock_reversion_short_v2' as const;

describe('regime_shock_reversion_short_v2_utc_16_18_exclusion gate stack', () => {
  it('preserves existing v2 behavior during UTC 16 while the new variant blocks', () => {
    const snapshot = withUtcTimestamp('2026-04-23T16:30:00.000Z');
    const base = generateRegimeShockReversionShortV2({ strategy_id: BASE_STRATEGY_ID, snapshot });
    const variant = generateRegimeShockReversionShortV2Utc1618Exclusion({ strategy_id: STRATEGY_ID, snapshot });

    expect(base.evaluation.gate_state).toBe('armed');
    expect(base.candidate?.strategy_id).toBe(BASE_STRATEGY_ID);
    expect(variant.candidate).toBeUndefined();
    expect(variant.evaluation.gate_state).toBe('blocked');
    expect(variant.evaluation.strategy_id).toBe(STRATEGY_ID);
    expect(variant.evaluation.reasons[0]).toBe(`${STRATEGY_ID}:utc_16_18_exclusion`);
  });

  it.each([
    ['2026-04-23T15:00:00.000Z', true],
    ['2026-04-23T16:00:00.000Z', false],
    ['2026-04-23T17:00:00.000Z', false],
    ['2026-04-23T18:00:00.000Z', true],
    ['2026-04-23T15:59:59.999Z', true],
    ['2026-04-23T17:59:59.999Z', false],
    ['2026-04-23T18:00:00.000Z', true],
    ['2026-03-08T16:30:00.000Z', false],
  ])('uses fixed UTC boundary semantics for %s', (iso, shouldArm) => {
    const result = generateRegimeShockReversionShortV2Utc1618Exclusion({
      strategy_id: STRATEGY_ID,
      snapshot: withUtcTimestamp(iso),
    });

    expect(result.evaluation.strategy_id).toBe(STRATEGY_ID);
    expect(result.evaluation.strategy_evaluation_id).toContain(STRATEGY_ID);
    if (shouldArm) {
      expect(result.evaluation.gate_state).toBe('armed');
      expect(result.candidate?.strategy_id).toBe(STRATEGY_ID);
      expect(result.candidate?.candidate_id).toContain(STRATEGY_ID);
      expect(result.candidate?.setup_type).toBe(STRATEGY_ID);
      expect(result.candidate?.proposed_ts_ns).toBe(withUtcTimestamp(iso).created_ts_ns);
    } else {
      expect(result.candidate).toBeUndefined();
      expect(result.evaluation.gate_state).toBe('blocked');
      expect(result.evaluation.reasons).toContain(`${STRATEGY_ID}:utc_16_18_exclusion`);
    }
  });

  it('preserves inherited v2 rejection reasons before applying the UTC exclusion', () => {
    const snapshot = withUtcTimestamp('2026-04-23T16:30:00.000Z');
    const result = generateRegimeShockReversionShortV2Utc1618Exclusion({
      strategy_id: STRATEGY_ID,
      snapshot: {
        ...snapshot,
        context: {
          ...snapshot.context,
          regime_label: 'unknown',
        },
      },
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe(`${STRATEGY_ID}:missing_regime_label`);
    expect(result.evaluation.reasons).not.toContain(`${STRATEGY_ID}:utc_16_18_exclusion`);
  });

  it('uses variant strategy config parameters rather than base v2 parameters', () => {
    const snapshot = withUtcTimestamp('2026-04-23T15:30:00.000Z');
    const baseConfig = DEFAULT_STRATEGY_RUNTIME_CONFIG.strategies[BASE_STRATEGY_ID];
    const variantConfig = DEFAULT_STRATEGY_RUNTIME_CONFIG.strategies[STRATEGY_ID];
    const strategy_config = {
      ...DEFAULT_STRATEGY_RUNTIME_CONFIG,
      strategies: {
        ...DEFAULT_STRATEGY_RUNTIME_CONFIG.strategies,
        [BASE_STRATEGY_ID]: {
          ...baseConfig,
          high_shock_threshold_pos: 999,
          low_shock_threshold_pos: 1000,
        },
        [STRATEGY_ID]: {
          ...variantConfig,
          high_shock_threshold_pos: 0.1,
          low_shock_threshold_pos: 0.2,
        },
      },
    };

    const base = generateRegimeShockReversionShortV2({
      strategy_id: BASE_STRATEGY_ID,
      strategy_config,
      snapshot,
    });
    const variant = generateRegimeShockReversionShortV2Utc1618Exclusion({
      strategy_id: STRATEGY_ID,
      strategy_config,
      snapshot,
    });

    expect(base.candidate).toBeUndefined();
    expect(base.evaluation.gate_state).toBe('blocked');
    expect(variant.evaluation.gate_state).toBe('armed');
    expect(variant.candidate?.strategy_id).toBe(STRATEGY_ID);
    expect(variant.evaluation.reasons).toContain(`${STRATEGY_ID}:armed`);
  });

  it('registers as inactive while remaining generator-backed for explicit replay', () => {
    expect(REGISTERED_INACTIVE_STRATEGY_IDS).toContain(STRATEGY_ID);
    expect(ALL_STRATEGY_IDS).toContain(STRATEGY_ID);
    expect(ACTIVE_STRATEGY_IDS).not.toContain(STRATEGY_ID);
    expect(listExecutableStrategyIds()).toEqual([]);
    expect(STRATEGY_REGISTRY[STRATEGY_ID]).toEqual(expect.objectContaining({
      enabled_in_v1: false,
      extraction_ticket: 'V2-PF-C-LATE-AM-REGISTERED-INACTIVE-IMPL-01',
      setup_family: 'regime_shock_reversion',
    }));
    expect(getStrategyGenerator(STRATEGY_ID)).toBe(generateRegimeShockReversionShortV2Utc1618Exclusion);
  });
});

function withUtcTimestamp(iso: string): StrategyFeatureSnapshot {
  const base = STRATEGY_SYNTHETIC_FIXTURES.regime_shock_reversion_short_v2.snapshot;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid ISO timestamp fixture: ${iso}`);
  }
  return {
    ...base,
    created_ts_ns: BigInt(ms) * 1_000_000n as StrategyFeatureSnapshot['created_ts_ns'],
  };
}
