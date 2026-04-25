import { ConfigValidationError } from './errors.js';
import type {
  EnvRecord,
  PublicRuntimeConfig,
  SecretRuntimeConfig,
} from './types.js';

export const CONFIG_PATH_ENV_KEYS = ['QFA_CONFIG', 'QFA_CONFIG_PATH'] as const;

export const PUBLIC_CONFIG_ENV_KEYS = [
  'QFA_APP_ENV',
  'QFA_LOG_LEVEL',
  'QFA_RUNTIME_MODE',
  'QFA_INSTRUMENT',
  'QFA_EXCHANGE',
  'QFA_RUNTIME_TIMEZONE',
  'QFA_LIVE_DATA_PROVIDER',
  'QFA_HISTORICAL_DATA_PROVIDER',
  'QFA_EXECUTION_ADAPTER',
  'QFA_REPLAY_SEED',
  'QFA_REQUIRE_CONFIG_HASH_MATCH',
  'QFA_JOURNAL_DIR',
  'QFA_DATA_DIR',
  'QFA_STRATEGY_CONFIG_DIR',
  'QFA_STRATEGY_CONFIG_FORMAT',
  'QFA_REQUIRE_STRATEGY_CONFIGS',
  'QFA_RISK_CONFIG_PATH',
  'QFA_REQUIRE_RISK_CONFIG',
  'QFA_MANAGEMENT_PROFILES_PATH',
  'QFA_REQUIRE_MANAGEMENT_PROFILES',
] as const;

export const SECRET_ENV_KEYS = [
  'DATABENTO_API_KEY',
  'RITHMIC_USERNAME',
  'RITHMIC_PASSWORD',
  'RITHMIC_SYSTEM_NAME',
  'RITHMIC_APP_NAME',
] as const;

function cloneConfig(config: PublicRuntimeConfig): PublicRuntimeConfig {
  return {
    version: config.version,
    app: { ...config.app },
    runtime: { ...config.runtime },
    data: { ...config.data },
    execution: { ...config.execution },
    replay: { ...config.replay },
    paths: { ...config.paths },
    strategy_configs: { ...config.strategy_configs },
    risk_config: { ...config.risk_config },
    management_profiles: { ...config.management_profiles },
  };
}

function parseBooleanEnv(key: string, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new ConfigValidationError([
    { path: `env.${key}`, message: 'expected boolean value true/false/1/0/yes/no/on/off' },
  ]);
}

function readEnv(env: EnvRecord, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value === '' ? undefined : value;
}

export function resolveConfigPath(env: EnvRecord, explicitConfigPath?: string): string {
  const configPath =
    explicitConfigPath ?? readEnv(env, 'QFA_CONFIG') ?? readEnv(env, 'QFA_CONFIG_PATH');

  if (!configPath) {
    throw new ConfigValidationError([
      { path: 'config_path', message: 'set QFA_CONFIG, QFA_CONFIG_PATH, or pass configPath' },
    ]);
  }

  return configPath;
}

