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
  readString,
  requireRecord,
  throwIfIssues,
} from '../config/simple-yaml.js';
import { CONFIG_HASH_ALGORITHM, type ConfigValidationIssue } from '../config/types.js';
import { ACTIVE_STRATEGY_IDS, type ActiveStrategyId } from '../contracts/strategy-ids.js';
import {
  FALLBACK_MANAGEMENT_PROFILE,
  V1_MANAGEMENT_PROFILES,
} from './management-profiles.js';
import {
  MANAGEMENT_PROFILE_VERSION,
  assertValidManagementProfile,
  validateManagementProfile,
  type BreakEvenPolicy,
  type FailSafePolicy,
  type InitialStopBehavior,
  type ManagementProfile,
  type ManagementProfileId,
  type ManagementProfileStrategyId,
  type PartialExitSizing,
  type TargetExitBehavior,
  type TimeStopPolicy,
  type TrailingStopPolicy,
} from './types.js';

export const MANAGEMENT_CONFIG_SCHEMA_VERSION = 1 as const;
export const MANAGEMENT_CONFIG_HASH_ALGORITHM = CONFIG_HASH_ALGORITHM;

export interface ManagementConfigLineage {
  readonly management_config_version: typeof MANAGEMENT_CONFIG_SCHEMA_VERSION;
  readonly management_config_hash: string;
  readonly management_config_hash_algorithm: typeof MANAGEMENT_CONFIG_HASH_ALGORITHM;
  readonly canonical_management_config_json: string;
  readonly profile_hashes: Readonly<Record<ActiveStrategyId | 'fallback', string>>;
}

export interface ManagementProfilesConfig {
  readonly version: typeof MANAGEMENT_CONFIG_SCHEMA_VERSION;
  readonly profiles: Readonly<Record<ActiveStrategyId, ManagementProfile>>;
  readonly fallback_profile: ManagementProfile;
  readonly lineage: ManagementConfigLineage;
  readonly source_file: string;
}

export interface LoadManagementProfilesConfigOptions {
  readonly path: string;
  readonly cwd?: string;
  readonly required?: boolean;
}

export function loadManagementProfilesConfig(
  options: LoadManagementProfilesConfigOptions,
): ManagementProfilesConfig {
  const cwd = options.cwd ?? process.cwd();
  const path = resolve(cwd, options.path);
  if (!existsSync(path)) {
    if (options.required === false) {
      return DEFAULT_MANAGEMENT_PROFILES_CONFIG;
    }
    throw new ConfigValidationError([
      { path: 'management_profiles.path', message: `cannot read ${path}` },
    ], 'Invalid management config');
  }

  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError([
      { path: 'management_profiles.path', message: `cannot read ${path}: ${message}` },
    ], 'Invalid management config');
  }

  return parseManagementProfilesConfig(
    parseSimpleYaml(contents, path, 'Invalid management config'),
    path,
  );
}

export function validateManagementProfilesConfig(
  config: ManagementProfilesConfig,
): readonly ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  for (const strategyId of ACTIVE_STRATEGY_IDS) {
    const profile = config.profiles[strategyId];
    issues.push(...validateManagementProfile(profile).map((issue) => ({
      path: `$.profiles.${strategyId}${issue.path.slice(1)}`,
      message: issue.message,
    })));
  }
  issues.push(...validateManagementProfile(config.fallback_profile).map((issue) => ({
    path: `$.fallback_profile${issue.path.slice(1)}`,
    message: issue.message,
  })));
  return issues.sort(compareIssues);
}

export function canonicalizeManagementProfilesConfig(config: ManagementProfilesConfig): string {
  return stableStringify({
    version: MANAGEMENT_CONFIG_SCHEMA_VERSION,
    profiles: config.profiles,
    fallback_profile: config.fallback_profile,
  });
}

export function computeManagementConfigHash(config: ManagementProfilesConfig): string {
  return createHash(MANAGEMENT_CONFIG_HASH_ALGORITHM)
    .update(canonicalizeManagementProfilesConfig(config), 'utf8')
    .digest('hex');
}

export function computeManagementProfileHash(
  profile: ManagementProfile | Omit<ManagementProfile, 'profile_hash'>,
): string {
  const { profile_hash: _profileHash, ...hashable } = profile as ManagementProfile;
  return createHash(MANAGEMENT_CONFIG_HASH_ALGORITHM)
    .update(stableStringify(hashable), 'utf8')
    .digest('hex');
}

