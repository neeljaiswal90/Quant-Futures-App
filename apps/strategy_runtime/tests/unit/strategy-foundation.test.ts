import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STRATEGY_IDS,
  CANDIDATE_STRATEGY_IDS,
  REGISTERED_INACTIVE_STRATEGY_IDS,
  isStrategyId,
  stableJsonStringify,
  type JsonValue,
} from '../../src/contracts/index.js';
import {
  getStrategyRegistryEntry,
  listAllStrategyRegistryEntries,
  listExecutableStrategyIds,
  listStrategyIdsByDirection,
  listStrategyIdsBySetupFamily,
  listStrategyRegistryEntries,
  validateStrategyRegistry,
} from '../../src/strategies/index.js';
import {
  listSyntheticStrategyFixtures,
  STRATEGY_SYNTHETIC_FIXTURE_VERSION,
  STRATEGY_SYNTHETIC_FIXTURES,
} from '../fixtures/strategies/synthetic-feature-snapshots.js';

function listStrategySourceFiles(directory = join(process.cwd(), 'apps/strategy_runtime/src/strategies')): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return listStrategySourceFiles(path);
    }
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

describe('STRAT-00 synthetic feature snapshots', () => {
  it('provides one deterministic fixture for each active Cycle3 strategy', () => {
    const fixtures = listSyntheticStrategyFixtures();

    expect(fixtures.map((fixture) => fixture.strategy_id)).toEqual(ACTIVE_STRATEGY_IDS);
    expect(STRATEGY_SYNTHETIC_FIXTURE_VERSION).toBe(1);
    for (const fixture of fixtures) {
      expect(fixture.snapshot.feature_snapshot_id).toBe(fixture.fixture_id);
      expect(fixture.snapshot.instrument.root).toBe('MNQ');
      expect(fixture.snapshot.session.phase).toBe('rth');
      expect(fixture.expected_gate_state).toBe('armed');
      expect(fixture.expected_reason_fragments.length).toBeGreaterThan(0);
    }
  });

  it('covers long/short trend-pullback and breakout/breakdown retest scenarios', () => {
    expect(STRATEGY_SYNTHETIC_FIXTURES.trend_pullback_long.expected_direction).toBe('long');
    expect(STRATEGY_SYNTHETIC_FIXTURES.trend_pullback_short.expected_direction).toBe('short');
    expect(STRATEGY_SYNTHETIC_FIXTURES.breakout_retest_long.expected_direction).toBe('long');
    expect(STRATEGY_SYNTHETIC_FIXTURES.breakdown_retest_short.expected_direction).toBe('short');

    expect(
      STRATEGY_SYNTHETIC_FIXTURES.trend_pullback_long.snapshot.indicators.supertrend_direction,
    ).toBe('up');
    expect(
      STRATEGY_SYNTHETIC_FIXTURES.trend_pullback_short.snapshot.indicators.supertrend_direction,
    ).toBe('down');
    expect(
      STRATEGY_SYNTHETIC_FIXTURES.breakout_retest_long.snapshot.structure.values.retest_hold,
    ).toBe(true);
    expect(
      STRATEGY_SYNTHETIC_FIXTURES.breakdown_retest_short.snapshot.structure.values.retest_reject,
    ).toBe(true);
  });

  it('serializes fixtures byte-stably for future strategy extraction tests', () => {
    const fixtures = listSyntheticStrategyFixtures() as unknown as JsonValue;
    const first = stableJsonStringify(fixtures);
    const second = stableJsonStringify(fixtures);

    expect(first).toBe(second);
    expect(first).toContain('"strategy_id":"vwap_overnight_reversal_long"');
    expect(first).toContain('"created_ts_ns":"1776958440000000000"');
  });
});

