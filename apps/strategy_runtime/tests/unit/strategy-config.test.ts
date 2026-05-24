import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigValidationError,
  DEFAULT_STRATEGY_RUNTIME_CONFIG,
  loadAppConfig,
  loadStrategyRuntimeConfig,
  type PublicRuntimeConfig,
  type StrategyRuntimeConfig,
} from '../../src/config/index.js';
import { makeCandidateId } from '../../src/contracts/index.js';
import {
  generateBreakoutRetestLong,
  rankCandidates,
} from '../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

const EXPECTED_STRATEGY_CONFIG_HASH =
  'db4c3a6eb916e58a42c14a6d1d75904f99b6f2caac11d04a87f9240efeff2aed';

const STRATEGY_CONFIG_FILES = [
  'shared.yaml',
  'trend_pullback_long.yaml',
  'trend_pullback_short.yaml',
  'breakout_retest_long.yaml',
  'breakdown_retest_short.yaml',
  'regime_mean_reversion_long.yaml',
  'regime_mean_reversion_short.yaml',
  'liquidity_sweep_reversal_long.yaml',
  'liquidity_sweep_reversal_short.yaml',
  'vwap_overnight_reversal_long.yaml',
  'vwap_overnight_reversal_short.yaml',
  'regime_shock_reversion_short_v2.yaml',
  'regime_shock_reversion_short_v3.yaml',
] as const;

const tempDirs: string[] = [];

function makeTempRoot() {
  const directory = mkdtempSync(join(tmpdir(), 'quant-strategy-config-'));
  tempDirs.push(directory);
  return directory;
}

function copyStrategyConfigs(destination: string) {
  for (const file of STRATEGY_CONFIG_FILES) {
    copyFileSync(join(process.cwd(), 'config/strategies', file), join(destination, file));
  }
}

function validAppConfig(strategyConfigDirectory: string): PublicRuntimeConfig {
  return {
    version: 1,
    app: {
      environment: 'test',
      log_level: 'info',
    },
    runtime: {
      mode: 'simulation',
      instrument: 'MNQ',
      exchange: 'CME',
      timezone: 'America/Chicago',
    },
    data: {
      live_provider: 'rithmic',
      historical_provider: 'databento',
    },
    execution: {
      adapter: 'simulated',
    },
    replay: {
      seed: 'strategy-config-test-seed',
      require_config_hash_match: true,
    },
    paths: {
      journal_dir: 'journals',
      data_dir: 'data',
    },
    strategy_configs: {
      directory: strategyConfigDirectory,
      format: 'yaml',
      required: true,
    },
    risk_config: {
      path: 'config/risk/risk-policy.yaml',
      format: 'yaml',
      required: false,
    },
    management_profiles: {
      path: 'config/management/profiles.yaml',
      format: 'yaml',
      required: false,
    },
  };
}

function withStrategyConfig(
  overrides: Partial<StrategyRuntimeConfig>,
): StrategyRuntimeConfig {
  return {
    ...DEFAULT_STRATEGY_RUNTIME_CONFIG,
    ...overrides,
  };
}

