# QFA ORB breakout long path risk-control audit - 2026-06-20

Determination: `ORB_BREAKOUT_LONG_PATH_RISK_CONTROL_AUDIT_COMPLETE_DIAGNOSTIC_ONLY`

## Scope

This audit applies the fixed next-step contract:

```text
avoid 14:00+ long ORB entries
treat prior_down / prior_down_large as preferred context
do not promote raw OR/prior filters
investigate path-ordered MAE60 risk control
```

No broker action, no `ORDER_INTENT`, no paper/live authority, no roster mutation, and no strategy promotion are authorized.

## Path-control modeling caveats

The path stop scans subsequent 1-minute bars after the signal minute through 60 minutes. The signal minute itself is excluded to avoid treating pre-entry low as a stop hit. If a later 1-minute bar crosses the stop, the overlay exits at `entry - stopMultiple * initialRisk` and applies the observed round-turn cost from the source trade.

This is still diagnostic. It does not simulate daily stop interaction, sequential re-entry changes, or intrabar event ordering inside a 1-minute bar.

## Scenario summary

| scenario | trades | original_net_usd | adjusted_net_usd | delta_usd | profit_factor | win_rate | avg_adjusted_net_usd | max_drawdown_usd | pnl_to_max_drawdown | path_stop_hits | path_stop_hit_rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline_all_no_path_stop | 631 | 13286 | 13286 | 0 | 1.4133 | 0.5753 | 21.0555 | 1767.25 | 7.5179 | 0 | 0 |
| exclude_14_plus_no_path_stop | 561 | 13881.25 | 13881.25 | 0 | 1.4684 | 0.5793 | 24.7438 | 1761.75 | 7.8792 | 0 | 0 |
| prior_down_family_no_path_stop | 245 | 9329.75 | 9329.75 | 0 | 1.7851 | 0.5959 | 38.0806 | 921.5 | 10.1245 | 0 | 0 |
| exclude_14_plus_and_prior_down_family_no_path_stop | 223 | 9397 | 9397 | 0 | 1.8457 | 0.5964 | 42.139 | 921.5 | 10.1975 | 0 | 0 |
| baseline_path_stop_mae60_075risk | 631 | 13286 | 13478.75 | 192.75 | 1.4403 | 0.5563 | 21.3609 | 1718 | 7.8456 | 111 | 0.1759 |
| exclude_14_plus_path_stop_mae60_075risk | 561 | 13881.25 | 13900.13 | 18.88 | 1.4917 | 0.5579 | 24.7774 | 1712.5 | 8.1169 | 99 | 0.1765 |
| prior_down_family_path_stop_mae60_075risk | 245 | 9329.75 | 9593.5 | 263.75 | 1.8712 | 0.5796 | 39.1571 | 769.13 | 12.4733 | 43 | 0.1755 |
| exclude_14_plus_and_prior_down_family_path_stop_mae60_075risk | 223 | 9397 | 9572.13 | 175.13 | 1.9268 | 0.5785 | 42.9243 | 769.13 | 12.4455 | 40 | 0.1794 |
| baseline_path_stop_mae60_050risk_diagnostic | 631 | 13286 | 8501.75 | -4784.25 | 1.2871 | 0.4659 | 13.4735 | 2066 | 4.1151 | 216 | 0.3423 |
| exclude_14_plus_and_prior_down_family_path_stop_mae60_050risk_diagnostic | 223 | 9397 | 7230.25 | -2166.75 | 1.7259 | 0.4933 | 32.4226 | 1044 | 6.9255 | 76 | 0.3408 |

## Interpretation

The 14:00+ exclusion is additive but modest. Prior-down context is a materially stronger selector than time alone. The 75% MAE60 path stop modestly improves the historical prior-down profile table metrics, but the delta is small and should be treated as statistically inconclusive. It should remain log-only until forward evidence supports it.

The tighter 50% stop is included only as a diagnostic stress test. It materially reduces drawdown in the combined profile but gives up too much net in the broad baseline. It should not be promoted without a future validation sample.

Raw OR/prior filters remain unpromoted in this pass.

## Artifacts

- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-path-risk-control-audit-01\orb-breakout-long-path-risk-control-overlay-trades.csv`
- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-path-risk-control-audit-01\orb-breakout-long-path-risk-control-scenario-summary.csv`
- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-path-risk-control-audit-01\orb-breakout-long-path-risk-control-report.json`
- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-path-risk-control-audit-01\orb-breakout-long-path-risk-control-report.md`
