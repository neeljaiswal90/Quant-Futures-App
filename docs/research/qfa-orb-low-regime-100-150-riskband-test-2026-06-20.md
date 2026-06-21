# QFA ORB low-regime 100-150 risk-band exclusion test - 2026-06-20

## Disposition

`ORB_LOW_REGIME_100_150_RISKBAND_TEST_COMPLETE_REJECT_EXPANDED_HISTORY`

Rule tested exactly:

```text
regime_label == low
100 < abs(entry_price - stop_price) <= 150
```

This rule is rejected as a promotion candidate. It improves the recent 12-month slice but fails on expanded 2019-2026 history. The directly excluded stream is profitable over the expanded cache.

## Artifacts

```text
artifacts/backtests/orb-low-regime-100-150-riskband-test-2026-06-20/low-regime-100-150-test-summary.csv
artifacts/backtests/orb-low-regime-100-150-riskband-test-2026-06-20/low-regime-100-150-excluded-trades.csv
artifacts/backtests/orb-low-regime-100-150-riskband-test-2026-06-20/low-regime-100-150-by-strategy.csv
artifacts/backtests/orb-low-regime-100-150-riskband-test-2026-06-20/low-regime-100-150-periods.csv
artifacts/backtests/orb-low-regime-100-150-riskband-test-2026-06-20/low-regime-100-150-test-report.json
```

## Recent 12-month result

Source ledgers:

```text
baseline = artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-regime-nofade-riskgt30-daystop300/mnq-12mo-trades.csv
exclusion = artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-regime-nofade-riskgt30-low-excl100to150-daystop300/mnq-12mo-trades.csv
```

| Row | Trades | Net USD | PF | Max DD | PnL/DD | Win rate | Avg/trade | t-stat |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline | 254 | 5558.50 | 1.3167 | 3400.25 | 1.6347 | 0.5433 | 21.8839 | 1.6786 |
| exclusion scenario | 215 | 7485.00 | 1.5704 | 2886.50 | 2.5931 | 0.5581 | 34.8140 | 2.4776 |
| direct excluded stream | 53 | -1357.00 | 0.7505 | 2510.50 | -0.5405 | 0.4906 | -25.6038 | -0.8950 |
| exclusion minus baseline | -39 | +1926.50 |  | -513.75 |  |  |  |  |

Recent-slice interpretation:

The rule appears helpful in the 12-month sample because the direct excluded stream is negative:

```text
direct excluded stream = 53 trades / -1357.00 / PF 0.7505
```

But the direct-stream t-stat is only `-0.8950`, so even in the recent sample it is not statistically strong.

## Expanded 2019-2026 result

Source ledgers:

```text
baseline = artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-regime-nofade-riskgt30-daystop300/mnq-12mo-trades.csv
exclusion = artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-regime-nofade-riskgt30-low-excl100to150-daystop300/mnq-12mo-trades.csv
```

| Row | Trades | Net USD | PF | Max DD | PnL/DD | Win rate | Avg/trade | t-stat |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline | 2094 | 23580.00 | 1.1934 | 5068.75 | 4.6520 | 0.5148 | 11.2607 | 3.1606 |
| exclusion scenario | 1851 | 18304.25 | 1.1759 | 5252.75 | 3.4847 | 0.5057 | 9.8888 | 2.6893 |
| direct excluded stream | 303 | 7155.25 | 1.3404 | 4087.25 | 1.7506 | 0.5842 | 23.6147 | 2.1663 |
| exclusion minus baseline | -243 | -5275.75 |  | +184.00 |  |  |  |  |

Expanded-history interpretation:

The rule fails. The direct excluded stream is profitable:

```text
direct excluded stream = 303 trades / +7155.25 / PF 1.3404 / t-stat 2.1663
```

Excluding it reduces full-sample net by:

```text
scenario delta = -5275.75
```

It also worsens drawdown:

```text
baseline max DD = 5068.75
exclusion max DD = 5252.75
DD delta = +184.00
```

## By strategy

### Recent 12-month direct excluded stream

| Strategy | Trades | Net USD | PF | Win rate | Avg/trade | t-stat |
|---|---:|---:|---:|---:|---:|---:|
| opening_range_box_breakout_long | 20 | -342.50 | 0.8049 | 0.5500 | -17.1250 | -0.4082 |
| opening_range_box_regime_long | 33 | -1014.50 | 0.7245 | 0.4545 | -30.7424 | -0.7937 |

### Expanded 2019-2026 direct excluded stream

| Strategy | Trades | Net USD | PF | Win rate | Avg/trade | t-stat |
|---|---:|---:|---:|---:|---:|---:|
| opening_range_box_breakout_long | 131 | 2882.25 | 1.3212 | 0.5878 | 22.0019 | 1.3499 |
| opening_range_box_regime_long | 172 | 4273.00 | 1.3547 | 0.5814 | 24.8430 | 1.6908 |

The expanded direct excluded stream is positive for both low-regime long strategies.

## Period stability

Expanded-history direct excluded stream:

| Period | Trades | Net USD | PF | Win rate | Avg/trade | t-stat |
|---|---:|---:|---:|---:|---:|---:|
| 2019-2024 | 211 | 7668.75 | 1.5946 | 0.6209 | 36.3448 | 2.9126 |
| 2025-2026 | 92 | -513.50 | 0.9368 | 0.5000 | -5.5815 | -0.2599 |
| 2020 only | 21 | 1396.75 | 2.5872 | 0.7143 | 66.5119 | 1.8526 |
| 2022 only | 79 | 2528.50 | 1.4128 | 0.5696 | 32.0063 | 1.3356 |
| 2026 only | 32 | -348.25 | 0.8932 | 0.5625 | -10.8828 | -0.2704 |

This confirms the rule is recent-regime-specific:

```text
2019-2024 direct excluded stream is strongly positive.
2025-2026 direct excluded stream is slightly negative.
```

## Conclusion

Reject the exact low-regime `100:150` risk-band exclusion.

Reason:

```text
The rule removes a profitable expanded-history stream.
The recent 12-month benefit is not stable across the full available cache.
The direct excluded stream flips from negative recently to positive over 2019-2024.
```

Do not use this rule for promotion, shadow selection, or roster changes.

## Recommended next step

Continue focusing on:

```text
opening_range_box_breakout_long
```

Do not use raw point-band exclusions. If risk normalization remains under study, use a pre-registered, scale-aware feature such as:

```text
risk_points / prior_session_range
risk_points / ATR14
```

But the next audit should target the actual drawdown cluster:

```text
2025-05-06 peak to 2025-08-18 trough
```

No broker, paper runtime, ORDER_INTENT, live trading, Phase 6, or roster authority is created by this research.
