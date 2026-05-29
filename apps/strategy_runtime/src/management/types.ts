import type {
  Candidate,
  CandidateSetupFamily,
  PriceTarget,
  RewardRiskTarget,
} from '../contracts/candidate.js';
import type { ManagementActionType } from '../contracts/position.js';
import type { StrategyId } from '../contracts/strategy-ids.js';

export const MANAGEMENT_PROFILE_VERSION = 1 as const;
export const MANAGEMENT_PROFILE_HASH_PLACEHOLDER =
  'management_profile_hash_pending_config_v1' as const;

export const MANAGEMENT_ACTION_TYPES = [
  'HOLD',
  'MOVE_STOP',
  'TAKE_PARTIAL',
  'TAKE_PROFIT',
  'EXIT_FULL',
  'MARK_BREAKEVEN',
  'BREAKEVEN_ARMED',
  'ACTIVATE_TRAIL',
  'FAIL_SAFE_EXIT',
  'TIME_STOP_EXIT',
] as const satisfies readonly ManagementActionType[];

export type V1ManagementActionType = (typeof MANAGEMENT_ACTION_TYPES)[number];

export const TIME_STOP_AT_DEADLINE_EXTENSIONS = [
  'enforce_floor',
  'move_to_be',
  'activate_trail',
  'unconditional_exit',
] as const;

export type TimeStopAtDeadlineExtension = typeof TIME_STOP_AT_DEADLINE_EXTENSIONS[number];

export function isTimeStopAtDeadlineExtension(value: unknown): value is TimeStopAtDeadlineExtension {
  return typeof value === 'string' &&
    (TIME_STOP_AT_DEADLINE_EXTENSIONS as readonly string[]).includes(value);
}
export type ManagementProfileStrategyId = StrategyId | 'fallback';
export type ManagementProfileId =
  | 'trend_pullback_long_management_v1'
  | 'trend_pullback_short_management_v1'
  | 'breakout_retest_long_management_v1'
  | 'breakdown_retest_short_management_v1'
  | 'regime_mean_reversion_long_management_v1'
  | 'regime_mean_reversion_short_management_v1'
  | 'liquidity_sweep_reversal_long_management_v1'
  | 'liquidity_sweep_reversal_short_management_v1'
  | 'vwap_overnight_reversal_long_management_v1'
  | 'vwap_overnight_reversal_short_management_v1'
  | 'regime_shock_reversion_short_v2_management_v1'
  | 'regime_shock_reversion_short_v3_management_v1'
  | 'regime_shock_reversion_short_v4_delay_management_v1'
  | 'regime_shock_reversion_short_v4_persist_management_v1'
  | 'regime_shock_reversion_short_v5_strict_deadline_management_v1'
  | 'regime_shock_reversion_short_v5_trail_at_deadline_management_v1'
  | 'fallback_management_v1';

export interface InitialStopBehavior {
  readonly mode: 'candidate_stop';
  readonly lock_to_candidate_stop: boolean;
  readonly stop_widening_allowed: boolean;
  readonly min_stop_distance_ticks: number;
  readonly max_initial_risk_points?: number;
}

export interface TargetExitBehavior {
  readonly label: PriceTarget['label'];
  readonly action: Extract<V1ManagementActionType, 'TAKE_PARTIAL' | 'TAKE_PROFIT'>;
  readonly quantity_fraction: number;
  readonly minimum_reward_risk: number;
}

export interface BreakEvenPolicy {
  readonly enabled: boolean;
  readonly trigger: 'after_pt1' | 'r_multiple';
  readonly trigger_r?: number;
  readonly offset_ticks: number;
  readonly action: Extract<V1ManagementActionType, 'MARK_BREAKEVEN'>;
}

export interface TrailingStopPolicy {
  readonly enabled: boolean;
  readonly mode: 'disabled' | 'post_pt1_ticks' | 'post_pt1_sigma';
  readonly activation: 'after_pt1' | 'r_multiple';
  readonly activation_r?: number;
  readonly distance_ticks: number;
  readonly action: Extract<V1ManagementActionType, 'ACTIVATE_TRAIL'>;
}

export interface TimeStopPolicy {
  readonly enabled: boolean;
  readonly max_hold_minutes: number;
  readonly pre_pt1_min_unrealized_r: number;
  readonly post_pt1_min_unrealized_r: number;
  readonly at_deadline_extension: TimeStopAtDeadlineExtension;
  readonly action: Extract<V1ManagementActionType, 'TIME_STOP_EXIT'>;
}