export function applyPublicEnvOverrides(
  config: PublicRuntimeConfig,
  env: EnvRecord,
): { config: PublicRuntimeConfig; appliedEnvKeys: string[] } {
  const next = cloneConfig(config);
  const appliedEnvKeys: string[] = [];

  function setString(key: string, apply: (value: string) => void) {
    const value = readEnv(env, key);
    if (value === undefined) {
      return;
    }
    apply(value);
    appliedEnvKeys.push(key);
  }

  function setBoolean(key: string, apply: (value: boolean) => void) {
    const value = readEnv(env, key);
    if (value === undefined) {
      return;
    }
    apply(parseBooleanEnv(key, value));
    appliedEnvKeys.push(key);
  }

  setString('QFA_APP_ENV', (value) => {
    next.app.environment = value as PublicRuntimeConfig['app']['environment'];
  });
  setString('QFA_LOG_LEVEL', (value) => {
    next.app.log_level = value as PublicRuntimeConfig['app']['log_level'];
  });
  setString('QFA_RUNTIME_MODE', (value) => {
    next.runtime.mode = value as PublicRuntimeConfig['runtime']['mode'];
  });
  setString('QFA_INSTRUMENT', (value) => {
    next.runtime.instrument = value as PublicRuntimeConfig['runtime']['instrument'];
  });
  setString('QFA_EXCHANGE', (value) => {
    next.runtime.exchange = value as PublicRuntimeConfig['runtime']['exchange'];
  });
  setString('QFA_RUNTIME_TIMEZONE', (value) => {
    next.runtime.timezone = value;
  });
  setString('QFA_LIVE_DATA_PROVIDER', (value) => {
    next.data.live_provider = value as PublicRuntimeConfig['data']['live_provider'];
  });
  setString('QFA_HISTORICAL_DATA_PROVIDER', (value) => {
    next.data.historical_provider = value as PublicRuntimeConfig['data']['historical_provider'];
  });
  setString('QFA_EXECUTION_ADAPTER', (value) => {
    next.execution.adapter = value as PublicRuntimeConfig['execution']['adapter'];
  });
  setString('QFA_REPLAY_SEED', (value) => {
    next.replay.seed = value;
  });
  setBoolean('QFA_REQUIRE_CONFIG_HASH_MATCH', (value) => {
    next.replay.require_config_hash_match = value;
  });
  setString('QFA_JOURNAL_DIR', (value) => {
    next.paths.journal_dir = value;
  });
  setString('QFA_DATA_DIR', (value) => {
    next.paths.data_dir = value;
  });
  setString('QFA_STRATEGY_CONFIG_DIR', (value) => {
    next.strategy_configs.directory = value;
  });
  setString('QFA_STRATEGY_CONFIG_FORMAT', (value) => {
    next.strategy_configs.format = value as PublicRuntimeConfig['strategy_configs']['format'];
  });
  setBoolean('QFA_REQUIRE_STRATEGY_CONFIGS', (value) => {
    next.strategy_configs.required = value;
  });
  setString('QFA_RISK_CONFIG_PATH', (value) => {
    next.risk_config.path = value;
  });
  setBoolean('QFA_REQUIRE_RISK_CONFIG', (value) => {
    next.risk_config.required = value;
  });
  setString('QFA_MANAGEMENT_PROFILES_PATH', (value) => {
    next.management_profiles.path = value;
  });
  setBoolean('QFA_REQUIRE_MANAGEMENT_PROFILES', (value) => {
    next.management_profiles.required = value;
  });

  return { config: next, appliedEnvKeys };
}

export function resolveSecretConfig(
  env: EnvRecord,
): { secrets: SecretRuntimeConfig; secretEnvKeys: string[] } {
  const secretEnvKeys: string[] = [];
  const secrets: SecretRuntimeConfig = {};

  const databentoApiKey = readEnv(env, 'DATABENTO_API_KEY');
  if (databentoApiKey !== undefined) {
    secrets.databento_api_key = databentoApiKey;
    secretEnvKeys.push('DATABENTO_API_KEY');
  }

  const rithmicUsername = readEnv(env, 'RITHMIC_USERNAME');
  const rithmicPassword = readEnv(env, 'RITHMIC_PASSWORD');
  const rithmicSystemName = readEnv(env, 'RITHMIC_SYSTEM_NAME');
  const rithmicAppName = readEnv(env, 'RITHMIC_APP_NAME');

  if (
    rithmicUsername !== undefined ||
    rithmicPassword !== undefined ||
    rithmicSystemName !== undefined ||
    rithmicAppName !== undefined
  ) {
    secrets.rithmic = {};
    if (rithmicUsername !== undefined) {
      secrets.rithmic.username = rithmicUsername;
      secretEnvKeys.push('RITHMIC_USERNAME');
    }
    if (rithmicPassword !== undefined) {
      secrets.rithmic.password = rithmicPassword;
      secretEnvKeys.push('RITHMIC_PASSWORD');
    }
    if (rithmicSystemName !== undefined) {
      secrets.rithmic.system_name = rithmicSystemName;
      secretEnvKeys.push('RITHMIC_SYSTEM_NAME');
    }
    if (rithmicAppName !== undefined) {
      secrets.rithmic.app_name = rithmicAppName;
      secretEnvKeys.push('RITHMIC_APP_NAME');
    }
  }

  return { secrets, secretEnvKeys };
}
