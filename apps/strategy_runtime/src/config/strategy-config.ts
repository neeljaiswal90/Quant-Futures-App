import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StrategyId } from '../contracts/strategy-ids.js';
import { CONFIG_HASH_ALGORITHM, type ConfigValidationIssue } from './types.js';
import { ConfigValidationError } from './errors.js';
import { stableStringify } from './hash.js';

export const STRATEGY_CONFIG_SCHEMA_VERSION = 1 as const;
export const STRATEGY_CONFIG_HASH_ALGORITHM = CONFIG_HASH_ALGORITHM;
export const CANDIDATE_RANKING_METHOD = 'deterministic_v1_confidence_rr_risk_tiebreak_v1' as const;

export interface TrendPullbackStrategyParameters {
  readonly z_ema9_min: number;
  readonly z_ema9_max: number;
  readonly pullback_ratio_min: number;
  readonly pullback_ratio_max: number;
  readonly flow_confirmation_min: number;
  readonly entry_half_band_sigma: number;
  readonly stop_sigma_multiple: number;
  readonly minimum_target_rr: number;
  readonly default_target_1_rr: number;
  readonly default_target_2_rr: number;
  readonly base_confidence_score: number;
}

export interface BreakoutRetestStrategyParameters {
  readonly max_retest_distance_sigma: number;
  readonly flow_confirmation_min: number;
  readonly stop_ema21_sigma_buffer: number;
  readonly entry_low_sigma_buffer: number;
  readonly entry_high_sigma_buffer: number;
  readonly minimum_target_1_rr: number;
  readonly minimum_target_2_rr: number;
  readonly default_target_1_rr: number;
  readonly default_target_2_rr: number;
  readonly confidence_score: number;
}

export type RegimeMeanReversionVwapReference =
  | 'session_vwap'
  | 'opening_window_vwap'
  | 'prior_day_close';

export interface RegimeMeanReversionStrategyParameters {
  readonly vwap_reference: RegimeMeanReversionVwapReference;
  readonly opening_window_minutes: number;
  readonly high_shock_threshold_neg: number;
  readonly high_shock_threshold_pos: number;
  readonly low_shock_threshold_neg: number;
  readonly low_shock_threshold_pos: number;
  readonly stop_sigma_multiple: number;
  readonly target_1_rr: number;
  readonly target_2_rr: number;
  readonly confidence_score_high: number;
  readonly confidence_score_low: number;
  readonly minimum_target_rr: number;
}

export interface CandidateRankingParameters {
  readonly method: typeof CANDIDATE_RANKING_METHOD;
  readonly confidence_weight: number;
  readonly pt1_reward_risk_weight: number;
  readonly pt2_reward_risk_weight: number;
  readonly max_reward_risk_weight: number;
  readonly risk_points_penalty_weight: number;
  readonly strategy_priority: Readonly<Record<StrategyId, number>>;
}

export interface StrategyConfigById {
  readonly trend_pullback_long: TrendPullbackStrategyParameters;
  readonly trend_pullback_short: TrendPullbackStrategyParameters;
  readonly breakout_retest_long: BreakoutRetestStrategyParameters;
  readonly breakdown_retest_short: BreakoutRetestStrategyParameters;
  readonly regime_mean_reversion_long: RegimeMeanReversionStrategyParameters;
  readonly regime_mean_reversion_short: RegimeMeanReversionStrategyParameters;
}

export interface StrategyConfigLineage {
  readonly strategy_config_version: typeof STRATEGY_CONFIG_SCHEMA_VERSION;
  readonly strategy_config_hash: string;
  readonly strategy_config_hash_algorithm: typeof STRATEGY_CONFIG_HASH_ALGORITHM;
  readonly canonical_strategy_config_json: string;
}

export interface StrategyRuntimeConfig {
  readonly version: typeof STRATEGY_CONFIG_SCHEMA_VERSION;
  readonly strategies: StrategyConfigById;
  readonly ranking: CandidateRankingParameters;
  readonly lineage: StrategyConfigLineage;
  readonly source_files: readonly string[];
}

export interface LoadStrategyRuntimeConfigOptions {
  readonly directory: string;
  readonly cwd?: string;
  readonly required?: boolean;
}