export interface FailSafePolicy {
  readonly enabled: boolean;
  readonly max_adverse_r: number;
  readonly max_spread_ticks: number;
  readonly action: Extract<V1ManagementActionType, 'FAIL_SAFE_EXIT'>;
}

export interface PartialExitSizing {
  readonly pt1_fraction: number;
  readonly pt2_fraction: number;
  readonly runner_fraction: number;
}

export interface ManagementProfile {
  readonly profile_id: ManagementProfileId;
  readonly profile_version: typeof MANAGEMENT_PROFILE_VERSION;
  readonly strategy_id: ManagementProfileStrategyId;
  readonly setup_family: CandidateSetupFamily | 'fallback';
  readonly display_name: string;
  readonly profile_hash: string;
  readonly initial_stop: InitialStopBehavior;
  readonly targets: readonly TargetExitBehavior[];
  readonly break_even: BreakEvenPolicy;
  readonly trailing_stop: TrailingStopPolicy;
  readonly time_stop: TimeStopPolicy;
  readonly fail_safe: FailSafePolicy;
  readonly partial_exit: PartialExitSizing;
  readonly reasons: readonly string[];
}

export interface ResolvedManagementProfile {
  readonly strategy_id: string;
  readonly profile: ManagementProfile;
  readonly fallback_used: boolean;
  readonly reasons: readonly string[];
}

export type ManagementProfileValidationIssueCode =
  | 'missing_required_field'
  | 'invalid_field_value'
  | 'invalid_partial_exit_sizing'
  | 'missing_required_target'
  | 'invalid_target_order';

export interface ManagementProfileValidationIssue {
  readonly path: string;
  readonly code: ManagementProfileValidationIssueCode;
  readonly message: string;
}

export interface PlannedManagementTarget {
  readonly label: PriceTarget['label'];
  readonly action: TargetExitBehavior['action'];
  readonly price: number;
  readonly management_quantity_fraction: number;
  readonly candidate_quantity_fraction: number;
  readonly reward_risk: number;
  readonly minimum_reward_risk: number;
}

export interface CandidateTargetPlan {
  readonly profile_id: ManagementProfileId;
  readonly profile_version: typeof MANAGEMENT_PROFILE_VERSION;
  readonly profile_hash: string;
  readonly strategy_id: StrategyId;
  readonly candidate_id: Candidate['candidate_id'];
  readonly entry_price: number;
  readonly stop_price: number;
  readonly risk_points: number;
  readonly targets: readonly PlannedManagementTarget[];
  readonly reasons: readonly string[];
}

export interface InitialStopPolicyPlan {
  readonly profile_id: ManagementProfileId;
  readonly profile_version: typeof MANAGEMENT_PROFILE_VERSION;
  readonly strategy_id: StrategyId;
  readonly candidate_id: Candidate['candidate_id'];
  readonly entry_price: number;
  readonly stop_price: number;
  readonly risk_points: number;
  readonly stop_widening_allowed: boolean;
  readonly lock_to_candidate_stop: boolean;
  readonly reasons: readonly string[];
}

export function validateManagementProfile(
  profile: ManagementProfile,
): readonly ManagementProfileValidationIssue[] {
  const issues: ManagementProfileValidationIssue[] = [];

  requireNonEmptyString(profile.profile_id, '$.profile_id', issues);
  if (profile.profile_version !== MANAGEMENT_PROFILE_VERSION) {
    addIssue(issues, '$.profile_version', 'invalid_field_value', 'must be 1');
  }
  requireNonEmptyString(profile.strategy_id, '$.strategy_id', issues);
  requireNonEmptyString(profile.display_name, '$.display_name', issues);
  requireNonEmptyString(profile.profile_hash, '$.profile_hash', issues);

  validateInitialStop(profile.initial_stop, issues);
  validateTargets(profile.targets, issues);
  validateBreakEven(profile.break_even, issues);
  validateTrailingStop(profile.trailing_stop, issues);
  validateTimeStop(profile.time_stop, profile.trailing_stop, issues);
  validateFailSafe(profile.fail_safe, issues);
  validatePartialExit(profile.partial_exit, issues);

  return issues.sort(compareIssues);
}

