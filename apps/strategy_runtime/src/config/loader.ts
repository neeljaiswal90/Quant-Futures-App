import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigValidationError } from './errors.js';
import {
  applyPublicEnvOverrides,
  resolveConfigPath,
  resolveSecretConfig,
} from './env.js';
import { buildConfigLineage } from './hash.js';
import { loadStrategyRuntimeConfig } from './strategy-config.js';
import { loadRiskPolicyConfig } from '../risk/risk-policy-config.js';
import { loadManagementProfilesConfig } from '../management/management-config.js';
import type { EnvRecord, LoadedAppConfig } from './types.js';
import { parsePublicRuntimeConfig } from './validation.js';

export interface LoadAppConfigOptions {
  configPath?: string;
  cwd?: string;
  env?: EnvRecord;
}

function parseJsonConfig(contents: string, configPath: string): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError([
      { path: 'config_file', message: `failed to parse ${configPath}: ${message}` },
    ]);
  }
}

export function loadAppConfig(options: LoadAppConfigOptions = {}): LoadedAppConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const requestedConfigPath = resolveConfigPath(env, options.configPath);
  const configPath = resolve(cwd, requestedConfigPath);

  let contents: string;
  try {
    contents = readFileSync(configPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError([
      { path: 'config_path', message: `cannot read ${configPath}: ${message}` },
    ]);
  }

  const fileConfig = parsePublicRuntimeConfig(parseJsonConfig(contents, configPath));
  const { config: envConfig, appliedEnvKeys } = applyPublicEnvOverrides(fileConfig, env);
  const publicConfig = parsePublicRuntimeConfig(envConfig);
  const { secrets, secretEnvKeys } = resolveSecretConfig(env);
  const strategyConfig = publicConfig.strategy_configs.required
    ? loadStrategyRuntimeConfig({
      cwd,
      directory: publicConfig.strategy_configs.directory,
      required: true,
    })
    : undefined;
  const riskConfig = publicConfig.risk_config.required
    ? loadRiskPolicyConfig({
      cwd,
      path: publicConfig.risk_config.path,
      required: true,
    })
    : undefined;
  const managementProfiles = publicConfig.management_profiles.required
    ? loadManagementProfilesConfig({
      cwd,
      path: publicConfig.management_profiles.path,
      required: true,
    })
    : undefined;

  return {
    publicConfig,
    secrets,
    ...(strategyConfig === undefined ? {} : { strategyConfig }),
    ...(riskConfig === undefined ? {} : { riskConfig }),
    ...(managementProfiles === undefined ? {} : { managementProfiles }),
    lineage: buildConfigLineage(publicConfig),
    source: {
      config_path: configPath,
      public_env_keys: appliedEnvKeys.sort(),
      secret_env_keys: secretEnvKeys.sort(),
    },
  };
}