export const DEFAULT_TREND_PULLBACK_LONG_CONFIG: TrendPullbackStrategyParameters = {
  z_ema9_min: 0.15,
  z_ema9_max: 1.25,
  pullback_ratio_min: 0.25,
  pullback_ratio_max: 0.62,
  flow_confirmation_min: 0.2,
  entry_half_band_sigma: 0.1,
  stop_sigma_multiple: 1.05,
  minimum_target_rr: 1,
  default_target_1_rr: 2,
  default_target_2_rr: 4,
  base_confidence_score: 8.1,
};

export const DEFAULT_TREND_PULLBACK_SHORT_CONFIG: TrendPullbackStrategyParameters = {
  ...DEFAULT_TREND_PULLBACK_LONG_CONFIG,
  base_confidence_score: 8.05,
};

export const DEFAULT_BREAKOUT_RETEST_LONG_CONFIG: BreakoutRetestStrategyParameters = {
  max_retest_distance_sigma: 0.85,
  flow_confirmation_min: 0.2,
  stop_ema21_sigma_buffer: 0.5,
  entry_low_sigma_buffer: 0.1,
  entry_high_sigma_buffer: 0.15,
  minimum_target_1_rr: 1,
  minimum_target_2_rr: 0,
  default_target_1_rr: 2,
  default_target_2_rr: 4,
  confidence_score: 8.1,
};

export const DEFAULT_BREAKDOWN_RETEST_SHORT_CONFIG: BreakoutRetestStrategyParameters = {
  ...DEFAULT_BREAKOUT_RETEST_LONG_CONFIG,
  max_retest_distance_sigma: 1.15,
  entry_low_sigma_buffer: 0.15,
  entry_high_sigma_buffer: 0.1,
  confidence_score: 8.05,
};

export const DEFAULT_REGIME_MEAN_REVERSION_LONG_CONFIG: RegimeMeanReversionStrategyParameters = {
  vwap_reference: 'session_vwap',
  opening_window_minutes: 30,
  high_shock_threshold_neg: 1.25,
  high_shock_threshold_pos: 1.4,
  low_shock_threshold_neg: 1.75,
  low_shock_threshold_pos: 1.9,
  stop_sigma_multiple: 0.8,
  target_1_rr: 1.2,
  target_2_rr: 2,
  confidence_score_high: 0.72,
  confidence_score_low: 0.58,
  minimum_target_rr: 1,
};

export const DEFAULT_REGIME_MEAN_REVERSION_SHORT_CONFIG: RegimeMeanReversionStrategyParameters = {
  ...DEFAULT_REGIME_MEAN_REVERSION_LONG_CONFIG,
  high_shock_threshold_neg: 1.4,
  high_shock_threshold_pos: 1.25,
  low_shock_threshold_neg: 1.9,
  low_shock_threshold_pos: 1.75,
  confidence_score_high: 0.71,
  confidence_score_low: 0.57,
};

export const DEFAULT_CANDIDATE_RANKING_CONFIG: CandidateRankingParameters = {
  method: CANDIDATE_RANKING_METHOD,
  confidence_weight: 100,
  pt1_reward_risk_weight: 10,
  pt2_reward_risk_weight: 2,
  max_reward_risk_weight: 1,
  risk_points_penalty_weight: 0.01,
  strategy_priority: {
    trend_pullback_long: 10,
    trend_pullback_short: 20,
    breakout_retest_long: 30,
    breakdown_retest_short: 40,
    regime_mean_reversion_long: 50,
    regime_mean_reversion_short: 60,
  },
};

export const DEFAULT_STRATEGY_CONFIGS: StrategyConfigById = {
  trend_pullback_long: DEFAULT_TREND_PULLBACK_LONG_CONFIG,
  trend_pullback_short: DEFAULT_TREND_PULLBACK_SHORT_CONFIG,
  breakout_retest_long: DEFAULT_BREAKOUT_RETEST_LONG_CONFIG,
  breakdown_retest_short: DEFAULT_BREAKDOWN_RETEST_SHORT_CONFIG,
  regime_mean_reversion_long: DEFAULT_REGIME_MEAN_REVERSION_LONG_CONFIG,
  regime_mean_reversion_short: DEFAULT_REGIME_MEAN_REVERSION_SHORT_CONFIG,
};