export const DEFAULT_MANAGEMENT_PROFILES_CONFIG = buildManagementProfilesConfig(
  V1_MANAGEMENT_PROFILES,
  FALLBACK_MANAGEMENT_PROFILE,
  'default-management-profiles',
);

function parseManagementProfilesConfig(input: unknown, sourceFile: string): ManagementProfilesConfig {
  const issues: ConfigValidationIssue[] = [];
  const root = requireRecord(input, '$', issues);
  checkUnknownKeys(root, '$', ['version', 'profiles', 'fallback_profile'], issues);
  readVersion(root, '$', issues);

  const profilesRecord = readRecord(root, 'profiles', '$', issues);
  checkUnknownKeys(profilesRecord, '$.profiles', ACTIVE_STRATEGY_IDS, issues);

  const profiles = {
    trend_pullback_long: parseProfile(
      readRecord(profilesRecord, 'trend_pullback_long', '$.profiles', issues),
      'trend_pullback_long',
      '$.profiles.trend_pullback_long',
      issues,
    ),
    trend_pullback_short: parseProfile(
      readRecord(profilesRecord, 'trend_pullback_short', '$.profiles', issues),
      'trend_pullback_short',
      '$.profiles.trend_pullback_short',
      issues,
    ),
    breakout_retest_long: parseProfile(
      readRecord(profilesRecord, 'breakout_retest_long', '$.profiles', issues),
      'breakout_retest_long',
      '$.profiles.breakout_retest_long',
      issues,
    ),
    breakdown_retest_short: parseProfile(
      readRecord(profilesRecord, 'breakdown_retest_short', '$.profiles', issues),
      'breakdown_retest_short',
      '$.profiles.breakdown_retest_short',
      issues,
    ),
  } satisfies Readonly<Record<ActiveStrategyId, ManagementProfile>>;

  const fallback = parseProfile(
    readRecord(root, 'fallback_profile', '$', issues),
    'fallback',
    '$.fallback_profile',
    issues,
  );

  throwIfIssues(issues, 'Invalid management config');
  const config = buildManagementProfilesConfig(profiles, fallback, sourceFile);
  const validationIssues = validateManagementProfilesConfig(config);
  if (validationIssues.length > 0) {
    throw new ConfigValidationError(validationIssues, 'Invalid management config');
  }
  return config;
}

function buildManagementProfilesConfig(
  profiles: Readonly<Record<ActiveStrategyId, ManagementProfile>>,
  fallbackProfile: ManagementProfile,
  sourceFile: string,
): ManagementProfilesConfig {
  const hashedProfiles = {
    trend_pullback_long: withProfileHash(profiles.trend_pullback_long),
    trend_pullback_short: withProfileHash(profiles.trend_pullback_short),
    breakout_retest_long: withProfileHash(profiles.breakout_retest_long),
    breakdown_retest_short: withProfileHash(profiles.breakdown_retest_short),
  } satisfies Readonly<Record<ActiveStrategyId, ManagementProfile>>;
  const hashedFallback = withProfileHash(fallbackProfile);
  const configWithoutLineage = {
    version: MANAGEMENT_CONFIG_SCHEMA_VERSION,
    profiles: hashedProfiles,
    fallback_profile: hashedFallback,
  };
  const canonical = stableStringify(configWithoutLineage);
  const hash = createHash(MANAGEMENT_CONFIG_HASH_ALGORITHM).update(canonical, 'utf8').digest('hex');
  return {
    ...configWithoutLineage,
    lineage: {
      management_config_version: MANAGEMENT_CONFIG_SCHEMA_VERSION,
      management_config_hash: hash,
      management_config_hash_algorithm: MANAGEMENT_CONFIG_HASH_ALGORITHM,
      canonical_management_config_json: canonical,
      profile_hashes: {
        trend_pullback_long: hashedProfiles.trend_pullback_long.profile_hash,
        trend_pullback_short: hashedProfiles.trend_pullback_short.profile_hash,
        breakout_retest_long: hashedProfiles.breakout_retest_long.profile_hash,
        breakdown_retest_short: hashedProfiles.breakdown_retest_short.profile_hash,
        fallback: hashedFallback.profile_hash,
      },
    },
    source_file: sourceFile,
  };
}

function withProfileHash(profile: ManagementProfile): ManagementProfile {
  return {
    ...profile,
    profile_hash: computeManagementProfileHash(profile),
  };
}

