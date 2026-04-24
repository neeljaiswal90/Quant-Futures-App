import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigValidationError,
  hashPublicConfig,
  loadAppConfig,
  parsePublicRuntimeConfig,
  type PublicRuntimeConfig,
} from '../../src/config/index.js';

const EXPECTED_EXAMPLE_HASH = '9ae175c4e6d352e6e854f3cdf8eeff6c379725bc35af358939d7cd3e0bd4b48a';

const tempDirs: string[] = [];

function makeTempRoot() {
  const directory = mkdtempSync(join(tmpdir(), 'quant-config-'));
  tempDirs.push(directory);
  return directory;
}

function validConfig(): PublicRuntimeConfig {
  return {
    version: 1,
    app: {
      environment: 'development',
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
      seed: 'mnq-v1-default-seed',
      require_config_hash_match: true,
    },
    paths: {
      journal_dir: 'journals',
      data_dir: 'data',
    },
    strategy_configs: {
      directory: 'config/strategies',
      format: 'yaml',
      required: false,
    },
  };
}

function writeConfig(root: string, config: unknown, fileName = 'app.json') {
  writeFileSync(join(root, fileName), JSON.stringify(config, null, 2));
  return fileName;
}

describe('application config loader', () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('loads valid public config, applies public env overrides, and separates secrets', () => {
    const root = makeTempRoot();
    const configPath = writeConfig(root, validConfig());

    const loaded = loadAppConfig({
      cwd: root,
      configPath,
      env: {
        QFA_APP_ENV: 'test',
        QFA_REPLAY_SEED: 'env-seed',
        DATABENTO_API_KEY: 'db-secret',
        RITHMIC_USERNAME: 'r-user',
        RITHMIC_PASSWORD: 'r-pass',
      },
    });

    expect(loaded.publicConfig.app.environment).toBe('test');
    expect(loaded.publicConfig.replay.seed).toBe('env-seed');
    expect(loaded.secrets.databento_api_key).toBe('db-secret');
    expect(loaded.secrets.rithmic?.username).toBe('r-user');
    expect(loaded.source.public_env_keys).toEqual(['QFA_APP_ENV', 'QFA_REPLAY_SEED']);
    expect(loaded.source.secret_env_keys).toEqual([
      'DATABENTO_API_KEY',
      'RITHMIC_PASSWORD',
      'RITHMIC_USERNAME',
    ]);
    expect(loaded.lineage.config_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.lineage.canonical_config_json).not.toContain('db-secret');
    expect(loaded.lineage.canonical_config_json).not.toContain('r-pass');
  });

  it('rejects invalid execution adapters so live order routing cannot enter V1 config', () => {
    const root = makeTempRoot();
    const config = validConfig();
    writeConfig(root, {
      ...config,
      execution: { adapter: 'live_order_routing' },
    });

    expect(() => loadAppConfig({ cwd: root, configPath: 'app.json', env: {} })).toThrow(
      ConfigValidationError,
    );

    try {
      loadAppConfig({ cwd: root, configPath: 'app.json', env: {} });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).message).toContain('execution.adapter');
    }
  });

  it('reports missing required fields with clear issue paths', () => {
    const root = makeTempRoot();
    const config = validConfig();
    const { instrument: _instrument, ...runtimeWithoutInstrument } = config.runtime;
    writeConfig(root, {
      ...config,
      runtime: runtimeWithoutInstrument,
    });

    expect(() => loadAppConfig({ cwd: root, configPath: 'app.json', env: {} })).toThrow(
      ConfigValidationError,
    );

    try {
      loadAppConfig({ cwd: root, configPath: 'app.json', env: {} });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues).toContainEqual({
        path: 'runtime.instrument',
        message: 'required non-empty string is missing or invalid',
      });
    }
  });

  it('emits a stable public config hash independent of object key insertion order', () => {
    const config = validConfig();
    const reordered = parsePublicRuntimeConfig({
      strategy_configs: config.strategy_configs,
      paths: config.paths,
      replay: config.replay,
      execution: config.execution,
      data: {
        historical_provider: config.data.historical_provider,
        live_provider: config.data.live_provider,
      },
      runtime: {
        timezone: config.runtime.timezone,
        exchange: config.runtime.exchange,
        instrument: config.runtime.instrument,
        mode: config.runtime.mode,
      },
      app: {
        log_level: config.app.log_level,
        environment: config.app.environment,
      },
      version: config.version,
    });

    expect(hashPublicConfig(config)).toBe(EXPECTED_EXAMPLE_HASH);
    expect(hashPublicConfig(reordered)).toBe(EXPECTED_EXAMPLE_HASH);
  });

  it('keeps secret-only changes out of replay lineage hashing', () => {
    const root = makeTempRoot();
    const configPath = writeConfig(root, validConfig());

    const first = loadAppConfig({
      cwd: root,
      configPath,
      env: { DATABENTO_API_KEY: 'secret-a' },
    });
    const second = loadAppConfig({
      cwd: root,
      configPath,
      env: { DATABENTO_API_KEY: 'secret-b' },
    });

    expect(first.lineage.config_hash).toBe(EXPECTED_EXAMPLE_HASH);
    expect(second.lineage.config_hash).toBe(EXPECTED_EXAMPLE_HASH);
  });

  it('requires an explicit config path from options or env', () => {
    expect(() => loadAppConfig({ env: {} })).toThrow(ConfigValidationError);

    try {
      loadAppConfig({ env: {} });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).message).toContain('config_path');
    }
  });
});
