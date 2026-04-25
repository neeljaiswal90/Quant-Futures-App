import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigValidationError } from '../config/errors.js';
import { stableStringify } from '../config/hash.js';
import {
  checkUnknownKeys,
  parseSimpleYaml,
  readBoolean,
  readLiteral,
  readNonNegativeNumber,
  readPositiveNumber,
  readRecord,
  requireRecord,
  throwIfIssues,
} from '../config/simple-yaml.js';
import { CONFIG_HASH_ALGORITHM, type ConfigValidationIssue } from '../config/types.js';
import {
  PHASE1_SIZING_DEFAULTS,
  type Phase1SizingConfig,
  type SizerExecutionMode,
} from './composed-sizer.js';
import {
  DEFAULT_RISK_POLICY,
  resolveRiskPolicy,
  type RiskPolicyConfig,
  type RiskRegime,
} from './risk-manager.js';
import type { SessionRiskPolicy } from './account-risk-arbiter.js';

export const RISK_CONFIG_SCHEMA_VERSION = 1 as const;
export const RISK_CONFIG_HASH_ALGORITHM = CONFIG_HASH_ALGORITHM;
export const RISK_REGIMES = ['strong_trend', 'mixed', 'chop', 'unknown'] as const satisfies readonly RiskRegime[];
const SIZING_MODES = ['simulation', 'replay', 'signal_only'] as const satisfies readonly SizerExecutionMode[];

export interface RiskConfigLineage {
  readonly risk_config_version: typeof RISK_CONFIG_SCHEMA_VERSION;
  readonly risk_config_hash: string;
  readonly risk_config_hash_algorithm: typeof RISK_CONFIG_HASH_ALGORITHM;
  readonly canonical_risk_config_json: string;
}

export interface LoadedRiskPolicyConfig {
  readonly version: typeof RISK_CONFIG_SCHEMA_VERSION;
  readonly policy: RiskPolicyConfig;
  readonly lineage: RiskConfigLineage;
  readonly source_file: string;
}

export interface LoadRiskPolicyConfigOptions {
  readonly path: string;
  readonly cwd?: string;
  readonly required?: boolean;
}

export function loadRiskPolicyConfig(
  options: LoadRiskPolicyConfigOptions,
): LoadedRiskPolicyConfig {
  const cwd = options.cwd ?? process.cwd();
  const path = resolve(cwd, options.path);
  if (!existsSync(path)) {
    if (options.required === false) {
      return buildRiskPolicyConfig(DEFAULT_RISK_POLICY, path);
    }
    throw new ConfigValidationError([
      { path: 'risk_config.path', message: `cannot read ${path}` },
    ], 'Invalid risk config');
  }

  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError([
      { path: 'risk_config.path', message: `cannot read ${path}: ${message}` },
    ], 'Invalid risk config');
  }

  return parseRiskPolicyConfig(parseSimpleYaml(contents, path, 'Invalid risk config'), path);
}

export function validateRiskPolicyConfig(
  input: RiskPolicyConfig | LoadedRiskPolicyConfig,
): readonly ConfigValidationIssue[] {
  const policy = 'policy' in input ? input.policy : input;
  const issues: ConfigValidationIssue[] = [];
  validatePositive(policy.account_equity_usd, '$.account_equity_usd', issues);
  validatePositive(policy.max_risk_per_trade_pct, '$.max_risk_per_trade_pct', issues);
  validatePositive(policy.max_daily_loss_pct, '$.max_daily_loss_pct', issues);
  validatePositive(policy.min_reward_risk, '$.min_reward_risk', issues);
  validatePositive(policy.max_net_position_per_symbol, '$.hard_position_cap', issues);
  validatePositive(policy.hard_cap_contracts, '$.hard_cap_contracts', issues);
  validatePositive(policy.default_n_eff, '$.default_n_eff', issues);
  if (!RISK_REGIMES.includes(policy.default_regime)) {
    issues.push({ path: '$.default_regime', message: `expected one of: ${RISK_REGIMES.join(', ')}` });
  }
  validateSessionPolicy(policy.session, issues);
  validateSizingPolicy(policy.sizing, issues);
  return issues.sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
}