export function assertValidManagementProfile(profile: ManagementProfile): void {
  const issues = validateManagementProfile(profile);
  if (issues.length > 0) {
    throw new Error(formatManagementProfileValidationErrors(issues));
  }
}

export function formatManagementProfileValidationErrors(
  issues: readonly ManagementProfileValidationIssue[],
): string {
  return `management profile validation failed: ${issues
    .map((issue) => `${issue.path} ${issue.message}`)
    .join('; ')}`;
}

export function getTargetPlanFromCandidate(
  candidate: Candidate,
  profile: ManagementProfile,
): CandidateTargetPlan {
  assertValidManagementProfile(profile);
  assertProfileMatchesCandidate(candidate, profile);
  const plannedTargets = profile.targets.map((target) => {
    const candidateTarget = requireCandidateTarget(candidate.targets, target.label);
    const rewardRisk = requireRewardRisk(candidate.reward_risk, target.label);
    if (rewardRisk.reward_risk < target.minimum_reward_risk) {
      throw new Error(
        `candidate target ${target.label} reward_risk ${rewardRisk.reward_risk} is below management minimum ${target.minimum_reward_risk}`,
      );
    }
    return {
      label: target.label,
      action: target.action,
      price: candidateTarget.price,
      management_quantity_fraction: target.quantity_fraction,
      candidate_quantity_fraction: candidateTarget.quantity_fraction,
      reward_risk: rewardRisk.reward_risk,
      minimum_reward_risk: target.minimum_reward_risk,
    } satisfies PlannedManagementTarget;
  });

  validateCandidateTargetOrdering(candidate, plannedTargets);

  return {
    profile_id: profile.profile_id,
    profile_version: profile.profile_version,
    profile_hash: profile.profile_hash,
    strategy_id: candidate.strategy_id,
    candidate_id: candidate.candidate_id,
    entry_price: candidate.entry_price,
    stop_price: candidate.stop_price,
    risk_points: candidate.risk_points,
    targets: plannedTargets,
    reasons: [
      `management_profile:${profile.profile_id}`,
      `management_profile_version:${profile.profile_version}`,
      'management_targets:from_candidate',
    ],
  };
}

export function computeInitialStopPolicy(
  candidate: Candidate,
  profile: ManagementProfile,
): InitialStopPolicyPlan {
  assertValidManagementProfile(profile);
  assertProfileMatchesCandidate(candidate, profile);
  validateCandidateStop(candidate);

  if (
    profile.initial_stop.max_initial_risk_points !== undefined &&
    candidate.risk_points > profile.initial_stop.max_initial_risk_points
  ) {
    throw new Error(
      `candidate risk_points ${candidate.risk_points} exceeds max_initial_risk_points ${profile.initial_stop.max_initial_risk_points}`,
    );
  }

  return {
    profile_id: profile.profile_id,
    profile_version: profile.profile_version,
    strategy_id: candidate.strategy_id,
    candidate_id: candidate.candidate_id,
    entry_price: candidate.entry_price,
    stop_price: candidate.stop_price,
    risk_points: candidate.risk_points,
    stop_widening_allowed: profile.initial_stop.stop_widening_allowed,
    lock_to_candidate_stop: profile.initial_stop.lock_to_candidate_stop,
    reasons: [
      `management_profile:${profile.profile_id}`,
      'initial_stop:candidate_stop',
      profile.initial_stop.stop_widening_allowed
        ? 'initial_stop:stop_widening_allowed'
        : 'initial_stop:stop_widening_blocked',
    ],
  };
}

function validateInitialStop(
  value: InitialStopBehavior | undefined,
  issues: ManagementProfileValidationIssue[],
): void {
  if (value === undefined) {
    addIssue(issues, '$.initial_stop', 'missing_required_field', 'is required');
    return;
  }
  if (value.mode !== 'candidate_stop') {
    addIssue(issues, '$.initial_stop.mode', 'invalid_field_value', 'must be candidate_stop');
  }
  requireBoolean(value.lock_to_candidate_stop, '$.initial_stop.lock_to_candidate_stop', issues);
  requireBoolean(value.stop_widening_allowed, '$.initial_stop.stop_widening_allowed', issues);
  requirePositiveNumber(value.min_stop_distance_ticks, '$.initial_stop.min_stop_distance_ticks', issues);
  if (value.max_initial_risk_points !== undefined) {
    requirePositiveNumber(value.max_initial_risk_points, '$.initial_stop.max_initial_risk_points', issues);
  }
}

