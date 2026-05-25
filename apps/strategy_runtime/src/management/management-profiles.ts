import type { StrategyId } from '../contracts/strategy-ids.js';
import {
  ACTIVE_STRATEGY_IDS,
  isStrategyId,
} from '../contracts/strategy-ids.js';
import {
  MANAGEMENT_PROFILE_HASH_PLACEHOLDER,
  MANAGEMENT_PROFILE_VERSION,
  assertValidManagementProfile,
  type ManagementProfile,
  type ResolvedManagementProfile,
} from './types.js';

export interface ResolveManagementProfileOptions {
  readonly allow_fallback?: boolean;
  readonly profiles?: Readonly<Partial<Record<StrategyId, ManagementProfile>>>;
  readonly fallback_profile?: ManagementProfile;
}

const BASE_INITIAL_STOP = {
  mode: 'candidate_stop',
  lock_to_candidate_stop: true,
  stop_widening_allowed: false,
  min_stop_distance_ticks: 2,
} as const;

const BASE_TARGETS = [
  {
    label: 'pt1',
    action: 'TAKE_PARTIAL',
    quantity_fraction: 0.5,
    minimum_reward_risk: 1,
  },
  {
    label: 'pt2',
    action: 'TAKE_PROFIT',
    quantity_fraction: 0.5,
    minimum_reward_risk: 1.5,
  },
] as const;

const BASE_BREAK_EVEN = {
  enabled: true,
  trigger: 'after_pt1',
  offset_ticks: 1,
  action: 'MARK_BREAKEVEN',
} as const;

const BASE_TIME_STOP = {
  enabled: true,
  max_hold_minutes: 45,
  pre_pt1_min_unrealized_r: -0.25,
  post_pt1_min_unrealized_r: 0,
  at_deadline_extension: 'enforce_floor',
  action: 'TIME_STOP_EXIT',
} as const;

const BASE_FAIL_SAFE = {
  enabled: true,
  max_adverse_r: 1,
  max_spread_ticks: 8,
  action: 'FAIL_SAFE_EXIT',
} as const;

const BASE_PARTIAL_EXIT = {
  pt1_fraction: 0.5,
  pt2_fraction: 0.5,
  runner_fraction: 0,
} as const;

export const TREND_PULLBACK_LONG_MANAGEMENT_PROFILE = {
  profile_id: 'trend_pullback_long_management_v1',
  profile_version: MANAGEMENT_PROFILE_VERSION,
  strategy_id: 'trend_pullback_long',
  setup_family: 'trend_pullback',
  display_name: 'Trend Pullback Long Management V1',
  profile_hash: MANAGEMENT_PROFILE_HASH_PLACEHOLDER,
  initial_stop: BASE_INITIAL_STOP,
  targets: BASE_TARGETS,
  break_even: BASE_BREAK_EVEN,
  trailing_stop: {
    enabled: true,
    mode: 'post_pt1_ticks',
    activation: 'after_pt1',
    distance_ticks: 8,
    action: 'ACTIVATE_TRAIL',
  },
  time_stop: BASE_TIME_STOP,
  fail_safe: BASE_FAIL_SAFE,
  partial_exit: BASE_PARTIAL_EXIT,
  reasons: [
    'management_profile:trend_pullback_long',
    'initial_stop:candidate_stop',
    'partials:pt1_50_pt2_50',
  ],
} as const satisfies ManagementProfile;

export const TREND_PULLBACK_SHORT_MANAGEMENT_PROFILE = {
  profile_id: 'trend_pullback_short_management_v1',
  profile_version: MANAGEMENT_PROFILE_VERSION,
  strategy_id: 'trend_pullback_short',
  setup_family: 'trend_pullback',
  display_name: 'Trend Pullback Short Management V1',
  profile_hash: MANAGEMENT_PROFILE_HASH_PLACEHOLDER,
  initial_stop: BASE_INITIAL_STOP,
  targets: BASE_TARGETS,
  break_even: BASE_BREAK_EVEN,
  trailing_stop: {
    enabled: true,
    mode: 'post_pt1_ticks',
    activation: 'after_pt1',
    distance_ticks: 8,
    action: 'ACTIVATE_TRAIL',
  },
  time_stop: BASE_TIME_STOP,
  fail_safe: BASE_FAIL_SAFE,
  partial_exit: BASE_PARTIAL_EXIT,
  reasons: [
    'management_profile:trend_pullback_short',
    'initial_stop:candidate_stop',
    'partials:pt1_50_pt2_50',
  ],
} as const satisfies ManagementProfile;