export function canonicalizeRiskPolicyConfig(config: LoadedRiskPolicyConfig | RiskPolicyConfig): string {
  const policy = 'policy' in config ? config.policy : config;
  return stableStringify({
    version: RISK_CONFIG_SCHEMA_VERSION,
    policy,
  });
}

export function computeRiskConfigHash(config: LoadedRiskPolicyConfig | RiskPolicyConfig): string {
  return createHash(RISK_CONFIG_HASH_ALGORITHM)
    .update(canonicalizeRiskPolicyConfig(config), 'utf8')
    .digest('hex');
}

function parseRiskPolicyConfig(input: unknown, sourceFile: string): LoadedRiskPolicyConfig {
  const issues: ConfigValidationIssue[] = [];
  const root = requireRecord(input, '$', issues);
  checkUnknownKeys(root, '$', [
    'version',
    'account_equity_usd',
    'max_risk_per_trade_pct',
    'max_daily_loss_pct',
    'min_reward_risk',
    'hard_position_cap',
    'hard_cap_contracts',
    'sizing_mode',
    'default_regime',
    'default_n_eff',
    'session',
    'sizing',
  ], issues);
  readVersion(root, '$', issues);

  const session = readRecord(root, 'session', '$', issues);
  checkUnknownKeys(session, '$.session', [
    'max_daily_realized_loss_usd',
    'max_open_trade_count',
    'max_trades_per_session',
    'circuit_breaker_enabled',
    'reset_circuit_breaker_on_new_session',
  ], issues);

  const sizing = readRecord(root, 'sizing', '$', issues);
  checkUnknownKeys(sizing, '$.sizing', [
    'C_abs',
    'C_base',
    'c_support_k',
    'c_calibration_placeholder',
    'c_agreement_placeholder',
    'eta_liq',
    'liq_hysteresis_cycles',
    'liq_increase_cooldown_ms',
    'd_min',
    'gamma',
    'slippage_buffer_points',
    'regime_scores',
  ], issues);
  const regimeScores = readRecord(sizing, 'regime_scores', '$.sizing', issues);
  checkUnknownKeys(regimeScores, '$.sizing.regime_scores', RISK_REGIMES, issues);

  const parsed: RiskPolicyConfig = resolveRiskPolicy({
    account_equity_usd: readPositiveNumber(root, 'account_equity_usd', '$', issues),
    max_risk_per_trade_pct: readPositiveNumber(root, 'max_risk_per_trade_pct', '$', issues),
    max_daily_loss_pct: readPositiveNumber(root, 'max_daily_loss_pct', '$', issues),
    min_reward_risk: readPositiveNumber(root, 'min_reward_risk', '$', issues),
    max_net_position_per_symbol: readPositiveNumber(root, 'hard_position_cap', '$', issues),
    hard_cap_contracts: readPositiveNumber(root, 'hard_cap_contracts', '$', issues),
    sizing_mode: readLiteral(root, 'sizing_mode', '$', SIZING_MODES, issues),
    default_regime: readLiteral(root, 'default_regime', '$', RISK_REGIMES, issues),
    default_n_eff: readPositiveNumber(root, 'default_n_eff', '$', issues),
    session: parseSessionPolicy(session, issues),
    sizing: parseSizingPolicy(sizing, regimeScores, issues),
  });

  const validationIssues = validateRiskPolicyConfig(parsed);
  issues.push(...validationIssues);
  throwIfIssues(issues, 'Invalid risk config');
  return buildRiskPolicyConfig(parsed, sourceFile);
}

function buildRiskPolicyConfig(policy: RiskPolicyConfig, sourceFile: string): LoadedRiskPolicyConfig {
  const canonical = canonicalizeRiskPolicyConfig(policy);
  const hash = createHash(RISK_CONFIG_HASH_ALGORITHM).update(canonical, 'utf8').digest('hex');
  return {
    version: RISK_CONFIG_SCHEMA_VERSION,
    policy,
    lineage: {
      risk_config_version: RISK_CONFIG_SCHEMA_VERSION,
      risk_config_hash: hash,
      risk_config_hash_algorithm: RISK_CONFIG_HASH_ALGORITHM,
      canonical_risk_config_json: canonical,
    },
    source_file: sourceFile,
  };
}