export const DEFAULT_STRATEGY_RUNTIME_CONFIG = buildStrategyRuntimeConfig(
  DEFAULT_STRATEGY_CONFIGS,
  DEFAULT_CANDIDATE_RANKING_CONFIG,
  [],
);

const STRATEGY_CONFIG_FILE_NAMES = {
  trend_pullback_long: 'trend_pullback_long.yaml',
  trend_pullback_short: 'trend_pullback_short.yaml',
  breakout_retest_long: 'breakout_retest_long.yaml',
  breakdown_retest_short: 'breakdown_retest_short.yaml',
  regime_mean_reversion_long: 'regime_mean_reversion_long.yaml',
  regime_mean_reversion_short: 'regime_mean_reversion_short.yaml',
} as const satisfies Record<StrategyId, string>;

export function loadStrategyRuntimeConfig(
  options: LoadStrategyRuntimeConfigOptions,
): StrategyRuntimeConfig {
  const cwd = options.cwd ?? process.cwd();
  const directory = resolve(cwd, options.directory);
  if (!existsSync(directory)) {
    if (options.required === false) {
      return DEFAULT_STRATEGY_RUNTIME_CONFIG;
    }
    throw new ConfigValidationError([
      { path: 'strategy_configs.directory', message: `cannot read ${directory}` },
    ], 'Invalid strategy config');
  }

  const sourceFiles: string[] = [];
  const shared = parseSharedStrategyConfig(readYamlFile(resolve(directory, 'shared.yaml'), sourceFiles));
  const strategies: StrategyConfigById = {
    trend_pullback_long: parseTrendPullbackConfig(
      'trend_pullback_long',
      readYamlFile(resolve(directory, STRATEGY_CONFIG_FILE_NAMES.trend_pullback_long), sourceFiles),
    ),
    trend_pullback_short: parseTrendPullbackConfig(
      'trend_pullback_short',
      readYamlFile(resolve(directory, STRATEGY_CONFIG_FILE_NAMES.trend_pullback_short), sourceFiles),
    ),
    breakout_retest_long: parseBreakoutRetestConfig(
      'breakout_retest_long',
      readYamlFile(resolve(directory, STRATEGY_CONFIG_FILE_NAMES.breakout_retest_long), sourceFiles),
    ),
    breakdown_retest_short: parseBreakoutRetestConfig(
      'breakdown_retest_short',
      readYamlFile(resolve(directory, STRATEGY_CONFIG_FILE_NAMES.breakdown_retest_short), sourceFiles),
    ),
    regime_mean_reversion_long: parseRegimeMeanReversionConfig(
      'regime_mean_reversion_long',
      readYamlFile(resolve(directory, STRATEGY_CONFIG_FILE_NAMES.regime_mean_reversion_long), sourceFiles),
    ),
    regime_mean_reversion_short: parseRegimeMeanReversionConfig(
      'regime_mean_reversion_short',
      readYamlFile(resolve(directory, STRATEGY_CONFIG_FILE_NAMES.regime_mean_reversion_short), sourceFiles),
    ),
  };

  return buildStrategyRuntimeConfig(strategies, shared.ranking, sourceFiles.sort());
}

export function getStrategyParameters(
  config: StrategyRuntimeConfig | undefined,
  strategyId: 'trend_pullback_long',
): TrendPullbackStrategyParameters;
export function getStrategyParameters(
  config: StrategyRuntimeConfig | undefined,
  strategyId: 'trend_pullback_short',
): TrendPullbackStrategyParameters;
export function getStrategyParameters(
  config: StrategyRuntimeConfig | undefined,
  strategyId: 'breakout_retest_long',
): BreakoutRetestStrategyParameters;
export function getStrategyParameters(
  config: StrategyRuntimeConfig | undefined,
  strategyId: 'breakdown_retest_short',
): BreakoutRetestStrategyParameters;
export function getStrategyParameters(
  config: StrategyRuntimeConfig | undefined,
  strategyId: 'regime_mean_reversion_long',
): RegimeMeanReversionStrategyParameters;
export function getStrategyParameters(
  config: StrategyRuntimeConfig | undefined,
  strategyId: 'regime_mean_reversion_short',
): RegimeMeanReversionStrategyParameters;
export function getStrategyParameters(
  config: StrategyRuntimeConfig | undefined,
  strategyId: StrategyId,
): TrendPullbackStrategyParameters | BreakoutRetestStrategyParameters | RegimeMeanReversionStrategyParameters {
  return (config ?? DEFAULT_STRATEGY_RUNTIME_CONFIG).strategies[strategyId];
}