describe('STRAT-01 active strategy registry', () => {
  it('registers the three active Cycle3 strategies and preserves inactive lineage', () => {
    const entries = listStrategyRegistryEntries();

    expect(validateStrategyRegistry()).toEqual([]);
    expect(entries.map((entry) => entry.strategy_id)).toEqual(ACTIVE_STRATEGY_IDS);
    expect(entries.every((entry) => isStrategyId(entry.strategy_id))).toBe(true);
    expect(() => getStrategyRegistryEntry('shadow_lob_scalp')).toThrow('Unknown strategy_id');
    expect(CANDIDATE_STRATEGY_IDS).toEqual([]);
    expect(REGISTERED_INACTIVE_STRATEGY_IDS).toEqual([
      'trend_pullback_long',
      'trend_pullback_short',
      'breakout_retest_long',
      'breakdown_retest_short',
      'regime_mean_reversion_long',
      'regime_mean_reversion_short',
      'liquidity_sweep_reversal_long',
      'liquidity_sweep_reversal_short',
    ]);
    expect(listAllStrategyRegistryEntries().map((entry) => entry.strategy_id)).toEqual([
      ...ACTIVE_STRATEGY_IDS,
      ...CANDIDATE_STRATEGY_IDS,
      ...REGISTERED_INACTIVE_STRATEGY_IDS,
    ]);
    expect(getStrategyRegistryEntry('liquidity_sweep_reversal_long')).toEqual(
      expect.objectContaining({
        enabled_in_v1: false,
        extraction_ticket: 'QFA-7xx-S2',
        setup_family: 'liquidity_sweep_reversal',
      }),
    );
    expect(getStrategyRegistryEntry('regime_mean_reversion_long')).toEqual(
      expect.objectContaining({
        enabled_in_v1: false,
        extraction_ticket: 'QFA-7xx-S3',
        setup_family: 'regime_mean_reversion',
      }),
    );
    expect(getStrategyRegistryEntry('vwap_overnight_reversal_long')).toEqual(
      expect.objectContaining({
        enabled_in_v1: true,
        extraction_ticket: 'QFA-7xx-S1',
        setup_family: 'vwap_overnight_reversal',
      }),
    );
    expect(getStrategyRegistryEntry('regime_shock_reversion_short_v2')).toEqual(
      expect.objectContaining({
        enabled_in_v1: true,
        extraction_ticket: 'QFA-7xx-S3-v2',
        setup_family: 'regime_shock_reversion',
      }),
    );
  });

  it('groups strategies by direction and setup family deterministically', () => {
    expect(listStrategyIdsByDirection('long')).toEqual([
      'vwap_overnight_reversal_long',
    ]);
    expect(listStrategyIdsByDirection('short')).toEqual([
      'vwap_overnight_reversal_short',
      'regime_shock_reversion_short_v2',
    ]);
    expect(listStrategyIdsBySetupFamily('trend_pullback')).toEqual([
    ]);
    expect(listStrategyIdsBySetupFamily('breakout_retest')).toEqual([
    ]);
    expect(listStrategyIdsBySetupFamily('regime_mean_reversion')).toEqual([
    ]);
    expect(listStrategyIdsBySetupFamily('liquidity_sweep_reversal')).toEqual([
    ]);
    expect(listStrategyIdsBySetupFamily('vwap_overnight_reversal')).toEqual([
      'vwap_overnight_reversal_long',
      'vwap_overnight_reversal_short',
    ]);
    expect(listStrategyIdsBySetupFamily('regime_shock_reversion')).toEqual([
      'regime_shock_reversion_short_v2',
    ]);
  });

  it('keeps all Cycle3 active strategies executable', () => {
    expect(listStrategyRegistryEntries()).toEqual([
      expect.objectContaining({
        strategy_id: 'vwap_overnight_reversal_long',
        extraction_ticket: 'QFA-7xx-S1',
        implementation_status: 'active',
      }),
      expect.objectContaining({
        strategy_id: 'vwap_overnight_reversal_short',
        extraction_ticket: 'QFA-7xx-S1',
        implementation_status: 'active',
      }),
      expect.objectContaining({
        strategy_id: 'regime_shock_reversion_short_v2',
        extraction_ticket: 'QFA-7xx-S3-v2',
        implementation_status: 'active',
      }),
    ]);
    expect(listExecutableStrategyIds()).toEqual([
      'vwap_overnight_reversal_long',
      'vwap_overnight_reversal_short',
      'regime_shock_reversion_short_v2',
    ]);
  });

  it('keeps the strategy foundation free of legacy imports and nondeterministic helpers', () => {
    const forbiddenPatterns = [
      /\blegacy_seed\b/,
      /\blegacy_reference\b/,
      /\bsrc\/autotrade\b/,
      /\bDate\.now\b/,
      /\bnew Date\s*\(/,
      /\bMath\.random\b/,
      /\btoLocaleString\b/,
      /\blocaleCompare\b/,
    ];
    const findings = listStrategySourceFiles().flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return forbiddenPatterns
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${file}: ${pattern}`);
    });

    expect(findings).toEqual([]);
  });
});
