export const CONFIG_SCHEMA_VERSION = 1 as const;
export const CONFIG_HASH_ALGORITHM = 'sha256' as const;

export type RuntimeEnvironment = 'development' | 'test' | 'replay' | 'paper';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type RuntimeMode = 'simulation';
export type InstrumentRoot = 'MNQ';
export type ExchangeCode = 'CME';
export type LiveMarketDataProvider = 'rithmic';
export type HistoricalDataProvider = 'databento';
export type ExecutionAdapter = 'simulated';
export type StrategyConfigFormat = 'yaml';

export interface PublicRuntimeConfig {
  version: typeof CONFIG_SCHEMA_VERSION;
  app: {
    environment: RuntimeEnvironment;
    log_level: LogLevel;
  };
  runtime: {
    mode: RuntimeMode;
    instrument: InstrumentRoot;
    exchange: ExchangeCode;
    timezone: string;
  };
  data: {
    live_provider: LiveMarketDataProvider;
    historical_provider: HistoricalDataProvider;
  };
  execution: {
    adapter: ExecutionAdapter;
  };
  replay: {
    seed: string;
    require_config_hash_match: boolean;
  };
  paths: {
    journal_dir: string;
    data_dir: string;
  };
  strategy_configs: {
    directory: string;
    format: StrategyConfigFormat;
    required: boolean;
  };
}

export interface SecretRuntimeConfig {
  databento_api_key?: string;
  rithmic?: {
    username?: string;
    password?: string;
    system_name?: string;
    app_name?: string;
  };
}

export interface ConfigLineage {
  config_version: typeof CONFIG_SCHEMA_VERSION;
  config_hash: string;
  config_hash_algorithm: typeof CONFIG_HASH_ALGORITHM;
  canonical_config_json: string;
}

export interface ConfigSource {
  config_path: string;
  public_env_keys: string[];
  secret_env_keys: string[];
}

export interface LoadedAppConfig {
  publicConfig: PublicRuntimeConfig;
  secrets: SecretRuntimeConfig;
  lineage: ConfigLineage;
  source: ConfigSource;
}

export interface ConfigValidationIssue {
  path: string;
  message: string;
}

export type EnvRecord = Record<string, string | undefined>;
