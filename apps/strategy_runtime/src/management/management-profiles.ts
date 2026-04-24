import type { IndicatorConfig } from '../contracts/config.js';
import type { SetupFamily, SetupType, MarketRegime } from '../contracts/candidate.js';
import type { ContractSpec } from '../risk/contracts.js';
import { priceToTicks } from '../risk/contracts.js';
import type { ManagementProfile, ResolvedManagementParams } from './types.js';

const FAMILY_MAP: Record<SetupType, SetupFamily> = {
  trend_pullback_long: 'trend_pullback',
  trend_pullback_short: 'trend_pullback',
  breakout_retest_long: 'breakout_retest',
  breakdown_retest_short: 'breakout_retest',
};

export function getSetupFamily(setupType: SetupType): SetupFamily {
  return FAMILY_MAP[setupType] ?? 'default';
}

export function getManagementProfile(
  setupType: SetupType,
  regime: MarketRegime,
  config: IndicatorConfig,
): ManagementProfile {
  const family = getSetupFamily(setupType);
  const profiles = config.management_profiles;
  let profile: ManagementProfile | null = null;

  if (profiles?.[family]) {
    profile = { ...profiles[family] };
  } else if (profiles?.default) {
    profile = { ...profiles.default };
  } else {
    profile = buildDefaultProfileFromConfig(config);
  }

  const variantName = config.active_management_variant;
  const variants = config.management_profile_variants;
  if (variantName && variants?.[variantName]?.[family]) {
    profile = { ...profile, ...variants[variantName][family] };
  }

  validateScalperManagementProfile(profile);
  return profile;
}

export function buildDefaultProfileFromConfig(config: IndicatorConfig): ManagementProfile {
  return {
    name: 'legacy_default',
    family: 'default',
    pt1_offset_atr: 0,
    pt2_offset_atr: 0,
    pt1_offset_pts_fallback: config.pt1_offset_pts,
    pt2_offset_pts_fallback: config.pt2_offset_pts,
    pt1_exit_fraction: config.pt1_exit_fraction,
    pt2_exit_fraction: config.pt2_exit_fraction,
    pt1_move_to_be: config.pt1_move_to_be,
    pt1_activate_trailing: config.pt1_activate_trailing,
    trail_atr_post_t1: 0,
    trail_ticks_post_t1_fallback: config.trail_ticks_post_t1,
    breakeven_trigger_r: config.breakeven_trigger_r,
    pre_t1_trail_trigger_r: config.pre_t1_trail_trigger_r,
    pre_t1_trail_atr: 0,
    pre_t1_trail_ticks_fallback: config.pre_t1_trail_distance_ticks,
    time_stop_minutes: config.time_stop_minutes,
    time_stop_max_r_pre_t1: config.time_stop_max_r_pre_t1,
    time_stop_max_r_post_t1: config.time_stop_max_r_post_t1,
  };
}