export function getCandidateRankingParameters(
  config: StrategyRuntimeConfig | undefined,
): CandidateRankingParameters {
  return (config ?? DEFAULT_STRATEGY_RUNTIME_CONFIG).ranking;
}

export function canonicalizeStrategyRuntimeConfig(config: StrategyRuntimeConfig): string {
  return stableStringify({
    version: config.version,
    strategies: config.strategies,
    ranking: config.ranking,
  });
}

export function hashStrategyRuntimeConfig(config: StrategyRuntimeConfig): string {
  return createHash(STRATEGY_CONFIG_HASH_ALGORITHM)
    .update(canonicalizeStrategyRuntimeConfig(config), 'utf8')
    .digest('hex');
}

function buildStrategyRuntimeConfig(
  strategies: StrategyConfigById,
  ranking: CandidateRankingParameters,
  sourceFiles: readonly string[],
): StrategyRuntimeConfig {
  const configWithoutLineage = {
    version: STRATEGY_CONFIG_SCHEMA_VERSION,
    strategies,
    ranking,
  };
  const canonical = stableStringify(configWithoutLineage);
  const hash = createHash(STRATEGY_CONFIG_HASH_ALGORITHM).update(canonical, 'utf8').digest('hex');
  return {
    ...configWithoutLineage,
    lineage: {
      strategy_config_version: STRATEGY_CONFIG_SCHEMA_VERSION,
      strategy_config_hash: hash,
      strategy_config_hash_algorithm: STRATEGY_CONFIG_HASH_ALGORITHM,
      canonical_strategy_config_json: canonical,
    },
    source_files: sourceFiles,
  };
}

function readYamlFile(path: string, sourceFiles: string[]): unknown {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError([
      { path, message: `cannot read strategy config: ${message}` },
    ], 'Invalid strategy config');
  }
  sourceFiles.push(path);
  return parseSimpleYaml(contents, path);
}

function parseSharedStrategyConfig(input: unknown): { readonly ranking: CandidateRankingParameters } {
  const issues: ConfigValidationIssue[] = [];
  const root = requireRecord(input, '$', issues);
  checkUnknownKeys(root, '$', ['version', 'ranking'], issues);
  readVersion(root, '$', issues);
  const ranking = readRecord(root, 'ranking', '$', issues);
  checkUnknownKeys(ranking, '$.ranking', [
    'method',
    'confidence_weight',
    'pt1_reward_risk_weight',
    'pt2_reward_risk_weight',
    'max_reward_risk_weight',
    'risk_points_penalty_weight',
    'strategy_priority',
  ], issues);
  const strategyPriority = readRecord(ranking, 'strategy_priority', '$.ranking', issues);
  checkUnknownKeys(strategyPriority, '$.ranking.strategy_priority', [
    'trend_pullback_long',
    'trend_pullback_short',
    'breakout_retest_long',
    'breakdown_retest_short',
    'regime_mean_reversion_long',
    'regime_mean_reversion_short',
  ], issues);

  const parsed = {
    ranking: {
      method: readLiteral(ranking, 'method', '$.ranking', [CANDIDATE_RANKING_METHOD], issues),
      confidence_weight: readNumber(ranking, 'confidence_weight', '$.ranking', issues),
      pt1_reward_risk_weight: readNumber(ranking, 'pt1_reward_risk_weight', '$.ranking', issues),
      pt2_reward_risk_weight: readNumber(ranking, 'pt2_reward_risk_weight', '$.ranking', issues),
      max_reward_risk_weight: readNumber(ranking, 'max_reward_risk_weight', '$.ranking', issues),
      risk_points_penalty_weight: readNumber(ranking, 'risk_points_penalty_weight', '$.ranking', issues),
      strategy_priority: {
        trend_pullback_long: readNumber(strategyPriority, 'trend_pullback_long', '$.ranking.strategy_priority', issues),
        trend_pullback_short: readNumber(strategyPriority, 'trend_pullback_short', '$.ranking.strategy_priority', issues),
        breakout_retest_long: readNumber(strategyPriority, 'breakout_retest_long', '$.ranking.strategy_priority', issues),
        breakdown_retest_short: readNumber(strategyPriority, 'breakdown_retest_short', '$.ranking.strategy_priority', issues),
        regime_mean_reversion_long: readNumber(strategyPriority, 'regime_mean_reversion_long', '$.ranking.strategy_priority', issues),
        regime_mean_reversion_short: readNumber(strategyPriority, 'regime_mean_reversion_short', '$.ranking.strategy_priority', issues),
      },
    },
  };

  throwIfIssues(issues);
  return parsed;
}