function validateTargets(
  targets: readonly TargetExitBehavior[] | undefined,
  issues: ManagementProfileValidationIssue[],
): void {
  if (!Array.isArray(targets) || targets.length === 0) {
    addIssue(issues, '$.targets', 'missing_required_field', 'must include pt1 and pt2');
    return;
  }
  const pt1 = targets.find((target) => target.label === 'pt1');
  const pt2 = targets.find((target) => target.label === 'pt2');
  if (pt1 === undefined) {
    addIssue(issues, '$.targets.pt1', 'missing_required_target', 'pt1 target is required');
  }
  if (pt2 === undefined) {
    addIssue(issues, '$.targets.pt2', 'missing_required_target', 'pt2 target is required');
  }

  targets.forEach((target, index) => {
    const path = `$.targets[${index}]`;
    if (!['pt1', 'pt2', 'runner'].includes(target.label)) {
      addIssue(issues, `${path}.label`, 'invalid_field_value', 'must be pt1, pt2, or runner');
    }
    if (!['TAKE_PARTIAL', 'TAKE_PROFIT'].includes(target.action)) {
      addIssue(issues, `${path}.action`, 'invalid_field_value', 'must be TAKE_PARTIAL or TAKE_PROFIT');
    }
    requirePositiveNumber(target.quantity_fraction, `${path}.quantity_fraction`, issues);
    if (target.quantity_fraction > 1) {
      addIssue(issues, `${path}.quantity_fraction`, 'invalid_field_value', 'must be <= 1');
    }
    requireNonNegativeNumber(target.minimum_reward_risk, `${path}.minimum_reward_risk`, issues);
  });

  if (
    pt1 !== undefined &&
    pt2 !== undefined &&
    pt2.minimum_reward_risk < pt1.minimum_reward_risk
  ) {
    addIssue(
      issues,
      '$.targets',
      'invalid_target_order',
      'pt2 minimum_reward_risk must be >= pt1 minimum_reward_risk',
    );
  }
}

function validateBreakEven(
  value: BreakEvenPolicy | undefined,
  issues: ManagementProfileValidationIssue[],
): void {
  if (value === undefined) {
    addIssue(issues, '$.break_even', 'missing_required_field', 'is required');
    return;
  }
  requireBoolean(value.enabled, '$.break_even.enabled', issues);
  if (!['after_pt1', 'r_multiple'].includes(value.trigger)) {
    addIssue(issues, '$.break_even.trigger', 'invalid_field_value', 'must be after_pt1 or r_multiple');
  }
  if (value.trigger === 'r_multiple') {
    requirePositiveNumber(value.trigger_r, '$.break_even.trigger_r', issues);
  }
  requireNonNegativeNumber(value.offset_ticks, '$.break_even.offset_ticks', issues);
  if (value.action !== 'MARK_BREAKEVEN') {
    addIssue(issues, '$.break_even.action', 'invalid_field_value', 'must be MARK_BREAKEVEN');
  }
}

function validateTrailingStop(
  value: TrailingStopPolicy | undefined,
  issues: ManagementProfileValidationIssue[],
): void {
  if (value === undefined) {
    addIssue(issues, '$.trailing_stop', 'missing_required_field', 'is required');
    return;
  }
  requireBoolean(value.enabled, '$.trailing_stop.enabled', issues);
  if (!['disabled', 'post_pt1_ticks', 'post_pt1_sigma'].includes(value.mode)) {
    addIssue(
      issues,
      '$.trailing_stop.mode',
      'invalid_field_value',
      'must be disabled, post_pt1_ticks, or post_pt1_sigma',
    );
  }
  if (!['after_pt1', 'r_multiple'].includes(value.activation)) {
    addIssue(
      issues,
      '$.trailing_stop.activation',
      'invalid_field_value',
      'must be after_pt1 or r_multiple',
    );
  }
  if (value.activation === 'r_multiple') {
    requirePositiveNumber(value.activation_r, '$.trailing_stop.activation_r', issues);
  }
  if (value.enabled) {
    requirePositiveNumber(value.distance_ticks, '$.trailing_stop.distance_ticks', issues);
  } else {
    requireNonNegativeNumber(value.distance_ticks, '$.trailing_stop.distance_ticks', issues);
  }
  if (value.action !== 'ACTIVATE_TRAIL') {
    addIssue(issues, '$.trailing_stop.action', 'invalid_field_value', 'must be ACTIVATE_TRAIL');
  }
}