export function resolveProfile(
  profile: ManagementProfile,
  atr: number | null,
  contract: ContractSpec,
): ResolvedManagementParams {
  const atrValid = atr !== null && atr > 0;
  const minOffset = contract.tick_size;

  const pt1Raw = profile.pt1_offset_atr > 0 && atrValid
    ? atr * profile.pt1_offset_atr
    : profile.pt1_offset_pts_fallback;
  const pt2Raw = profile.pt2_offset_atr > 0 && atrValid
    ? atr * profile.pt2_offset_atr
    : profile.pt2_offset_pts_fallback;
  const ptDisabled = pt1Raw === 0 && pt2Raw === 0;
  const trailPtsRaw = profile.trail_atr_post_t1 > 0 && atrValid
    ? atr * profile.trail_atr_post_t1
    : null;
  const preT1TrailPtsRaw = profile.pre_t1_trail_atr > 0 && atrValid
    ? atr * profile.pre_t1_trail_atr
    : null;

  const pt1Pts = ptDisabled ? 0 : Math.max(minOffset, pt1Raw);
  let pt2Pts = ptDisabled ? 0 : Math.max(minOffset, pt2Raw);
  if (!ptDisabled) {
    pt2Pts = Math.max(pt2Pts, pt1Pts + 4 * contract.tick_size);
  }

  const trailTicks = trailPtsRaw !== null
    ? Math.max(1, priceToTicks(trailPtsRaw, contract))
    : Math.max(1, profile.trail_ticks_post_t1_fallback);
  const preT1TrailTicks = preT1TrailPtsRaw !== null
    ? Math.max(1, priceToTicks(preT1TrailPtsRaw, contract))
    : Math.max(1, profile.pre_t1_trail_ticks_fallback);

  return {
    profile_name: profile.name,
    family: profile.family,
    atr_at_entry: atr,
    pt1_offset_pts: pt1Pts,
    pt2_offset_pts: pt2Pts,
    pt1_exit_fraction: profile.pt1_exit_fraction,
    pt2_exit_fraction: profile.pt2_exit_fraction,
    pt1_move_to_be: profile.pt1_move_to_be,
    pt1_activate_trailing: profile.pt1_activate_trailing,
    trail_ticks_post_t1: trailTicks,
    breakeven_trigger_r: profile.breakeven_trigger_r,
    pre_t1_trail_trigger_r: profile.pre_t1_trail_trigger_r,
    pre_t1_trail_distance_ticks: preT1TrailTicks,
    time_stop_minutes: profile.time_stop_minutes,
    time_stop_max_r_pre_t1: profile.time_stop_max_r_pre_t1,
    time_stop_max_r_post_t1: profile.time_stop_max_r_post_t1,
    pre_t1_failure_exit_enabled: profile.pre_t1_failure_exit_enabled ?? false,
    pre_t1_failure_shadow_mode: profile.pre_t1_failure_shadow_mode ?? true,
    pre_t1_failure_decay_min_gap_minutes: profile.pre_t1_failure_decay_min_gap_minutes ?? 0.5,
    pre_t1_failure_lambda_net: profile.pre_t1_failure_lambda_net ?? 1.0,
    pre_t1_failure_soft_min_minutes: profile.pre_t1_failure_soft_min_minutes ?? 4,
    pre_t1_failure_soft_progress_rate_max: profile.pre_t1_failure_soft_progress_rate_max ?? 0.05,
    pre_t1_failure_soft_failure_ratio_min: profile.pre_t1_failure_soft_failure_ratio_min ?? 2.0,
    pre_t1_failure_hard_min_minutes: profile.pre_t1_failure_hard_min_minutes ?? 5,
    pre_t1_failure_hard_current_r_alpha: profile.pre_t1_failure_hard_current_r_alpha ?? 0.4,
    pre_t1_failure_curves_key: profile.pre_t1_failure_curves_key ?? profile.family,
    pre_t1_failure_min_n_per_bucket: profile.pre_t1_failure_min_n_per_bucket ?? 20,
    pre_t1_failure_emergency_min_minutes: profile.pre_t1_failure_emergency_min_minutes ?? 3,
    pre_t1_failure_emergency_mae_r_floor: profile.pre_t1_failure_emergency_mae_r_floor ?? 0.2,
    pre_t1_failure_emergency_failure_ratio_min:
      profile.pre_t1_failure_emergency_failure_ratio_min ?? 4.0,
    pre_t1_failure_emergency_peak_r_max: profile.pre_t1_failure_emergency_peak_r_max ?? 0.1,
    pre_t1_failure_emergency_decay_rate_min:
      profile.pre_t1_failure_emergency_decay_rate_min ?? 0,
    pre_t1_failure_cost_r: profile.pre_t1_failure_cost_r ?? 0.05,
    time_stop_seconds:
      profile.family === 'lob_mbo_scalp'
        ? profile.time_stop_seconds ?? 10
        : profile.time_stop_seconds ?? null,
    scalper_hard_cap_seconds:
      profile.family === 'lob_mbo_scalp'
        ? profile.scalper_hard_cap_seconds ?? 5
        : profile.scalper_hard_cap_seconds ?? null,
    scalper_no_progress_seconds:
      profile.family === 'lob_mbo_scalp'
        ? profile.scalper_no_progress_seconds ?? 2
        : profile.scalper_no_progress_seconds ?? null,
    scalper_micro_stop_min_ticks:
      profile.family === 'lob_mbo_scalp'
        ? profile.scalper_micro_stop_min_ticks ?? 2
        : profile.scalper_micro_stop_min_ticks ?? null,
    scalper_micro_stop_max_ticks:
      profile.family === 'lob_mbo_scalp'
        ? profile.scalper_micro_stop_max_ticks ?? 6
        : profile.scalper_micro_stop_max_ticks ?? null,
  };
}

export function validateScalperManagementProfile(profile: ManagementProfile): void {
  if (profile.family !== 'lob_mbo_scalp') return;
  const isPositive = (value: number | null | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;

  const base = profile.scalper_hard_cap_seconds ?? null;
  const extended = profile.time_stop_seconds ?? null;
  const noProgress = profile.scalper_no_progress_seconds ?? null;
  const minTicks = profile.scalper_micro_stop_min_ticks ?? null;
  const maxTicks = profile.scalper_micro_stop_max_ticks ?? null;

  if (base !== null && !isPositive(base)) {
    throw new Error(`invalid scalper_hard_cap_seconds for profile '${profile.name}'`);
  }
  if (extended !== null && !isPositive(extended)) {
    throw new Error(`invalid time_stop_seconds for profile '${profile.name}'`);
  }
  if (noProgress !== null && !isPositive(noProgress)) {
    throw new Error(`invalid scalper_no_progress_seconds for profile '${profile.name}'`);
  }
  if (minTicks !== null && !isPositive(minTicks)) {
    throw new Error(`invalid scalper_micro_stop_min_ticks for profile '${profile.name}'`);
  }
  if (maxTicks !== null && !isPositive(maxTicks)) {
    throw new Error(`invalid scalper_micro_stop_max_ticks for profile '${profile.name}'`);
  }
  if (isPositive(extended) && isPositive(base) && extended < base) {
    throw new Error(`time_stop_seconds must be >= scalper_hard_cap_seconds for '${profile.name}'`);
  }
  if (isPositive(noProgress) && isPositive(base) && noProgress >= base) {
    throw new Error(`scalper_no_progress_seconds must be < scalper_hard_cap_seconds for '${profile.name}'`);
  }
  if (isPositive(minTicks) && isPositive(maxTicks) && minTicks > maxTicks) {
    throw new Error(`scalper_micro_stop_min_ticks must be <= scalper_micro_stop_max_ticks for '${profile.name}'`);
  }
}