export const BREAKOUT_RETEST_LONG_MANAGEMENT_PROFILE = {
  profile_id: 'breakout_retest_long_management_v1',
  profile_version: MANAGEMENT_PROFILE_VERSION,
  strategy_id: 'breakout_retest_long',
  setup_family: 'breakout_retest',
  display_name: 'Breakout Retest Long Management V1',
  profile_hash: MANAGEMENT_PROFILE_HASH_PLACEHOLDER,
  initial_stop: {
    ...BASE_INITIAL_STOP,
    min_stop_distance_ticks: 3,
  },
  targets: BASE_TARGETS,
  break_even: BASE_BREAK_EVEN,
  trailing_stop: {
    enabled: true,
    mode: 'post_pt1_ticks',
    activation: 'after_pt1',
    distance_ticks: 10,
    action: 'ACTIVATE_TRAIL',
  },
  time_stop: {
    ...BASE_TIME_STOP,
    max_hold_minutes: 35,
  },
  fail_safe: BASE_FAIL_SAFE,
  partial_exit: BASE_PARTIAL_EXIT,
  reasons: [
    'management_profile:breakout_retest_long',
    'initial_stop:candidate_stop',
    'partials:pt1_50_pt2_50',
  ],
} as const satisfies ManagementProfile;

export const BREAKDOWN_RETEST_SHORT_MANAGEMENT_PROFILE = {
  profile_id: 'breakdown_retest_short_management_v1',
  profile_version: MANAGEMENT_PROFILE_VERSION,
  strategy_id: 'breakdown_retest_short',
  setup_family: 'breakout_retest',
  display_name: 'Breakdown Retest Short Management V1',
  profile_hash: MANAGEMENT_PROFILE_HASH_PLACEHOLDER,
  initial_stop: {
    ...BASE_INITIAL_STOP,
    min_stop_distance_ticks: 3,
  },
  targets: BASE_TARGETS,
  break_even: BASE_BREAK_EVEN,
  trailing_stop: {
    enabled: true,
    mode: 'post_pt1_ticks',
    activation: 'after_pt1',
    distance_ticks: 10,
    action: 'ACTIVATE_TRAIL',
  },
  time_stop: {
    ...BASE_TIME_STOP,
    max_hold_minutes: 35,
  },
  fail_safe: BASE_FAIL_SAFE,
  partial_exit: BASE_PARTIAL_EXIT,
  reasons: [
    'management_profile:breakdown_retest_short',
    'initial_stop:candidate_stop',
    'partials:pt1_50_pt2_50',
  ],
} as const satisfies ManagementProfile;

export const REGIME_MEAN_REVERSION_LONG_MANAGEMENT_PROFILE = {
  profile_id: 'regime_mean_reversion_long_management_v1',
  profile_version: MANAGEMENT_PROFILE_VERSION,
  strategy_id: 'regime_mean_reversion_long',
  setup_family: 'regime_mean_reversion',
  display_name: 'Regime Mean Reversion Long Management V1',
  profile_hash: MANAGEMENT_PROFILE_HASH_PLACEHOLDER,
  initial_stop: BASE_INITIAL_STOP,
  targets: BASE_TARGETS,
  break_even: BASE_BREAK_EVEN,
  trailing_stop: {
    enabled: true,
    mode: 'post_pt1_ticks',
    activation: 'after_pt1',
    distance_ticks: 8,
    action: 'ACTIVATE_TRAIL',
  },
  time_stop: {
    ...BASE_TIME_STOP,
    max_hold_minutes: 25,
  },
  fail_safe: BASE_FAIL_SAFE,
  partial_exit: BASE_PARTIAL_EXIT,
  reasons: [
    'management_profile:regime_mean_reversion_long',
    'initial_stop:candidate_stop',
    'partials:pt1_50_pt2_50',
  ],
} as const satisfies ManagementProfile;