describe('STRAT-07 strategy config surface', () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('loads the committed strategy YAML files with stable lineage hash output', () => {
    const config = loadStrategyRuntimeConfig({
      cwd: process.cwd(),
      directory: 'config/strategies',
      required: true,
    });

    expect(config.version).toBe(1);
    expect(config.strategies.breakout_retest_long.max_retest_distance_sigma).toBe(0.85);
    expect(config.strategies.breakdown_retest_short.max_retest_distance_sigma).toBe(1.15);
    expect(config.strategies.regime_mean_reversion_long.vwap_reference).toBe('session_vwap');
    expect(config.strategies.regime_mean_reversion_short.low_shock_threshold_pos).toBe(1.75);
    expect(config.strategies.liquidity_sweep_reversal_long.pre_committed_retirement).toBe(true);
    expect(config.strategies.liquidity_sweep_reversal_short.allowed_regimes).toEqual([
      'high',
      'mid',
      'low',
    ]);
    expect(config.strategies.vwap_overnight_reversal_long.target_1_anchor).toBe('vwap_touch');
    expect(config.strategies.vwap_overnight_reversal_short.exclude_first_minutes).toBe(15);
    expect(config.strategies.regime_shock_reversion_short_v2.high_shock_threshold_pos).toBe(2);
    expect(config.strategies.regime_shock_reversion_short_v2.low_shock_threshold_pos).toBe(2.7);
    expect(config.strategies.regime_shock_reversion_short_v3.vix_pct_overfire_lower_bound).toBe(0.67);
    expect(config.strategies.regime_shock_reversion_short_v3.vix_pct_overfire_upper_bound).toBe(0.85);
    expect(config.ranking.strategy_priority).toEqual({
      trend_pullback_long: 10,
      trend_pullback_short: 20,
      breakout_retest_long: 30,
      breakdown_retest_short: 40,
      regime_mean_reversion_long: 50,
      regime_mean_reversion_short: 60,
      liquidity_sweep_reversal_long: 70,
      liquidity_sweep_reversal_short: 80,
      vwap_overnight_reversal_long: 90,
      vwap_overnight_reversal_short: 100,
      regime_shock_reversion_short_v2: 110,
      regime_shock_reversion_short_v3: 120,
    });
    expect(config.lineage.strategy_config_hash).toBe(EXPECTED_STRATEGY_CONFIG_HASH);
    expect(config.lineage.canonical_strategy_config_json).toContain(
      '"method":"deterministic_v1_confidence_rr_risk_tiebreak_v1"',
    );
  });

  it('loads strategy configs during app startup when required=true', () => {
    const root = makeTempRoot();
    const configPath = join(root, 'app.json');
    writeFileSync(
      configPath,
      JSON.stringify(validAppConfig('config/strategies'), null, 2),
    );

    const loaded = loadAppConfig({
      cwd: process.cwd(),
      configPath,
      env: {},
    });

    expect(loaded.strategyConfig?.lineage.strategy_config_hash).toBe(EXPECTED_STRATEGY_CONFIG_HASH);
    expect(loaded.lineage.config_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects unknown fields and missing required numeric thresholds with clear paths', () => {
    const root = makeTempRoot();
    copyStrategyConfigs(root);
    writeFileSync(join(root, 'trend_pullback_long.yaml'), [
      'version: 1',
      'strategy_id: trend_pullback_long',
      'parameters:',
      '  z_ema9_min: 0.15',
      '  z_ema9_max: 1.25',
      '  pullback_ratio_min: 0.25',
      '  pullback_ratio_max: 0.62',
      '  flow_confirmation_min: 0.2',
      '  entry_half_band_sigma: 0.1',
      '  stop_sigma_multiple: 1.05',
      '  minimum_target_rr: 1',
      '  default_target_1_rr: 2',
      '  unexpected_knob: 99',
      '  base_confidence_score: 8.1',
      '',
    ].join('\n'));

    expect(() => loadStrategyRuntimeConfig({
      directory: root,
      required: true,
    })).toThrow(ConfigValidationError);

    try {
      loadStrategyRuntimeConfig({ directory: root, required: true });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues).toEqual(
        expect.arrayContaining([
          { path: '$.parameters.default_target_2_rr', message: 'required finite number is missing or invalid' },
          { path: '$.parameters.unexpected_knob', message: 'unknown field' },
        ]),
      );
    }
  });

  it('lets strategy generators consume loaded threshold overrides explicitly', () => {
    const strictConfig = withStrategyConfig({
      strategies: {
        ...DEFAULT_STRATEGY_RUNTIME_CONFIG.strategies,
        breakout_retest_long: {
          ...DEFAULT_STRATEGY_RUNTIME_CONFIG.strategies.breakout_retest_long,
          flow_confirmation_min: 0.99,
        },
      },
    });

    const result = generateBreakoutRetestLong({
      strategy_id: 'breakout_retest_long',
      snapshot: STRATEGY_SYNTHETIC_FIXTURES.breakout_retest_long.snapshot,
      strategy_config: strictConfig,
    });

    expect(result.candidate).toBeUndefined();
    expect(result.evaluation.reasons[0]).toBe(
      'breakout_retest_long:flow_confirmation_below_threshold',
    );
  });

  it('lets ranking consume configured tie-break priority explicitly', () => {
    const baseCandidate = generateBreakoutRetestLong({
      strategy_id: 'breakout_retest_long',
      snapshot: STRATEGY_SYNTHETIC_FIXTURES.breakout_retest_long.snapshot,
    }).candidate;
    if (baseCandidate === undefined) {
      throw new Error('expected breakout fixture candidate');
    }
    const longCandidate = {
      ...baseCandidate,
      candidate_id: makeCandidateId('candidate-long'),
      strategy_id: 'trend_pullback_long' as const,
      setup_type: 'trend_pullback_long' as const,
    };
    const shortCandidate = {
      ...baseCandidate,
      candidate_id: makeCandidateId('candidate-short'),
      strategy_id: 'breakdown_retest_short' as const,
      setup_type: 'breakdown_retest_short' as const,
    };

    const defaultRank = rankCandidates({
      candidates: [shortCandidate, longCandidate],
    });
    const configuredRank = rankCandidates({
      candidates: [shortCandidate, longCandidate],
      ranking_config: {
        ...DEFAULT_STRATEGY_RUNTIME_CONFIG.ranking,
        strategy_priority: {
          ...DEFAULT_STRATEGY_RUNTIME_CONFIG.ranking.strategy_priority,
          trend_pullback_long: 40,
          breakdown_retest_short: 1,
        },
      },
    });

    expect(defaultRank.ranked_candidate_ids).toEqual(['candidate-long', 'candidate-short']);
    expect(configuredRank.ranked_candidate_ids).toEqual(['candidate-short', 'candidate-long']);
  });
});