function validateTimeStop(
  value: TimeStopPolicy | undefined,
  trailingStop: TrailingStopPolicy | undefined,
  issues: ManagementProfileValidationIssue[],
): void {
  if (value === undefined) {
    addIssue(issues, '$.time_stop', 'missing_required_field', 'is required');
    return;
  }
  requireBoolean(value.enabled, '$.time_stop.enabled', issues);
  if (value.enabled) {
    requirePositiveNumber(value.max_hold_minutes, '$.time_stop.max_hold_minutes', issues);
  } else {
    requireNonNegativeNumber(value.max_hold_minutes, '$.time_stop.max_hold_minutes', issues);
  }
  requireFiniteNumber(value.pre_pt1_min_unrealized_r, '$.time_stop.pre_pt1_min_unrealized_r', issues);
  requireFiniteNumber(value.post_pt1_min_unrealized_r, '$.time_stop.post_pt1_min_unrealized_r', issues);
  if (!isTimeStopAtDeadlineExtension(value.at_deadline_extension)) {
    addIssue(
      issues,
      '$.time_stop.at_deadline_extension',
      'invalid_field_value',
      `must be one of ${TIME_STOP_AT_DEADLINE_EXTENSIONS.join(', ')}`,
    );
  }
  if (value.at_deadline_extension === 'activate_trail') {
    if (trailingStop?.enabled !== true) {
      addIssue(
        issues,
        '$.time_stop.at_deadline_extension',
        'invalid_field_value',
        'activate_trail requires trailing_stop.enabled true',
      );
    }
    if (!Number.isFinite(trailingStop?.distance_ticks) || (trailingStop?.distance_ticks ?? 0) <= 0) {
      addIssue(
        issues,
        '$.time_stop.at_deadline_extension',
        'invalid_field_value',
        'activate_trail requires trailing_stop.distance_ticks > 0',
      );
    }
    if (trailingStop?.mode !== 'post_pt1_ticks') {
      addIssue(
        issues,
        '$.time_stop.at_deadline_extension',
        'invalid_field_value',
        'activate_trail requires trailing_stop.mode post_pt1_ticks',
      );
    }
  }
  if (value.action !== 'TIME_STOP_EXIT') {
    addIssue(issues, '$.time_stop.action', 'invalid_field_value', 'must be TIME_STOP_EXIT');
  }
}

function validateFailSafe(
  value: FailSafePolicy | undefined,
  issues: ManagementProfileValidationIssue[],
): void {
  if (value === undefined) {
    addIssue(issues, '$.fail_safe', 'missing_required_field', 'is required');
    return;
  }
  requireBoolean(value.enabled, '$.fail_safe.enabled', issues);
  if (value.enabled) {
    requirePositiveNumber(value.max_adverse_r, '$.fail_safe.max_adverse_r', issues);
    requirePositiveNumber(value.max_spread_ticks, '$.fail_safe.max_spread_ticks', issues);
  }
  if (value.action !== 'FAIL_SAFE_EXIT') {
    addIssue(issues, '$.fail_safe.action', 'invalid_field_value', 'must be FAIL_SAFE_EXIT');
  }
}

function validatePartialExit(
  value: PartialExitSizing | undefined,
  issues: ManagementProfileValidationIssue[],
): void {
  if (value === undefined) {
    addIssue(issues, '$.partial_exit', 'missing_required_field', 'is required');
    return;
  }
  const fractions = [
    ['pt1_fraction', value.pt1_fraction],
    ['pt2_fraction', value.pt2_fraction],
    ['runner_fraction', value.runner_fraction],
  ] as const;
  for (const [field, fraction] of fractions) {
    requireNonNegativeNumber(fraction, `$.partial_exit.${field}`, issues);
    if (Number.isFinite(fraction) && fraction > 1) {
      addIssue(issues, `$.partial_exit.${field}`, 'invalid_field_value', 'must be <= 1');
    }
  }
  const total = round6(value.pt1_fraction + value.pt2_fraction + value.runner_fraction);
  if (total !== 1) {
    addIssue(
      issues,
      '$.partial_exit',
      'invalid_partial_exit_sizing',
      'pt1_fraction + pt2_fraction + runner_fraction must equal 1',
    );
  }
}