function parseProfile(
  record: Record<string, unknown>,
  strategyId: ManagementProfileStrategyId,
  path: string,
  issues: ConfigValidationIssue[],
): ManagementProfile {
  checkUnknownKeys(record, path, [
    'profile_id',
    'profile_version',
    'strategy_id',
    'setup_family',
    'display_name',
    'initial_stop',
    'targets',
    'break_even',
    'trailing_stop',
    'time_stop',
    'fail_safe',
    'partial_exit',
  ], issues);
  readLiteral(record, 'strategy_id', path, [strategyId], issues);
  const profileWithoutHash = {
    profile_id: readString(record, 'profile_id', path, issues) as ManagementProfileId,
    profile_version: readProfileVersion(record, path, issues),
    strategy_id: strategyId,
    setup_family: readLiteral(
      record,
      'setup_family',
      path,
      ['trend_pullback', 'breakout_retest', 'fallback'],
      issues,
    ),
    display_name: readString(record, 'display_name', path, issues),
    initial_stop: parseInitialStop(readRecord(record, 'initial_stop', path, issues), `${path}.initial_stop`, issues),
    targets: parseTargets(readRecord(record, 'targets', path, issues), `${path}.targets`, issues),
    break_even: parseBreakEven(readRecord(record, 'break_even', path, issues), `${path}.break_even`, issues),
    trailing_stop: parseTrailingStop(readRecord(record, 'trailing_stop', path, issues), `${path}.trailing_stop`, issues),
    time_stop: parseTimeStop(readRecord(record, 'time_stop', path, issues), `${path}.time_stop`, issues),
    fail_safe: parseFailSafe(readRecord(record, 'fail_safe', path, issues), `${path}.fail_safe`, issues),
    partial_exit: parsePartialExit(readRecord(record, 'partial_exit', path, issues), `${path}.partial_exit`, issues),
    reasons: [
      `management_profile:${strategyId}`,
      'initial_stop:candidate_stop',
      'partials:pt1_50_pt2_50',
    ],
  } satisfies Omit<ManagementProfile, 'profile_hash'>;
  return {
    ...profileWithoutHash,
    profile_hash: computeManagementProfileHash(profileWithoutHash),
  };
}

function parseInitialStop(
  record: Record<string, unknown>,
  path: string,
  issues: ConfigValidationIssue[],
): InitialStopBehavior {
  checkUnknownKeys(record, path, [
    'mode',
    'lock_to_candidate_stop',
    'stop_widening_allowed',
    'min_stop_distance_ticks',
    'max_initial_risk_points',
  ], issues);
  return {
    mode: readLiteral(record, 'mode', path, ['candidate_stop'], issues),
    lock_to_candidate_stop: readBoolean(record, 'lock_to_candidate_stop', path, issues),
    stop_widening_allowed: readBoolean(record, 'stop_widening_allowed', path, issues),
    min_stop_distance_ticks: readPositiveNumber(record, 'min_stop_distance_ticks', path, issues),
    ...(record.max_initial_risk_points === undefined
      ? {}
      : { max_initial_risk_points: readPositiveNumber(record, 'max_initial_risk_points', path, issues) }),
  };
}

function parseTargets(
  record: Record<string, unknown>,
  path: string,
  issues: ConfigValidationIssue[],
): readonly TargetExitBehavior[] {
  checkUnknownKeys(record, path, ['pt1', 'pt2', 'runner'], issues);
  return (['pt1', 'pt2', 'runner'] as const)
    .filter((label) => record[label] !== undefined)
    .map((label) => {
      const target = readRecord(record, label, path, issues);
      const targetPath = `${path}.${label}`;
      checkUnknownKeys(target, targetPath, ['action', 'quantity_fraction', 'minimum_reward_risk'], issues);
      return {
        label,
        action: readLiteral(target, 'action', targetPath, ['TAKE_PARTIAL', 'TAKE_PROFIT'], issues),
        quantity_fraction: readPositiveNumber(target, 'quantity_fraction', targetPath, issues),
        minimum_reward_risk: readNonNegativeNumber(target, 'minimum_reward_risk', targetPath, issues),
      };
    });
}

function parseBreakEven(
  record: Record<string, unknown>,
  path: string,
  issues: ConfigValidationIssue[],
): BreakEvenPolicy {
  checkUnknownKeys(record, path, ['enabled', 'trigger', 'trigger_r', 'offset_ticks', 'action'], issues);
  return {
    enabled: readBoolean(record, 'enabled', path, issues),
    trigger: readLiteral(record, 'trigger', path, ['after_pt1', 'r_multiple'], issues),
    ...(record.trigger_r === undefined ? {} : { trigger_r: readPositiveNumber(record, 'trigger_r', path, issues) }),
    offset_ticks: readNonNegativeNumber(record, 'offset_ticks', path, issues),
    action: readLiteral(record, 'action', path, ['MARK_BREAKEVEN'], issues),
  };
}

