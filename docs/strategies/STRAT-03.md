# STRAT-03 Trend Pullback Short

`STRAT-03` extracts the V1 `trend_pullback_short` generator into the active strategy runtime.

## Scope

- Active strategy: `trend_pullback_short` only.
- Input contract: `StrategyEvaluationInput` with a `StrategyFeatureSnapshot`.
- Output contract: `StrategyGenerationResult` containing a `StrategyEvaluation` and, when armed, a short `Candidate`.
- Registry status: `trend_pullback_long` and `trend_pullback_short` are active; `breakout_retest_long` and `breakdown_retest_short` remain `pending_extraction`.

## Required Features

- `supertrend_direction = down`
- `ema_9`, `ema_21`, `ema_50`
- `sigma_pts`
- `z_ema9`
- `pullback_ratio`
- downside flow from `z_ofi_blend`, or inverted microstructure `ofi_z` if the blended value is unavailable
- `nearest_support` for the downside room gate
- `choch_buy` or `nearest_support` for PT1/PT2 construction

## Gates And Rejection Reasons

- `trend_pullback_short:session_not_rth`
- `trend_pullback_short:session_halted`
- `trend_pullback_short:roll_block_active`
- `trend_pullback_short:structure_trend_not_down`
- `trend_pullback_short:supertrend_not_down`
- `trend_pullback_short:ema_stack_not_bearish`
- `trend_pullback_short:sigma_pts_invalid`
- `trend_pullback_short:z_ema9_out_of_band`
- `trend_pullback_short:pullback_ratio_out_of_band`
- `trend_pullback_short:flow_confirmation_below_threshold`
- `trend_pullback_short:insufficient_downside_room`
- `trend_pullback_short:non_positive_risk`
- `trend_pullback_short:targets_invalid`

## Candidate Output

The armed candidate includes:

- `strategy_id` and `setup_type` = `trend_pullback_short`;
- `setup_family` = `trend_pullback`;
- `direction` = `short`;
- `feature_snapshot_id`;
- deterministic entry, sigma-based stop, PT1, and PT2;
- `risk_points` and per-target `reward_risk`;
- gate/reason metadata;
- deterministic confidence.

## STRAT-07 Migration Note

Thresholds are named constants in this extraction pass. `STRAT-07` will move tuning values into typed strategy config under `config/strategies/` while preserving these defaults as the initial baseline.
