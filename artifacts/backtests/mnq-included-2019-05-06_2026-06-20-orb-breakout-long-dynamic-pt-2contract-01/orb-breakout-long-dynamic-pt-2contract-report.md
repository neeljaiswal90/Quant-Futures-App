# QFA ORB breakout long dynamic PT 2-contract backtest - 2026-06-20

Determination: `ORB_BREAKOUT_LONG_DYNAMIC_PT_2CONTRACT_BACKTEST_COMPLETE_DIAGNOSTIC_ONLY`

## Scope

Research-only 2-contract management backtest for `opening_range_box_breakout_long`.

No broker action, no `ORDER_INTENT`, no runtime change, no paper/live authority, and no roster mutation are authorized.

## Dynamic target definitions

Targets are estimated walk-forward from prior trades only after 100 prior observations in the relevant universe.

```text
single PT = prior 60th percentile of winning-trade MFE120/R
PT1 = prior median of winning-trade MFE60/R
PT2 = prior 75th percentile of winning-trade MFE120/R
```

Path logic uses subsequent 1-minute bars after the signal minute. If stop and target are both touched in the same bar, the stop is counted first.

## Summary

| universe | management | trades | net_usd | profit_factor | win_rate | avg_trade_usd | max_drawdown_usd | pnl_to_max_drawdown | stop_hit_count | pt1_hit_count | pt2_hit_count | avg_pt_single_r | avg_pt1_r | avg_pt2_r |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all_breakout_long | original_2contract_scaled_after_warmup | 531 | 24600.5 | 1.4289 | 0.58 | 46.3286 | 3534.5 | 6.9601 | 0 | 0 | 0 | 0.736357 | 0.435054 | 0.991186 |
| all_breakout_long | single_dynamic_pt_2contracts | 531 | 16853.58 | 1.3129 | 0.6309 | 31.7393 | 3900 | 4.3214 | 130 | 236 | 0 | 0.736357 |  |  |
| all_breakout_long | two_dynamic_pt_1contract_each | 531 | 16589.03 | 1.3513 | 0.6384 | 31.2411 | 3290.69 | 5.0412 | 139 | 337 | 176 |  | 0.435054 | 0.991186 |
| prior_down_no_14_plus | original_2contract_scaled_after_warmup | 123 | 9797 | 1.7469 | 0.5772 | 79.6504 | 1843 | 5.3158 | 0 | 0 | 0 | 0.78259 | 0.4603 | 1.0721 |
| prior_down_no_14_plus | single_dynamic_pt_2contracts | 123 | 8861.17 | 1.7362 | 0.6341 | 72.0421 | 1556.54 | 5.6929 | 28 | 59 | 0 | 0.78259 |  |  |
| prior_down_no_14_plus | two_dynamic_pt_1contract_each | 123 | 8111.26 | 1.7865 | 0.6341 | 65.9452 | 956.97 | 8.476 | 30 | 84 | 41 |  | 0.4603 | 1.0721 |

## Interpretation

This is a management-only diagnostic. Dynamic targets are not fitted on the full sample. The preferred universe remains the prior-down/no-14:00+ subset if it remains superior after the management overlay.

## Artifacts

- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-dynamic-pt-2contract-01\orb-breakout-long-dynamic-pt-2contract-trades.csv`
- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-dynamic-pt-2contract-01\orb-breakout-long-dynamic-pt-2contract-summary.csv`
- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-dynamic-pt-2contract-01\orb-breakout-long-dynamic-pt-2contract-by-year.csv`
- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-dynamic-pt-2contract-01\orb-breakout-long-dynamic-pt-2contract-report.json`
- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-dynamic-pt-2contract-01\orb-breakout-long-dynamic-pt-2contract-report.md`