function parseSessionPolicy(
  record: Record<string, unknown>,
  issues: ConfigValidationIssue[],
): SessionRiskPolicy {
  return {
    max_daily_realized_loss_usd: readPositiveNumber(record, 'max_daily_realized_loss_usd', '$.session', issues),
    max_open_trade_count: readPositiveNumber(record, 'max_open_trade_count', '$.session', issues),
    max_trades_per_session: readPositiveNumber(record, 'max_trades_per_session', '$.session', issues),
    circuit_breaker_enabled: readBoolean(record, 'circuit_breaker_enabled', '$.session', issues),
    reset_circuit_breaker_on_new_session: readBoolean(record, 'reset_circuit_breaker_on_new_session', '$.session', issues),
  };
}

function parseSizingPolicy(
  record: Record<string, unknown>,
  regimeScores: Record<string, unknown>,
  issues: ConfigValidationIssue[],
): Phase1SizingConfig {
  return {
    C_abs: readPositiveNumber(record, 'C_abs', '$.sizing', issues),
    C_base: readPositiveNumber(record, 'C_base', '$.sizing', issues),
    c_support_k: readPositiveNumber(record, 'c_support_k', '$.sizing', issues),
    c_calibration_placeholder: readPositiveNumber(record, 'c_calibration_placeholder', '$.sizing', issues),
    c_agreement_placeholder: readPositiveNumber(record, 'c_agreement_placeholder', '$.sizing', issues),
    eta_liq: readPositiveNumber(record, 'eta_liq', '$.sizing', issues),
    liq_hysteresis_cycles: readPositiveNumber(record, 'liq_hysteresis_cycles', '$.sizing', issues),
    liq_increase_cooldown_ms: readPositiveNumber(record, 'liq_increase_cooldown_ms', '$.sizing', issues),
    d_min: readPositiveNumber(record, 'd_min', '$.sizing', issues),
    gamma: readPositiveNumber(record, 'gamma', '$.sizing', issues),
    slippage_buffer_points: readNonNegativeNumber(record, 'slippage_buffer_points', '$.sizing', issues),
    regime_scores: {
      strong_trend: readPositiveNumber(regimeScores, 'strong_trend', '$.sizing.regime_scores', issues),
      mixed: readPositiveNumber(regimeScores, 'mixed', '$.sizing.regime_scores', issues),
      chop: readPositiveNumber(regimeScores, 'chop', '$.sizing.regime_scores', issues),
      unknown: readPositiveNumber(regimeScores, 'unknown', '$.sizing.regime_scores', issues),
    },
  };
}

function readVersion(
  record: Record<string, unknown>,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  if (record['version'] !== RISK_CONFIG_SCHEMA_VERSION) {
    issues.push({ path: `${path}.version`, message: `expected ${RISK_CONFIG_SCHEMA_VERSION}` });
  }
}

function validateSessionPolicy(policy: SessionRiskPolicy, issues: ConfigValidationIssue[]): void {
  validatePositive(policy.max_daily_realized_loss_usd, '$.session.max_daily_realized_loss_usd', issues);
  validatePositive(policy.max_open_trade_count, '$.session.max_open_trade_count', issues);
  validatePositive(policy.max_trades_per_session, '$.session.max_trades_per_session', issues);
  if (policy.max_trades_per_session < policy.max_open_trade_count) {
    issues.push({
      path: '$.session.max_trades_per_session',
      message: 'must be >= max_open_trade_count',
    });
  }
}

function validateSizingPolicy(policy: Phase1SizingConfig, issues: ConfigValidationIssue[]): void {
  for (const [key, value] of Object.entries(policy.regime_scores)) {
    validatePositive(value, `$.sizing.regime_scores.${key}`, issues);
  }
  for (const key of [
    'C_abs',
    'C_base',
    'c_support_k',
    'c_calibration_placeholder',
    'c_agreement_placeholder',
    'eta_liq',
    'liq_hysteresis_cycles',
    'liq_increase_cooldown_ms',
    'd_min',
    'gamma',
  ] as const) {
    validatePositive(policy[key], `$.sizing.${key}`, issues);
  }
  if (policy.slippage_buffer_points < 0) {
    issues.push({ path: '$.sizing.slippage_buffer_points', message: 'must be >= 0' });
  }
}

function validatePositive(
  value: number,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  if (!Number.isFinite(value) || value <= 0) {
    issues.push({ path, message: 'must be > 0' });
  }
}
