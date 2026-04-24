# STRAT-04 Breakout Retest Long

`STRAT-04` extracts the V1 `breakout_retest_long` generator into the active strategy runtime.

## Setup Definition

The strategy looks for a bullish breakout that remains above the EMA stack, then accepts a retest/pullback near the breakout level and EMA9 support. It is distinct from `trend_pullback_long`: breakout context and retest proximity drive the setup, while pullback-ratio geometry is not required.

## Required Features

- `supertrend_direction = up`
- `ema_9`, `ema_21`, `ema_50`
- `sigma_pts`
- `breakout_level`
- `retest_hold = true`
- `nearest_resistance` for upside room and PT1
- `pivot_resistance_1` for PT2 when available
- upside flow from `z_ofi_blend` or microstructure `ofi_z`

## Gates And Rejection Reasons

- `breakout_retest_long:session_not_rth`
- `breakout_retest_long:session_halted`
- `breakout_retest_long:roll_block_active`
- `breakout_retest_long:structure_trend_not_up`
- `breakout_retest_long:supertrend_not_up`
- `breakout_retest_long:ema_stack_not_bullish`
- `breakout_retest_long:sigma_pts_invalid`
- `breakout_retest_long:breakout_level_missing`
- `breakout_retest_long:not_above_breakout_level`
- `breakout_retest_long:retest_not_confirmed`
- `breakout_retest_long:retest_distance_out_of_band`
- `breakout_retest_long:not_near_ema9`
- `breakout_retest_long:flow_confirmation_below_threshold`
- `breakout_retest_long:nearest_resistance_missing`
- `breakout_retest_long:insufficient_upside_room`
- `breakout_retest_long:non_positive_risk`
- `breakout_retest_long:targets_invalid`

## Candidate Output

The armed candidate includes:

- `strategy_id` and `setup_type` = `breakout_retest_long`;
- `setup_family` = `breakout_retest`;
- `direction` = `long`;
- `feature_snapshot_id`;
- deterministic entry from the breakout retest band;
- structure/sigma stop below EMA21;
- PT1 and PT2;
- `risk_points` and per-target `reward_risk`;
- gate/reason metadata;
- deterministic confidence.

## STRAT-07 Migration Note

Thresholds are named constants in this extraction pass. `STRAT-07` will move tuning values into typed strategy config under `config/strategies/` while preserving these defaults as the initial baseline.