function parseTrendPullbackConfig(
  strategyId: 'trend_pullback_long' | 'trend_pullback_short',
  input: unknown,
): TrendPullbackStrategyParameters {
  const issues: ConfigValidationIssue[] = [];
  const { root, parameters } = parseStrategyConfigRoot(strategyId, input, issues);
  void root;
  checkUnknownKeys(parameters, '$.parameters', [
    'z_ema9_min',
    'z_ema9_max',
    'pullback_ratio_min',
    'pullback_ratio_max',
    'flow_confirmation_min',
    'entry_half_band_sigma',
    'stop_sigma_multiple',
    'minimum_target_rr',
    'default_target_1_rr',
    'default_target_2_rr',
    'base_confidence_score',
  ], issues);
  const parsed = {
    z_ema9_min: readPositiveNumber(parameters, 'z_ema9_min', '$.parameters', issues),
    z_ema9_max: readPositiveNumber(parameters, 'z_ema9_max', '$.parameters', issues),
    pullback_ratio_min: readPositiveNumber(parameters, 'pullback_ratio_min', '$.parameters', issues),
    pullback_ratio_max: readPositiveNumber(parameters, 'pullback_ratio_max', '$.parameters', issues),
    flow_confirmation_min: readNumber(parameters, 'flow_confirmation_min', '$.parameters', issues),
    entry_half_band_sigma: readPositiveNumber(parameters, 'entry_half_band_sigma', '$.parameters', issues),
    stop_sigma_multiple: readPositiveNumber(parameters, 'stop_sigma_multiple', '$.parameters', issues),
    minimum_target_rr: readPositiveNumber(parameters, 'minimum_target_rr', '$.parameters', issues),
    default_target_1_rr: readPositiveNumber(parameters, 'default_target_1_rr', '$.parameters', issues),
    default_target_2_rr: readPositiveNumber(parameters, 'default_target_2_rr', '$.parameters', issues),
    base_confidence_score: readPositiveNumber(parameters, 'base_confidence_score', '$.parameters', issues),
  };
  if (parsed.z_ema9_min > parsed.z_ema9_max) {
    issues.push({ path: '$.parameters.z_ema9_min', message: 'must be <= z_ema9_max' });
  }
  if (parsed.pullback_ratio_min > parsed.pullback_ratio_max) {
    issues.push({ path: '$.parameters.pullback_ratio_min', message: 'must be <= pullback_ratio_max' });
  }
  throwIfIssues(issues);
  return parsed;
}

function parseBreakoutRetestConfig(
  strategyId: 'breakout_retest_long' | 'breakdown_retest_short',
  input: unknown,
): BreakoutRetestStrategyParameters {
  const issues: ConfigValidationIssue[] = [];
  const { root, parameters } = parseStrategyConfigRoot(strategyId, input, issues);
  void root;
  checkUnknownKeys(parameters, '$.parameters', [
    'max_retest_distance_sigma',
    'flow_confirmation_min',
    'stop_ema21_sigma_buffer',
    'entry_low_sigma_buffer',
    'entry_high_sigma_buffer',
    'minimum_target_1_rr',
    'minimum_target_2_rr',
    'default_target_1_rr',
    'default_target_2_rr',
    'confidence_score',
  ], issues);
  const parsed = {
    max_retest_distance_sigma: readPositiveNumber(parameters, 'max_retest_distance_sigma', '$.parameters', issues),
    flow_confirmation_min: readNumber(parameters, 'flow_confirmation_min', '$.parameters', issues),
    stop_ema21_sigma_buffer: readPositiveNumber(parameters, 'stop_ema21_sigma_buffer', '$.parameters', issues),
    entry_low_sigma_buffer: readPositiveNumber(parameters, 'entry_low_sigma_buffer', '$.parameters', issues),
    entry_high_sigma_buffer: readPositiveNumber(parameters, 'entry_high_sigma_buffer', '$.parameters', issues),
    minimum_target_1_rr: readPositiveNumber(parameters, 'minimum_target_1_rr', '$.parameters', issues),
    minimum_target_2_rr: readNonNegativeNumber(parameters, 'minimum_target_2_rr', '$.parameters', issues),
    default_target_1_rr: readPositiveNumber(parameters, 'default_target_1_rr', '$.parameters', issues),
    default_target_2_rr: readPositiveNumber(parameters, 'default_target_2_rr', '$.parameters', issues),
    confidence_score: readPositiveNumber(parameters, 'confidence_score', '$.parameters', issues),
  };
  throwIfIssues(issues);
  return parsed;
}