export const REGIME_MEAN_REVERSION_SHORT_MANAGEMENT_PROFILE = {
  profile_id: 'regime_mean_reversion_short_management_v1',
  profile_version: MANAGEMENT_PROFILE_VERSION,
  strategy_id: 'regime_mean_reversion_short',
  setup_family: 'regime_mean_reversion',
  display_name: 'Regime Mean Reversion Short Management V1',
  profile_hash: MANAGEMENT_PROFILE_HASH_PLACEHOLDER,
  initial_stop: BASE_INITIAL_STOP,
  targets: BASE_TARGETS,
  break_even: BASE_BREAK_EVEN,
  trailing_stop: {
    enabled: true,
    mode: 'post_pt1_ticks',
    activation: 'after_pt1',
    distance_ticks: 8,
    action: 'ACTIVATE_TRAIL',
  },
  time_stop: {
    ...BASE_TIME_STOP,
    max_hold_minutes: 25,
  },
  fail_safe: BASE_FAIL_SAFE,
  partial_exit: BASE_PARTIAL_EXIT,
  reasons: [
    'management_profile:regime_mean_reversion_short',
    'initial_stop:candidate_stop',
    'partials:pt1_50_pt2_50',
  ],
} as const satisfies ManagementProfile;

export const LIQUIDITY_SWEEP_REVERSAL_LONG_MANAGEMENT_PROFILE = {
  profile_id: 'liquidity_sweep_reversal_long_management_v1',
  profile_version: MANAGEMENT_PROFILE_VERSION,
  strategy_id: 'liquidity_sweep_reversal_long',
  setup_family: 'liquidity_sweep_reversal',
  display_name: 'Liquidity Sweep Reversal Long Management V1',
  profile_hash: MANAGEMENT_PROFILE_HASH_PLACEHOLDER,
  initial_stop: {
    ...BASE_INITIAL_STOP,
    min_stop_distance_ticks: 2,
  },
  targets: BASE_TARGETS,
  break_even: BASE_BREAK_EVEN,
  trailing_stop: {
    enabled: true,
    mode: 'post_pt1_ticks',
    activation: 'after_pt1',
    distance_ticks: 6,
    action: 'ACTIVATE_TRAIL',
  },
  time_stop: {
    ...BASE_TIME_STOP,
    max_hold_minutes: 20,
  },
  fail_safe: BASE_FAIL_SAFE,
  partial_exit: BASE_PARTIAL_EXIT,
  reasons: [
    'management_profile:liquidity_sweep_reversal_long',
    'initial_stop:candidate_stop',
    'partials:pt1_50_pt2_50',
  ],
} as const satisfies ManagementProfile;

export const LIQUIDITY_SWEEP_REVERSAL_SHORT_MANAGEMENT_PROFILE = {
  profile_id: 'liquidity_sweep_reversal_short_management_v1',
  profile_version: MANAGEMENT_PROFILE_VERSION,
  strategy_id: 'liquidity_sweep_reversal_short',
  setup_family: 'liquidity_sweep_reversal',
  display_name: 'Liquidity Sweep Reversal Short Management V1',
  profile_hash: MANAGEMENT_PROFILE_HASH_PLACEHOLDER,
  initial_stop: {
    ...BASE_INITIAL_STOP,
    min_stop_distance_ticks: 2,
  },
  targets: BASE_TARGETS,
  break_even: BASE_BREAK_EVEN,
  trailing_stop: {
    enabled: true,
    mode: 'post_pt1_ticks',
    activation: 'after_pt1',
    distance_ticks: 6,
    action: 'ACTIVATE_TRAIL',
  },
  time_stop: {
    ...BASE_TIME_STOP,
    max_hold_minutes: 20,
  },
  fail_safe: BASE_FAIL_SAFE,
  partial_exit: BASE_PARTIAL_EXIT,
  reasons: [
    'management_profile:liquidity_sweep_reversal_short',
    'initial_stop:candidate_stop',
    'partials:pt1_50_pt2_50',
  ],
} as const satisfies ManagementProfile;

export const VWAP_OVERNIGHT_REVERSAL_LONG_MANAGEMENT_PROFILE = {
  profile_id: 'vwap_overnight_reversal_long_management_v1',
  profile_version: MANAGEMENT_PROFILE_VERSION,
  strategy_id: 'vwap_overnight_reversal_long',
  setup_family: 'vwap_overnight_reversal',
  display_name: 'VWAP Overnight Reversal Long Management V1',
  profile_hash: MANAGEMENT_PROFILE_HASH_PLACEHOLDER,
  initial_stop: BASE_INITIAL_STOP,
  targets: BASE_TARGETS,
  break_even: BASE_BREAK_EVEN,
  trailing_stop: {
    enabled: false,
    mode: 'disabled',
    activation: 'after_pt1',
    distance_ticks: 0,
    action: 'ACTIVATE_TRAIL',
  },
  time_stop: {
    ...BASE_TIME_STOP,
    max_hold_minutes: 30,
  },
  fail_safe: BASE_FAIL_SAFE,
  partial_exit: BASE_PARTIAL_EXIT,
  reasons: [
    'management_profile:vwap_overnight_reversal_long',
    'initial_stop:candidate_stop',
    'partials:pt1_50_pt2_50',
    'time_stop:30_minutes',
  ],
} as const satisfies ManagementProfile;

