# STRAT-05 Breakdown Retest Short

`STRAT-05` extracts the V1 `breakdown_retest_short` generator into the active strategy runtime.

## Setup Definition

The strategy looks for a bearish breakdown that remains below the EMA stack, then accepts a retest/rejection near broken support acting as resistance. It is distinct from `trend_pullback_short`: breakdown context and retest rejection drive the setup, while pullback-ratio geometry is not required.

## Required Features

- `supertrend_direction = down`
- `ema_9`, `ema_21`, `ema_50`
- `sigma_pts`
- `broken_support`
- `retest_reject = true`
- `choch_buy` or `nearest_support` for downside room and PT1
- `pivot_support_1` for PT2 when available
- downside flow from `z_ofi_blend` or microstructure `ofi_z`

## Producer Contract Note

Future feature producers must emit `structure.values.broken_support`, `structure.values.retest_reject`, `structure.values.choch_buy`, and optionally `structure.values.pivot_support_1` for this generator to arm.

## Gates And Rejection Reasons

- `breakdown_retest_short:session_not_rth`
- `breakdown_retest_short:session_halted`
- `breakdown_retest_short:roll_block_active`
- `breakdown_retest_short:structure_trend_not_down`
- `breakdown_retest_short:supertrend_not_down`
- `breakdown_retest_short:ema_stack_not_bearish`
- `breakdown_retest_short:sigma_pts_invalid`
- `breakdown_retest_short:broken_support_missing`
- `breakdown_retest_short:not_below_broken_support`
- `breakdown_retest_short:retest_not_rejected`
- `breakdown_retest_short:retest_distance_out_of_band`
- `breakdown_retest_short:not_near_ema9`
- `breakdown_retest_short:flow_confirmation_below_threshold`
- `breakdown_retest_short:nearest_support_missing`
- `breakdown_retest_short:insufficient_downside_room`
- `breakdown_retest_short:non_positive_risk`
- `breakdown_retest_short:targets_invalid`

## Candidate Output

The armed candidate includes:

- `strategy_id` and `setup_type` = `breakdown_retest_short`;
- `setup_family` = `breakout_retest`;
- `direction` = `short`;
- `feature_snapshot_id`;
- deterministic entry from the breakdown retest rejection band;
- structure/sigma stop above EMA21;
- PT1 and PT2;
- `risk_points` and per-target `reward_risk`;
- gate/reason metadata;
- deterministic confidence.

## STRAT-07 Migration Note

Thresholds are named constants in this extraction pass. `STRAT-07` will move tuning values into typed strategy config under `config/strategies/` while preserving these defaults as the initial baseline.