function parseRegimeMeanReversionConfig(
  strategyId: 'regime_mean_reversion_long' | 'regime_mean_reversion_short',
  input: unknown,
): RegimeMeanReversionStrategyParameters {
  const issues: ConfigValidationIssue[] = [];
  const { root, parameters } = parseStrategyConfigRoot(strategyId, input, issues);
  void root;
  checkUnknownKeys(parameters, '$.parameters', [
    'vwap_reference',
    'opening_window_minutes',
    'high_shock_threshold_neg',
    'high_shock_threshold_pos',
    'low_shock_threshold_neg',
    'low_shock_threshold_pos',
    'stop_sigma_multiple',
    'target_1_rr',
    'target_2_rr',
    'confidence_score_high',
    'confidence_score_low',
    'minimum_target_rr',
  ], issues);
  const parsed = {
    vwap_reference: readLiteral(parameters, 'vwap_reference', '$.parameters', [
      'session_vwap',
      'opening_window_vwap',
      'prior_day_close',
    ], issues),
    opening_window_minutes: readPositiveNumber(parameters, 'opening_window_minutes', '$.parameters', issues),
    high_shock_threshold_neg: readPositiveNumber(parameters, 'high_shock_threshold_neg', '$.parameters', issues),
    high_shock_threshold_pos: readPositiveNumber(parameters, 'high_shock_threshold_pos', '$.parameters', issues),
    low_shock_threshold_neg: readPositiveNumber(parameters, 'low_shock_threshold_neg', '$.parameters', issues),
    low_shock_threshold_pos: readPositiveNumber(parameters, 'low_shock_threshold_pos', '$.parameters', issues),
    stop_sigma_multiple: readPositiveNumber(parameters, 'stop_sigma_multiple', '$.parameters', issues),
    target_1_rr: readPositiveNumber(parameters, 'target_1_rr', '$.parameters', issues),
    target_2_rr: readPositiveNumber(parameters, 'target_2_rr', '$.parameters', issues),
    confidence_score_high: readPositiveNumber(parameters, 'confidence_score_high', '$.parameters', issues),
    confidence_score_low: readPositiveNumber(parameters, 'confidence_score_low', '$.parameters', issues),
    minimum_target_rr: readPositiveNumber(parameters, 'minimum_target_rr', '$.parameters', issues),
  };
  if (!Number.isInteger(parsed.opening_window_minutes)) {
    issues.push({ path: '$.parameters.opening_window_minutes', message: 'must be an integer' });
  }
  if (parsed.low_shock_threshold_neg <= parsed.high_shock_threshold_neg) {
    issues.push({
      path: '$.parameters.low_shock_threshold_neg',
      message: 'must be > high_shock_threshold_neg',
    });
  }
  if (parsed.low_shock_threshold_pos <= parsed.high_shock_threshold_pos) {
    issues.push({
      path: '$.parameters.low_shock_threshold_pos',
      message: 'must be > high_shock_threshold_pos',
    });
  }
  if (parsed.confidence_score_low >= parsed.confidence_score_high) {
    issues.push({
      path: '$.parameters.confidence_score_low',
      message: 'must be < confidence_score_high',
    });
  }
  if (parsed.target_1_rr < parsed.minimum_target_rr) {
    issues.push({ path: '$.parameters.target_1_rr', message: 'must be >= minimum_target_rr' });
  }
  if (parsed.target_2_rr < parsed.target_1_rr) {
    issues.push({ path: '$.parameters.target_2_rr', message: 'must be >= target_1_rr' });
  }
  throwIfIssues(issues);
  return parsed;
}