export const VWAP_OVERNIGHT_REVERSAL_SHORT_MANAGEMENT_PROFILE = {
  profile_id: 'vwap_overnight_reversal_short_management_v1',
  profile_version: MANAGEMENT_PROFILE_VERSION,
  strategy_id: 'vwap_overnight_reversal_short',
  setup_family: 'vwap_overnight_reversal',
  display_name: 'VWAP Overnight Reversal Short Management V1',
  profile_hash: MANAGEMENT_PROFILE_HASH_PLACEHOLDER,
  initial_stop: BASE_INITIAL_STOP,
  targets: BASE_TARGETS,
  break_even: BASE_BREAK_EVEN,
  trailing_stop: {
    enabled: false,
    mode: 'disabled',
    activation: 'after_pt1',
    distance_ticks: 0,
    action: 'ACTIVATE_TRAIL',
  },
  time_stop: {
    ...BASE_TIME_STOP,
    max_hold_minutes: 30,
  },
  fail_safe: BASE_FAIL_SAFE,
  partial_exit: BASE_PARTIAL_EXIT,
  reasons: [
    'management_profile:vwap_overnight_reversal_short',
    'initial_stop:candidate_stop',
    'partials:pt1_50_pt2_50',
    'time_stop:30_minutes',
  ],
} as const satisfies ManagementProfile;

export const REGIME_SHOCK_REVERSION_SHORT_V2_MANAGEMENT_PROFILE = {
  profile_id: 'regime_shock_reversion_short_v2_management_v1',
  profile_version: MANAGEMENT_PROFILE_VERSION,
  strategy_id: 'regime_shock_reversion_short_v2',
  setup_family: 'regime_shock_reversion',
  display_name: 'Regime Shock Reversion Short V2 Management V1',
  profile_hash: MANAGEMENT_PROFILE_HASH_PLACEHOLDER,
  initial_stop: BASE_INITIAL_STOP,
  targets: BASE_TARGETS,
  break_even: BASE_BREAK_EVEN,
  trailing_stop: {
    enabled: true,
    mode: 'post_pt1_ticks',
    activation: 'after_pt1',
    distance_ticks: 8,
    action: 'ACTIVATE_TRAIL',
  },
  time_stop: {
    ...BASE_TIME_STOP,
    max_hold_minutes: 25,
  },
  fail_safe: BASE_FAIL_SAFE,
  partial_exit: BASE_PARTIAL_EXIT,
  reasons: [
    'management_profile:regime_shock_reversion_short_v2',
    'initial_stop:candidate_stop',
    'partials:pt1_50_pt2_50',
  ],
} as const satisfies ManagementProfile;

export const REGIME_SHOCK_REVERSION_SHORT_V3_MANAGEMENT_PROFILE = {
  profile_id: 'regime_shock_reversion_short_v3_management_v1',
  profile_version: MANAGEMENT_PROFILE_VERSION,
  strategy_id: 'regime_shock_reversion_short_v3',
  setup_family: 'regime_shock_reversion',
  display_name: 'Regime Shock Reversion Short V3 Management V1',
  profile_hash: MANAGEMENT_PROFILE_HASH_PLACEHOLDER,
  initial_stop: BASE_INITIAL_STOP,
  targets: BASE_TARGETS,
  break_even: BASE_BREAK_EVEN,
  trailing_stop: {
    enabled: true,
    mode: 'post_pt1_ticks',
    activation: 'after_pt1',
    distance_ticks: 8,
    action: 'ACTIVATE_TRAIL',
  },
  time_stop: {
    ...BASE_TIME_STOP,
    max_hold_minutes: 25,
  },
  fail_safe: BASE_FAIL_SAFE,
  partial_exit: BASE_PARTIAL_EXIT,
  reasons: [
    'management_profile:regime_shock_reversion_short_v3',
    'initial_stop:candidate_stop',
    'partials:pt1_50_pt2_50',
  ],
} as const satisfies ManagementProfile;