function parseTrailingStop(
  record: Record<string, unknown>,
  path: string,
  issues: ConfigValidationIssue[],
): TrailingStopPolicy {
  checkUnknownKeys(record, path, ['enabled', 'mode', 'activation', 'activation_r', 'distance_ticks', 'action'], issues);
  return {
    enabled: readBoolean(record, 'enabled', path, issues),
    mode: readLiteral(record, 'mode', path, ['disabled', 'post_pt1_ticks', 'post_pt1_sigma'], issues),
    activation: readLiteral(record, 'activation', path, ['after_pt1', 'r_multiple'], issues),
    ...(record.activation_r === undefined ? {} : { activation_r: readPositiveNumber(record, 'activation_r', path, issues) }),
    distance_ticks: readNonNegativeNumber(record, 'distance_ticks', path, issues),
    action: readLiteral(record, 'action', path, ['ACTIVATE_TRAIL'], issues),
  };
}

function parseTimeStop(
  record: Record<string, unknown>,
  path: string,
  issues: ConfigValidationIssue[],
): TimeStopPolicy {
  checkUnknownKeys(record, path, [
    'enabled',
    'max_hold_minutes',
    'pre_pt1_min_unrealized_r',
    'post_pt1_min_unrealized_r',
    'action',
  ], issues);
  return {
    enabled: readBoolean(record, 'enabled', path, issues),
    max_hold_minutes: readNonNegativeNumber(record, 'max_hold_minutes', path, issues),
    pre_pt1_min_unrealized_r: readNumberAllowNegative(record, 'pre_pt1_min_unrealized_r', path, issues),
    post_pt1_min_unrealized_r: readNumberAllowNegative(record, 'post_pt1_min_unrealized_r', path, issues),
    action: readLiteral(record, 'action', path, ['TIME_STOP_EXIT'], issues),
  };
}

function parseFailSafe(
  record: Record<string, unknown>,
  path: string,
  issues: ConfigValidationIssue[],
): FailSafePolicy {
  checkUnknownKeys(record, path, ['enabled', 'max_adverse_r', 'max_spread_ticks', 'action'], issues);
  return {
    enabled: readBoolean(record, 'enabled', path, issues),
    max_adverse_r: readPositiveNumber(record, 'max_adverse_r', path, issues),
    max_spread_ticks: readPositiveNumber(record, 'max_spread_ticks', path, issues),
    action: readLiteral(record, 'action', path, ['FAIL_SAFE_EXIT'], issues),
  };
}

function parsePartialExit(
  record: Record<string, unknown>,
  path: string,
  issues: ConfigValidationIssue[],
): PartialExitSizing {
  checkUnknownKeys(record, path, ['pt1_fraction', 'pt2_fraction', 'runner_fraction'], issues);
  return {
    pt1_fraction: readNonNegativeNumber(record, 'pt1_fraction', path, issues),
    pt2_fraction: readNonNegativeNumber(record, 'pt2_fraction', path, issues),
    runner_fraction: readNonNegativeNumber(record, 'runner_fraction', path, issues),
  };
}

function readProfileVersion(
  record: Record<string, unknown>,
  path: string,
  issues: ConfigValidationIssue[],
): typeof MANAGEMENT_PROFILE_VERSION {
  const value = readPositiveNumber(record, 'profile_version', path, issues);
  if (value !== MANAGEMENT_PROFILE_VERSION) {
    issues.push({ path: `${path}.profile_version`, message: `expected ${MANAGEMENT_PROFILE_VERSION}` });
  }
  return MANAGEMENT_PROFILE_VERSION;
}

function readVersion(
  record: Record<string, unknown>,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  if (record['version'] !== MANAGEMENT_CONFIG_SCHEMA_VERSION) {
    issues.push({ path: `${path}.version`, message: `expected ${MANAGEMENT_CONFIG_SCHEMA_VERSION}` });
  }
}

function readNumberAllowNegative(
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

function compareIssues(left: ConfigValidationIssue, right: ConfigValidationIssue): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  if (left.message < right.message) return -1;
  if (left.message > right.message) return 1;
  return 0;
}

for (const profile of Object.values(DEFAULT_MANAGEMENT_PROFILES_CONFIG.profiles)) {
  assertValidManagementProfile(profile);
}
assertValidManagementProfile(DEFAULT_MANAGEMENT_PROFILES_CONFIG.fallback_profile);