function assertProfileMatchesCandidate(candidate: Candidate, profile: ManagementProfile): void {
  if (profile.strategy_id !== 'fallback' && profile.strategy_id !== candidate.strategy_id) {
    throw new Error(
      `management profile ${profile.profile_id} is for ${profile.strategy_id}, not ${candidate.strategy_id}`,
    );
  }
}

function requireCandidateTarget(
  targets: readonly PriceTarget[],
  label: PriceTarget['label'],
): PriceTarget {
  const target = targets.find((item) => item.label === label);
  if (target === undefined) {
    throw new Error(`candidate target ${label} missing in journaled candidate`);
  }
  return target;
}

function requireRewardRisk(
  targets: readonly RewardRiskTarget[],
  label: PriceTarget['label'],
): RewardRiskTarget {
  const target = targets.find((item) => item.label === label);
  if (target === undefined) {
    throw new Error(`candidate reward_risk ${label} missing in journaled candidate`);
  }
  return target;
}

function validateCandidateTargetOrdering(
  candidate: Candidate,
  targets: readonly PlannedManagementTarget[],
): void {
  const pt1 = targets.find((target) => target.label === 'pt1');
  const pt2 = targets.find((target) => target.label === 'pt2');
  if (pt1 === undefined || pt2 === undefined) {
    throw new Error('management target plan requires pt1 and pt2');
  }
  if (candidate.direction === 'long') {
    if (pt1.price <= candidate.entry_price || pt2.price <= pt1.price) {
      throw new Error('long management targets must be ordered entry < pt1 < pt2');
    }
    return;
  }
  if (pt1.price >= candidate.entry_price || pt2.price >= pt1.price) {
    throw new Error('short management targets must be ordered entry > pt1 > pt2');
  }
}

function validateCandidateStop(candidate: Candidate): void {
  if (!Number.isFinite(candidate.risk_points) || candidate.risk_points <= 0) {
    throw new Error('candidate risk_points must be positive before management');
  }
  if (candidate.direction === 'long' && candidate.stop_price >= candidate.entry_price) {
    throw new Error('long candidate stop must be below entry before management');
  }
  if (candidate.direction === 'short' && candidate.stop_price <= candidate.entry_price) {
    throw new Error('short candidate stop must be above entry before management');
  }
}

function requireBoolean(
  value: unknown,
  path: string,
  issues: ManagementProfileValidationIssue[],
): void {
  if (typeof value !== 'boolean') {
    addIssue(issues, path, 'invalid_field_value', 'must be boolean');
  }
}

function requireNonEmptyString(
  value: unknown,
  path: string,
  issues: ManagementProfileValidationIssue[],
): void {
  if (typeof value !== 'string' || value.trim() === '') {
    addIssue(issues, path, 'missing_required_field', 'must be a non-empty string');
  }
}

function requireFiniteNumber(
  value: unknown,
  path: string,
  issues: ManagementProfileValidationIssue[],
): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    addIssue(issues, path, 'invalid_field_value', 'must be finite');
  }
}

function requireNonNegativeNumber(
  value: unknown,
  path: string,
  issues: ManagementProfileValidationIssue[],
): void {
  requireFiniteNumber(value, path, issues);
  if (typeof value === 'number' && Number.isFinite(value) && value < 0) {
    addIssue(issues, path, 'invalid_field_value', 'must be >= 0');
  }
}

function requirePositiveNumber(
  value: unknown,
  path: string,
  issues: ManagementProfileValidationIssue[],
): void {
  requireFiniteNumber(value, path, issues);
  if (typeof value === 'number' && Number.isFinite(value) && value <= 0) {
    addIssue(issues, path, 'invalid_field_value', 'must be > 0');
  }
}

function addIssue(
  issues: ManagementProfileValidationIssue[],
  path: string,
  code: ManagementProfileValidationIssueCode,
  message: string,
): void {
  issues.push({ path, code, message });
}

function compareIssues(
  left: ManagementProfileValidationIssue,
  right: ManagementProfileValidationIssue,
): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  if (left.code < right.code) return -1;
  if (left.code > right.code) return 1;
  if (left.message < right.message) return -1;
  if (left.message > right.message) return 1;
  return 0;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
