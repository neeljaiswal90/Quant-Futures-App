import { ConfigValidationError } from './errors.js';
import {
  CONFIG_SCHEMA_VERSION,
  type ConfigValidationIssue,
  type PublicRuntimeConfig,
} from './types.js';

const RUNTIME_ENVIRONMENTS = ['development', 'test', 'replay', 'paper'] as const;
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const RUNTIME_MODES = ['simulation'] as const;
const INSTRUMENT_ROOTS = ['MNQ'] as const;
const EXCHANGE_CODES = ['CME'] as const;
const LIVE_DATA_PROVIDERS = ['rithmic'] as const;
const HISTORICAL_DATA_PROVIDERS = ['databento'] as const;
const EXECUTION_ADAPTERS = ['simulated'] as const;
const STRATEGY_CONFIG_FORMATS = ['yaml'] as const;
const RUNTIME_CONFIG_FORMATS = ['yaml'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkUnknownKeys(
  record: Record<string, unknown>,
  path: string,
  allowedKeys: readonly string[],
  issues: ConfigValidationIssue[],
) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record).sort()) {
    if (!allowed.has(key)) {
      issues.push({ path: path ? `${path}.${key}` : key, message: 'unknown field' });
    }
  }
}

function readRecord(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): Record<string, unknown> {
  const value = record[key];
  const childPath = path ? `${path}.${key}` : key;
  if (!isRecord(value)) {
    issues.push({ path: childPath, message: 'required object is missing or invalid' });
    return {};
  }
  return value;
}

function readString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): string {
  const value = record[key];
  const childPath = path ? `${path}.${key}` : key;
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ path: childPath, message: 'required non-empty string is missing or invalid' });
    return '';
  }
  return value;
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): boolean {
  const value = record[key];
  const childPath = path ? `${path}.${key}` : key;
  if (typeof value !== 'boolean') {
    issues.push({ path: childPath, message: 'required boolean is missing or invalid' });
    return false;
  }
  return value;
}

function readLiteral<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  path: string,
  allowedValues: T,
  issues: ConfigValidationIssue[],
): T[number] {
  const value = readString(record, key, path, issues);
  if (value && !allowedValues.includes(value)) {
    const childPath = path ? `${path}.${key}` : key;
    issues.push({
      path: childPath,
      message: `expected one of: ${allowedValues.join(', ')}`,
    });
  }
  return value as T[number];
}

function readVersion(record: Record<string, unknown>, issues: ConfigValidationIssue[]) {
  const value = record['version'];
  if (value !== CONFIG_SCHEMA_VERSION) {
    issues.push({ path: 'version', message: `expected ${CONFIG_SCHEMA_VERSION}` });
  }
  return CONFIG_SCHEMA_VERSION;
}

export function parsePublicRuntimeConfig(input: unknown): PublicRuntimeConfig {
  const issues: ConfigValidationIssue[] = [];

  if (!isRecord(input)) {
    throw new ConfigValidationError([
      { path: '$', message: 'config root must be a JSON object' },
    ]);
  }

  checkUnknownKeys(
    input,
    '',
    [
      'version',
      'app',
      'runtime',
      'data',
      'execution',
      'replay',
      'paths',
      'strategy_configs',
      'risk_config',
      'management_profiles',
    ],
    issues,
  );

  const version = readVersion(input, issues);

  const app = readRecord(input, 'app', '', issues);
  checkUnknownKeys(app, 'app', ['environment', 'log_level'], issues);

  const runtime = readRecord(input, 'runtime', '', issues);
  checkUnknownKeys(runtime, 'runtime', ['mode', 'instrument', 'exchange', 'timezone'], issues);

  const data = readRecord(input, 'data', '', issues);
  checkUnknownKeys(data, 'data', ['live_provider', 'historical_provider'], issues);

  const execution = readRecord(input, 'execution', '', issues);
  checkUnknownKeys(execution, 'execution', ['adapter'], issues);

  const replay = readRecord(input, 'replay', '', issues);
  checkUnknownKeys(replay, 'replay', ['seed', 'require_config_hash_match'], issues);

  const paths = readRecord(input, 'paths', '', issues);
  checkUnknownKeys(paths, 'paths', ['journal_dir', 'data_dir'], issues);

  const strategyConfigs = readRecord(input, 'strategy_configs', '', issues);
  checkUnknownKeys(strategyConfigs, 'strategy_configs', ['directory', 'format', 'required'], issues);

  const riskConfig = readRecord(input, 'risk_config', '', issues);
  checkUnknownKeys(riskConfig, 'risk_config', ['path', 'format', 'required'], issues);

  const managementProfiles = readRecord(input, 'management_profiles', '', issues);
  checkUnknownKeys(managementProfiles, 'management_profiles', ['path', 'format', 'required'], issues);

  const config: PublicRuntimeConfig = {
    version,
    app: {
      environment: readLiteral(app, 'environment', 'app', RUNTIME_ENVIRONMENTS, issues),
      log_level: readLiteral(app, 'log_level', 'app', LOG_LEVELS, issues),
    },
    runtime: {
      mode: readLiteral(runtime, 'mode', 'runtime', RUNTIME_MODES, issues),
      instrument: readLiteral(runtime, 'instrument', 'runtime', INSTRUMENT_ROOTS, issues),
      exchange: readLiteral(runtime, 'exchange', 'runtime', EXCHANGE_CODES, issues),
      timezone: readString(runtime, 'timezone', 'runtime', issues),
    },
    data: {
      live_provider: readLiteral(data, 'live_provider', 'data', LIVE_DATA_PROVIDERS, issues),
      historical_provider: readLiteral(
        data,
        'historical_provider',
        'data',
        HISTORICAL_DATA_PROVIDERS,
        issues,
      ),
    },
    execution: {
      adapter: readLiteral(execution, 'adapter', 'execution', EXECUTION_ADAPTERS, issues),
    },
    replay: {
      seed: readString(replay, 'seed', 'replay', issues),
      require_config_hash_match: readBoolean(
        replay,
        'require_config_hash_match',
        'replay',
        issues,
      ),
    },
    paths: {
      journal_dir: readString(paths, 'journal_dir', 'paths', issues),
      data_dir: readString(paths, 'data_dir', 'paths', issues),
    },
    strategy_configs: {
      directory: readString(strategyConfigs, 'directory', 'strategy_configs', issues),
      format: readLiteral(
        strategyConfigs,
        'format',
        'strategy_configs',
        STRATEGY_CONFIG_FORMATS,
        issues,
      ),
      required: readBoolean(strategyConfigs, 'required', 'strategy_configs', issues),
    },
    risk_config: {
      path: readString(riskConfig, 'path', 'risk_config', issues),
      format: readLiteral(riskConfig, 'format', 'risk_config', RUNTIME_CONFIG_FORMATS, issues),
      required: readBoolean(riskConfig, 'required', 'risk_config', issues),
    },
    management_profiles: {
      path: readString(managementProfiles, 'path', 'management_profiles', issues),
      format: readLiteral(
        managementProfiles,
        'format',
        'management_profiles',
        RUNTIME_CONFIG_FORMATS,
        issues,
      ),
      required: readBoolean(managementProfiles, 'required', 'management_profiles', issues),
    },
  };

  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }

  return config;
}
