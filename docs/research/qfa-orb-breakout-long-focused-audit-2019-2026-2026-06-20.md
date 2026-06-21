# QFA ORB breakout long focused audit - 2019-2026

## Disposition

`ORB_BREAKOUT_LONG_FOCUSED_AUDIT_COMPLETE_NO_PROMOTION_AUTHORITY`

The expanded-cache evidence supports focusing on `opening_range_box_breakout_long` over the broader ORB family. It is the strongest long-history ORB component.

The data does not support excluding 2020 or 2022. Both years are profitable for the long breakout leg. The actual max drawdown occurs in summer 2025.

## Source

```text
trade_ledger = artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-regime-nofade-riskgt30-daystop300/mnq-12mo-trades.csv
strategy_id = opening_range_box_breakout_long
cache = D:/QFA-cache/databento/mnq-continuous-included-2019-05-06_2026-06-20
```

Focused audit artifacts:

```text
artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-breakout-long-focused-audit-01
```

## Full-period performance

```text
trades = 631
net_pnl_usd = 13286.00
profit_factor = 1.4133
win_rate = 0.5753
avg_net_trade_usd = 21.06
median_net_trade_usd = 23.50
max_drawdown_usd = 1767.25
pnl_to_drawdown = 7.5179
```

This is materially stronger than the broader ORB portfolio because the short leg is structurally weak.

## Annual performance

| Year | Trades | Net USD | PF | Max DD | PnL/DD | Win rate | Avg/trade |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2019 | 49 | 39.75 | 1.0289 | 686.25 | 0.0579 | 0.5306 | 0.81 |
| 2020 | 109 | 1040.25 | 1.2179 | 429.50 | 2.4220 | 0.5596 | 9.54 |
| 2021 | 86 | 1199.75 | 1.2986 | 538.75 | 2.2269 | 0.5814 | 13.95 |
| 2022 | 90 | 2822.25 | 1.4589 | 831.50 | 3.3942 | 0.5556 | 31.36 |
| 2023 | 101 | 2101.25 | 1.4438 | 1417.00 | 1.4829 | 0.5644 | 20.80 |
| 2024 | 85 | 1919.00 | 1.4124 | 1133.25 | 1.6934 | 0.6000 | 22.58 |
| 2025 | 81 | 1990.75 | 1.4162 | 1767.25 | 1.1265 | 0.5926 | 24.58 |
| 2026 | 30 | 2173.00 | 2.3075 | 367.50 | 5.9129 | 0.6667 | 72.43 |

## Stress-year test

The user noted:

```text
2020 = COVID
2022 = bear market
```

Those years are not negative for `opening_range_box_breakout_long`:

| Period | Trades | Net USD | PF | Max DD | PnL/DD | Avg/trade |
|---|---:|---:|---:|---:|---:|---:|
| full 2019-2026 | 631 | 13286.00 | 1.4133 | 1767.25 | 7.5179 | 21.06 |
| exclude 2020 | 522 | 12245.75 | 1.4473 | 1767.25 | 6.9293 | 23.46 |
| exclude 2022 | 541 | 10463.75 | 1.4025 | 1767.25 | 5.9209 | 19.34 |
| exclude 2020 and 2022 | 432 | 9423.50 | 1.4440 | 1767.25 | 5.3323 | 21.81 |
| 2020 and 2022 only | 199 | 3862.50 | 1.3536 | 959.00 | 4.0276 | 19.41 |
| pre-2025 | 520 | 9122.25 | 1.3549 | 1417.00 | 6.4377 | 17.54 |
| 2025-2026 | 111 | 4163.75 | 1.6460 | 1767.25 | 2.3561 | 37.51 |

Interpretation:

Do not remove 2020 or 2022. They are useful stress-regime evidence, and both support the long breakout leg.

## Max drawdown audit

The full-period max drawdown is:

```text
max_drawdown_usd = 1767.25
peak_date = 2025-05-06
trough_date = 2025-08-18
peak_equity = 12195.75
trough_equity = 10428.50
```

The drawdown is a summer 2025 grind, not a COVID or 2022 bear-market failure.

Worst days inside the max-drawdown window:

| Date | Trades | Net USD | Equity | Drawdown |
|---|---:|---:|---:|---:|
| 2025-06-23 | 1 | -345.50 | 10781.25 | 1414.50 |
| 2025-06-05 | 1 | -300.50 | 11731.25 | 464.50 |
| 2025-06-13 | 1 | -269.50 | 11496.75 | 699.00 |
| 2025-07-09 | 1 | -242.50 | 10654.00 | 1541.75 |
| 2025-06-11 | 1 | -223.50 | 11647.00 | 548.75 |
| 2025-09-29 | 1 | -217.50 | 10977.00 | 1218.75 |
| 2025-06-18 | 1 | -202.50 | 11126.75 | 1069.00 |
| 2025-06-27 | 1 | -180.50 | 10940.00 | 1255.75 |
| 2025-06-17 | 1 | -172.00 | 11329.25 | 866.50 |
| 2025-08-18 | 1 | -170.50 | 10428.50 | 1767.25 |

## Research implication

The right next question is not:

```text
Should we remove 2020 or 2022?
```

The right next question is:

```text
What conditions made summer 2025 long breakouts fail repeatedly?
```

Candidate diagnostics to test next, without threshold optimization:

1. Opening range size relative to prior-session range.
2. First-30m volume ratio.
3. Breakout time bucket.
4. Prior-day trend state.
5. Gap direction and gap size.
6. VWAP distance at signal.
7. MFE/MAE in first 30/60/120 minutes.
8. Whether the trade is an early continuation breakout or late chase.

## Recommendation

Continue ORB research only on:

```text
opening_range_box_breakout_long
```

Drop the broader ORB portfolio framing for now.

Do not remove 2020 or 2022 from validation. Use them as stress-test regimes.

Next research ticket:

```text
QFA-ORB-BREAKOUT-LONG-DD-CONDITION-AUDIT-01
```

Goal:

```text
Identify ex-ante conditions behind the 2025 summer drawdown and quantify whether a simple, pre-registered filter can reduce drawdown without collapsing 2019-2026 profitability.
```

No broker, paper runtime, ORDER_INTENT, live trading, Phase 6, or roster authority is created by this research.
