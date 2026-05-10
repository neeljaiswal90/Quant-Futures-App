import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigValidationError } from '../../src/config/index.js';
import {
  computeManagementProfileHash,
  loadManagementProfilesConfig,
  type ManagementProfile,
} from '../../src/management/index.js';
import {
  computeRiskConfigHash,
  loadRiskPolicyConfig,
} from '../../src/risk/index.js';

const tempDirs: string[] = [];

function makeTempRoot() {
  const directory = mkdtempSync(join(tmpdir(), 'quant-cfg-01-'));
  tempDirs.push(directory);
  return directory;
}

function writeTempFile(contents: string, fileName: string): { readonly root: string; readonly fileName: string } {
  const root = makeTempRoot();
  writeFileSync(join(root, fileName), contents);
  return { root, fileName };
}

describe('CFG-01 risk and management config lineage', () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('loads and validates the committed risk YAML with stable lineage', () => {
    const loaded = loadRiskPolicyConfig({
      cwd: process.cwd(),
      path: 'config/risk/risk-policy.yaml',
      required: true,
    });

    expect(loaded.policy.default_regime).toBe('mixed');
    expect(loaded.policy.session.max_open_trade_count).toBe(3);
    expect(loaded.lineage.risk_config_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(computeRiskConfigHash(loaded)).toBe(loaded.lineage.risk_config_hash);
  });

  it('rejects invalid risk YAML with clear issue paths', () => {
    const source = readFileSync('config/risk/risk-policy.yaml', 'utf8')
      .replace('default_regime: mixed', 'default_regime: moon');
    const { root, fileName } = writeTempFile(source, 'risk-policy.yaml');

    expect(() => loadRiskPolicyConfig({ cwd: root, path: fileName, required: true })).toThrow(
      ConfigValidationError,
    );
    try {
      loadRiskPolicyConfig({ cwd: root, path: fileName, required: true });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues).toContainEqual({
        path: '$.default_regime',
        message: 'expected one of: strong_trend, mixed, chop, unknown',
      });
    }
  });

  it('keeps risk_config_hash stable across YAML key reordering', () => {
    const reordered = `version: 1
sizing:
  regime_scores:
    unknown: 0.3
    chop: 0.3
    mixed: 0.5
    strong_trend: 0.9
  slippage_buffer_points: 0.75
  gamma: 0.75
  d_min: 0.25
  liq_increase_cooldown_ms: 30000
  liq_hysteresis_cycles: 3
  eta_liq: 0.07
  c_agreement_placeholder: 0.8
  c_calibration_placeholder: 0.7
  c_support_k: 100
  C_base: 100
  C_abs: 10
session:
  reset_circuit_breaker_on_new_session: true
  circuit_breaker_enabled: true
  max_trades_per_session: 12
  max_open_trade_count: 3
  max_daily_realized_loss_usd: 500
default_n_eff: 10000
default_regime: mixed
sizing_mode: replay
hard_cap_contracts: 10
hard_position_cap: 10
min_reward_risk: 1
max_daily_loss_pct: 1.0
max_risk_per_trade_pct: 0.25
account_equity_usd: 50000
`;
    const { root, fileName } = writeTempFile(reordered, 'risk-reordered.yaml');
    const canonical = loadRiskPolicyConfig({
      cwd: process.cwd(),
      path: 'config/risk/risk-policy.yaml',
      required: true,
    });
    const loaded = loadRiskPolicyConfig({ cwd: root, path: fileName, required: true });

    expect(loaded.lineage.risk_config_hash).toBe(canonical.lineage.risk_config_hash);
  });

  it('loads and validates the committed management YAML with profile hashes', () => {
    const loaded = loadManagementProfilesConfig({
      cwd: process.cwd(),
      path: 'config/management/profiles.yaml',
      required: true,
    });

    expect(loaded.profiles.trend_pullback_long.profile_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.lineage.profile_hashes.trend_pullback_long).toBe(
      loaded.profiles.trend_pullback_long.profile_hash,
    );
    expect(loaded.lineage.management_config_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects invalid management profile partial sizing', () => {
    const source = readFileSync('config/management/profiles.yaml', 'utf8')
      .replace('runner_fraction: 0', 'runner_fraction: 0.2');
    const { root, fileName } = writeTempFile(source, 'profiles.yaml');

    expect(() => loadManagementProfilesConfig({ cwd: root, path: fileName, required: true })).toThrow(
      ConfigValidationError,
    );
    try {
      loadManagementProfilesConfig({ cwd: root, path: fileName, required: true });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).message).toContain('partial_exit');
    }
  });

  it('rejects invalid management trailing settings', () => {
    const source = readFileSync('config/management/profiles.yaml', 'utf8')
      .replace('mode: post_pt1_ticks', 'mode: sideways');
    const { root, fileName } = writeTempFile(source, 'profiles.yaml');

    expect(() => loadManagementProfilesConfig({ cwd: root, path: fileName, required: true })).toThrow(
      ConfigValidationError,
    );
    try {
      loadManagementProfilesConfig({ cwd: root, path: fileName, required: true });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues).toContainEqual({
        path: '$.profiles.trend_pullback_long.trailing_stop.mode',
        message: 'expected one of: disabled, post_pt1_ticks, post_pt1_sigma',
      });
    }
  });

  it('rejects invalid management target ordering', () => {
    const source = readFileSync('config/management/profiles.yaml', 'utf8')
      .replace('minimum_reward_risk: 1.5', 'minimum_reward_risk: 0.5');
    const { root, fileName } = writeTempFile(source, 'profiles.yaml');

    expect(() => loadManagementProfilesConfig({ cwd: root, path: fileName, required: true })).toThrow(
      ConfigValidationError,
    );
    try {
      loadManagementProfilesConfig({ cwd: root, path: fileName, required: true });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues).toContainEqual({
        path: '$.profiles.trend_pullback_long.targets',
        message: 'pt2 minimum_reward_risk must be >= pt1 minimum_reward_risk',
      });
    }
  });

  it('keeps management_profile_hash stable across object key reordering', () => {
    const loaded = loadManagementProfilesConfig({
      cwd: process.cwd(),
      path: 'config/management/profiles.yaml',
      required: true,
    });
    const profile = loaded.profiles.breakout_retest_long;
    const reordered = {
      reasons: profile.reasons,
      partial_exit: profile.partial_exit,
      fail_safe: profile.fail_safe,
      time_stop: profile.time_stop,
      trailing_stop: profile.trailing_stop,
      break_even: profile.break_even,
      targets: profile.targets,
      initial_stop: profile.initial_stop,
      profile_hash: profile.profile_hash,
      display_name: profile.display_name,
      setup_family: profile.setup_family,
      strategy_id: profile.strategy_id,
      profile_version: profile.profile_version,
      profile_id: profile.profile_id,
    } satisfies ManagementProfile;

    expect(computeManagementProfileHash(reordered)).toBe(profile.profile_hash);
  });
});
