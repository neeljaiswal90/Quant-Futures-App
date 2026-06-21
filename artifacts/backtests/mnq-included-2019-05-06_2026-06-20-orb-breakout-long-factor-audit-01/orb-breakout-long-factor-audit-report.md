# ORB breakout long factor audit

Determination: `ORB_BREAKOUT_LONG_FACTOR_AUDIT_COMPLETE_NO_PROMOTION_AUTHORITY`

## Scope

Strategy: `opening_range_box_breakout_long`

Factors audited: opening range size/prior range, first30 volume ratio, breakout time bucket, prior-day trend state, gap size/direction, VWAP distance at signal, 30/60/120m MFE/MAE, and early continuation vs late chase.

No strategy promotion, broker authority, ORDER_INTENT, or roster mutation is authorized by this artifact.

## Win/loss factor comparison

| Outcome | Trades | Net USD | PF | Avg OR/prior | Avg first30 vol ratio | Avg gap/prior | Avg VWAP dist ATR | Avg MFE 60m | Avg MAE 60m | Avg MFE60/risk | Avg MAE60/risk |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| win | 363 | 45436 |  | 0.587652 | 0.963969 | 0.015216 | 4.082715 | 42.1804 | 24.8678 | 0.5177 | 0.289825 |
| loss | 267 | -32150 | 0 | 0.549187 | 0.94312 | -0.012486 | 3.330477 | 25.6301 | 54.4654 | 0.329461 | 0.712335 |
| flat | 1 | 0 |  | 0.118821 | 0.122912 | 0.032319 | 3.699805 | 24 | 3.5 | 0.744186 | 0.108527 |
| all | 631 | 13286 | 1.4133 | 0.570633 | 0.953814 | 0.003521 | 3.763808 | 35.1486 | 37.3578 | 0.438408 | 0.468317 |

## Artifacts

- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-factor-audit-01\orb-breakout-long-factor-trades.csv`
- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-factor-audit-01\orb-breakout-long-win-loss-factor-comparison.csv`
- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-factor-audit-01\orb-breakout-long-factor-bucket-summary.csv`
- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-factor-audit-01\orb-breakout-long-factor-audit-report.json`