export const FALLBACK_MANAGEMENT_PROFILE = {
  profile_id: 'fallback_management_v1',
  profile_version: MANAGEMENT_PROFILE_VERSION,
  strategy_id: 'fallback',
  setup_family: 'fallback',
  display_name: 'Fallback Management V1',
  profile_hash: MANAGEMENT_PROFILE_HASH_PLACEHOLDER,
  initial_stop: BASE_INITIAL_STOP,
  targets: BASE_TARGETS,
  break_even: BASE_BREAK_EVEN,
  trailing_stop: {
    enabled: false,
    mode: 'disabled',
    activation: 'after_pt1',
    distance_ticks: 0,
    action: 'ACTIVATE_TRAIL',
  },
  time_stop: {
    ...BASE_TIME_STOP,
    max_hold_minutes: 30,
  },
  fail_safe: BASE_FAIL_SAFE,
  partial_exit: BASE_PARTIAL_EXIT,
  reasons: [
    'management_profile:fallback',
    'fallback:unknown_strategy',
    'initial_stop:candidate_stop',
  ],
} as const satisfies ManagementProfile;

export const V1_MANAGEMENT_PROFILES = {
  trend_pullback_long: TREND_PULLBACK_LONG_MANAGEMENT_PROFILE,
  trend_pullback_short: TREND_PULLBACK_SHORT_MANAGEMENT_PROFILE,
  breakout_retest_long: BREAKOUT_RETEST_LONG_MANAGEMENT_PROFILE,
  breakdown_retest_short: BREAKDOWN_RETEST_SHORT_MANAGEMENT_PROFILE,
  regime_mean_reversion_long: REGIME_MEAN_REVERSION_LONG_MANAGEMENT_PROFILE,
  regime_mean_reversion_short: REGIME_MEAN_REVERSION_SHORT_MANAGEMENT_PROFILE,
  liquidity_sweep_reversal_long: LIQUIDITY_SWEEP_REVERSAL_LONG_MANAGEMENT_PROFILE,
  liquidity_sweep_reversal_short: LIQUIDITY_SWEEP_REVERSAL_SHORT_MANAGEMENT_PROFILE,
  vwap_overnight_reversal_long: VWAP_OVERNIGHT_REVERSAL_LONG_MANAGEMENT_PROFILE,
  vwap_overnight_reversal_short: VWAP_OVERNIGHT_REVERSAL_SHORT_MANAGEMENT_PROFILE,
  regime_shock_reversion_short_v2: REGIME_SHOCK_REVERSION_SHORT_V2_MANAGEMENT_PROFILE,
  regime_shock_reversion_short_v3: REGIME_SHOCK_REVERSION_SHORT_V3_MANAGEMENT_PROFILE,
} as const satisfies Readonly<Record<StrategyId, ManagementProfile>>;

export function resolveManagementProfile(
  strategyId: string,
  options: ResolveManagementProfileOptions = {},
): ResolvedManagementProfile {
  const allowFallback = options.allow_fallback ?? true;
  const profiles: Readonly<Partial<Record<StrategyId, ManagementProfile>>> =
    options.profiles ?? V1_MANAGEMENT_PROFILES;
  const fallback = options.fallback_profile ?? FALLBACK_MANAGEMENT_PROFILE;

  if (isStrategyId(strategyId)) {
    const profile = profiles[strategyId];
    if (profile !== undefined) {
      assertValidManagementProfile(profile);
      return {
        strategy_id: strategyId,
        profile,
        fallback_used: false,
        reasons: [
          `management_profile:${profile.profile_id}`,
          `management_profile_version:${profile.profile_version}`,
          'management_profile:resolved_by_strategy',
        ],
      };
    }
  }

  if (!allowFallback) {
    throw new Error(`Unknown strategy_id for management profile: ${strategyId}`);
  }

  assertValidManagementProfile(fallback);
  return {
    strategy_id: strategyId,
    profile: fallback,
    fallback_used: true,
    reasons: [
      `management_profile:${fallback.profile_id}`,
      `management_profile_version:${fallback.profile_version}`,
      'management_profile:fallback_used',
      `management_profile:unknown_strategy:${strategyId}`,
    ],
  };
}

export function validateAllDefaultManagementProfiles(): void {
  for (const profile of Object.values(V1_MANAGEMENT_PROFILES)) {
    assertValidManagementProfile(profile);
  }
  assertValidManagementProfile(FALLBACK_MANAGEMENT_PROFILE);
}
