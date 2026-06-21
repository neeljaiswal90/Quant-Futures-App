# QFA ORB breakout long time, trend, and management audit - 2026-06-20

Determination: `ORB_BREAKOUT_LONG_TIME_PRIOR_TREND_MANAGEMENT_AUDIT_COMPLETE_DIAGNOSTIC_ONLY`

## Scope and guardrails

This is a diagnostic-only pass for `opening_range_box_breakout_long` over the expanded cache trade-level factor artifact.

No broker action, no `ORDER_INTENT`, no paper/live authority, no roster mutation, and no strategy promotion are authorized by this report.

The scenario set was fixed before running this pass:

```text
exclude 14:00+ breakout entries
test prior-day trend conditioning
inspect broad OR/prior buckets
audit 30/60/120m MFE/MAE management diagnostics
```

Management diagnostics are ex-post path statistics. They do not prove an executable intrabar stop or exit without a later path-ordered simulation.

## Scenario summary

| scenario |selected_trades |removed_trades |removed_net_usd |net_usd |profit_factor |win_rate |avg_net_usd |max_drawdown_usd |pnl_to_max_drawdown |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| baseline_all_breakout_long |631 |0 |0 |13286 |1.4133 |0.5753 |21.0555 |1767.25 |7.5179 |
| exclude_14_plus |561 |70 |-595.25 |13881.25 |1.4684 |0.5793 |24.7438 |1761.75 |7.8792 |
| exclude_late_chase_13_plus |519 |112 |-41.25 |13327.25 |1.4821 |0.5742 |25.6787 |1719.25 |7.7518 |
| prior_down_family_only |245 |386 |3956.25 |9329.75 |1.7851 |0.5959 |38.0806 |921.5 |10.1245 |
| prior_up_family_only_contrast |383 |248 |9607.75 |3678.25 |1.1815 |0.5587 |9.6038 |2363.5 |1.5563 |
| exclude_or_prior_gt_075 |538 |93 |289 |12997 |1.4947 |0.5725 |24.158 |1155 |11.2528 |

## Management diagnostics

| diagnostic |flagged_trades |flagged_net_usd |flagged_avg_net_usd |not_flagged_net_usd |not_flagged_avg_net_usd |loss_capture_rate |win_false_positive_rate |flagged_profit_factor |not_flagged_profit_factor |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| mae30_ge_050_risk |156 |-8470.25 |-54.2965 |21756.25 |45.8026 |0.3933 |0.1405 |0.399 |2.2049 |
| mae30_ge_075_risk |55 |-6016 |-109.3818 |19302 |33.5104 |0.1835 |0.0165 |0.1095 |1.7601 |
| mae60_ge_050_risk |216 |-12853 |-59.5046 |26139 |62.9855 |0.5506 |0.1901 |0.3628 |3.1822 |
| mae60_ge_075_risk |111 |-12990.75 |-117.0338 |26276.75 |50.5322 |0.3708 |0.0331 |0.0937 |2.4749 |
| mfe60_lt_025_risk |215 |-10489.5 |-48.7884 |23775.5 |57.1526 |0.5019 |0.2231 |0.4068 |2.6435 |
| mfe60_lt_050_risk |425 |-5488.75 |-12.9147 |18774.75 |91.1396 |0.8165 |0.5702 |0.8017 |5.2035 |
| early_failure_mae60_ge050_mfe60_lt050 |186 |-13928.25 |-74.8831 |27214.25 |61.1556 |0.5056 |0.1405 |0.253 |3.0151 |

## Interpretation

The most defensible entry-side finding is the `14:00+` avoid-zone. It removes a negative subset without using a narrow price/risk boundary.

Prior-day trend conditioning is materially stronger after prior-session weakness. Treat this as a broad contextual feature, not a standalone promotion rule until it is validated forward.

The management diagnostics show that early adverse excursion and continuation failure are meaningful separators, but the current artifact does not preserve path ordering inside the 30/60/120m windows. A later executable management test must use minute-by-minute path ordering before claiming live stop/exit feasibility.

## Artifacts

- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-time-prior-trend-management-audit-01\orb-breakout-long-scenario-summary.csv`
- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-time-prior-trend-management-audit-01\orb-breakout-long-factor-summary.csv`
- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-time-prior-trend-management-audit-01\orb-breakout-long-management-diagnostic-summary.csv`
- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-time-prior-trend-management-audit-01\orb-breakout-long-time-prior-trend-management-report.json`
- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-time-prior-trend-management-audit-01\orb-breakout-long-time-prior-trend-management-report.md`