function parseStrategyConfigRoot(
  strategyId: StrategyId,
  input: unknown,
  issues: ConfigValidationIssue[],
) {
  const root = requireRecord(input, '$', issues);
  checkUnknownKeys(root, '$', ['version', 'strategy_id', 'parameters'], issues);
  readVersion(root, '$', issues);
  readLiteral(root, 'strategy_id', '$', [strategyId], issues);
  const parameters = readRecord(root, 'parameters', '$', issues);
  return { root, parameters };
}

function parseSimpleYaml(contents: string, filePath: string): unknown {
  const root: Record<string, unknown> = {};
  const stack: Array<{ readonly indent: number; readonly object: Record<string, unknown> }> = [
    { indent: 0, object: root },
  ];

  const lines = contents.replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const withoutComment = stripYamlComment(rawLine);
    if (withoutComment.trim() === '') {
      return;
    }
    const match = /^(\s*)([A-Za-z0-9_]+):(?:\s*(.*))?$/.exec(withoutComment);
    if (match === null) {
      throw new ConfigValidationError([
        { path: `${filePath}:${index + 1}`, message: 'unsupported YAML line' },
      ], 'Invalid strategy config');
    }
    const indent = match[1]!.length;
    if (indent % 2 !== 0) {
      throw new ConfigValidationError([
        { path: `${filePath}:${index + 1}`, message: 'indentation must use two-space levels' },
      ], 'Invalid strategy config');
    }

    while (stack.length > 1 && indent < stack[stack.length - 1]!.indent) {
      stack.pop();
    }
    const frame = stack[stack.length - 1]!;
    if (indent !== frame.indent) {
      throw new ConfigValidationError([
        { path: `${filePath}:${index + 1}`, message: 'unsupported YAML indentation jump' },
      ], 'Invalid strategy config');
    }

    const key = match[2]!;
    const rawValue = match[3] ?? '';
    if (rawValue.trim() === '') {
      const child: Record<string, unknown> = {};
      frame.object[key] = child;
      stack.push({ indent: indent + 2, object: child });
      return;
    }
    frame.object[key] = parseYamlScalar(rawValue.trim());
  });

  return root;
}

function stripYamlComment(line: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && quote === undefined) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = undefined;
      continue;
    }
    if (char === '#' && quote === undefined && (index === 0 || line[index - 1] === ' ')) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseYamlScalar(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    return Number(value);
  }
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function requireRecord(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path, message: 'required object is missing or invalid' });
    return {};
  }
  return value as Record<string, unknown>;
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
      issues.push({ path: `${path}.${key}`, message: 'unknown field' });
    }
  }
}

function readRecord(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): Record<string, unknown> {
  return requireRecord(record[key], `${path}.${key}`, issues);
}

function readVersion(record: Record<string, unknown>, path: string, issues: ConfigValidationIssue[]) {
  const value = record['version'];
  if (value !== STRATEGY_CONFIG_SCHEMA_VERSION) {
    issues.push({ path: `${path}.version`, message: `expected ${STRATEGY_CONFIG_SCHEMA_VERSION}` });
  }
}

function readLiteral<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  path: string,
  allowedValues: T,
  issues: ConfigValidationIssue[],
): T[number] {
  const value = record[key];
  if (typeof value !== 'string' || !allowedValues.includes(value)) {
    issues.push({ path: `${path}.${key}`, message: `expected one of: ${allowedValues.join(', ')}` });
  }
  return value as T[number];
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ path: `${path}.${key}`, message: 'required finite number is missing or invalid' });
    return 0;
  }
  return value;
}

function readPositiveNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): number {
  const value = readNumber(record, key, path, issues);
  if (!(value > 0)) {
    issues.push({ path: `${path}.${key}`, message: 'must be > 0' });
  }
  return value;
}

function readNonNegativeNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): number {
  const value = readNumber(record, key, path, issues);
  if (value < 0) {
    issues.push({ path: `${path}.${key}`, message: 'must be >= 0' });
  }
  return value;
}

function throwIfIssues(issues: ConfigValidationIssue[]) {
  if (issues.length > 0) {
    throw new ConfigValidationError(
      issues.sort((left, right) => (
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0
      )),
      'Invalid strategy config',
    );
  }
}
