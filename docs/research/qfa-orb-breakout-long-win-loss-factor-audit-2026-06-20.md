# QFA ORB breakout long win/loss factor audit - 2026-06-20

## Disposition

`ORB_BREAKOUT_LONG_WIN_LOSS_FACTOR_AUDIT_COMPLETE_NO_PROMOTION_AUTHORITY`

This audit compares winning and losing trades for:

```text
strategy_id = opening_range_box_breakout_long
data = D:/QFA-cache/databento/mnq-continuous-included-2019-05-06_2026-06-20/ohlcv-1m
trade_ledger = artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-regime-nofade-riskgt30-daystop300/mnq-12mo-trades.csv
```

Factors audited:

```text
opening range size / prior range
first30 volume ratio
breakout time bucket
prior-day trend state
gap size and direction
VWAP distance at signal
30/60/120m MFE/MAE
early continuation vs late chase
```

Guardrail:

This is an explanatory factor audit only. It does not select new thresholds, promote a strategy, or authorize broker/paper/live/ORDER_INTENT activity.

## Overall win/loss comparison

| Outcome | Trades | Net USD | Avg/trade | Avg OR/prior | Avg first30 vol ratio | Avg gap/prior | Avg VWAP dist ATR | Avg MFE 60m | Avg MAE 60m | Avg MFE60/risk | Avg MAE60/risk |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| win | 363 | 45436.00 | 125.1680 | 0.587652 | 0.963969 | 0.015216 | 4.082715 | 42.1804 | 24.8678 | 0.517700 | 0.289825 |
| loss | 267 | -32150.00 | -120.4120 | 0.549187 | 0.943120 | -0.012486 | 3.330477 | 25.6301 | 54.4654 | 0.329461 | 0.712335 |
| all | 631 | 13286.00 | 21.0555 | 0.570633 | 0.953814 | 0.003521 | 3.763808 | 35.1486 | 37.3578 | 0.438408 | 0.468317 |

Key separation:

```text
winners have higher OR/prior range
winners have slightly higher first30 volume ratio
winners have positive avg gap/prior; losers have negative avg gap/prior
winners are farther above VWAP at signal
winners have far better MFE/MAE asymmetry
```

The strongest difference is not raw volume. It is post-entry path quality:

```text
win avg MFE60/risk = 0.5177
win avg MAE60/risk = 0.2898
loss avg MFE60/risk = 0.3295
loss avg MAE60/risk = 0.7123
```

## Factor buckets

### Opening range size / prior range

| Bucket | Trades | Net USD | PF | Win rate | Avg/trade |
|---|---:|---:|---:|---:|---:|
| `<=0.20` | 7 | 283.75 | 3.8518 | 0.5714 | 40.5357 |
| `0.20-0.35` | 148 | 2845.75 | 1.4177 | 0.5473 | 19.2280 |
| `0.35-0.50` | 206 | 1772.25 | 1.1494 | 0.5388 | 8.6032 |
| `0.50-0.75` | 176 | 7987.25 | 2.0649 | 0.6307 | 45.3821 |
| `>0.75` | 93 | 289.00 | 1.0492 | 0.5914 | 3.1075 |

Interpretation:

The best OR-width zone is `0.50-0.75` of prior-session range. Very large ORs `>0.75` are weak despite decent win rate, likely because reward/risk deteriorates or breakouts become extended/chase-like.

### First 30m volume ratio

| Bucket | Trades | Net USD | PF | Win rate | Avg/trade |
|---|---:|---:|---:|---:|---:|
| `<=0.75` | 107 | 3148.50 | 1.6681 | 0.5701 | 29.4252 |
| `0.75-1.00` | 264 | 5346.50 | 1.4160 | 0.5644 | 20.2519 |
| `1.00-1.25` | 186 | 1651.50 | 1.1466 | 0.5699 | 8.8790 |
| `1.25-1.50` | 58 | 3097.00 | 2.3272 | 0.6724 | 53.3966 |
| `>1.50` | 15 | -65.50 | 0.9334 | 0.4667 | -4.3667 |

Interpretation:

Volume helps, but not monotonically. The `1.25-1.50` bucket is excellent; `>1.50` is weak and too small. Do not convert this into a threshold yet. The evidence supports logging participation, not optimizing it.

### Breakout time bucket

| Bucket | Trades | Net USD | PF | Win rate | Avg/trade |
|---|---:|---:|---:|---:|---:|
| `10:00-10:30` | 245 | 5909.75 | 1.4148 | 0.5510 | 24.1214 |
| `10:30-11:00` | 108 | 1642.50 | 1.2692 | 0.5185 | 15.2083 |
| `11:00-12:00` | 111 | 4097.75 | 1.7793 | 0.6396 | 36.9167 |
| `12:00-13:00` | 55 | 1677.25 | 1.8240 | 0.6545 | 30.4955 |
| `13:00-14:00` | 42 | 554.00 | 1.2785 | 0.6429 | 13.1905 |
| `14:00+` | 70 | -595.25 | 0.7635 | 0.5429 | -8.5036 |

Interpretation:

The clearest avoid zone is `14:00+`. Late breakouts are net-negative despite a win rate above 54%, implying poor payoff asymmetry. Midday `11:00-13:00` is surprisingly strong.

### Early continuation vs late chase

| Bucket | Trades | Net USD | PF | Win rate | Avg/trade |
|---|---:|---:|---:|---:|---:|
| early continuation | 353 | 7552.25 | 1.3711 | 0.5411 | 21.3945 |
| midday breakout | 166 | 5775.00 | 1.7918 | 0.6446 | 34.7892 |
| late chase | 112 | -41.25 | 0.9908 | 0.5804 | -0.3683 |

Interpretation:

The phrase "late chase" is quantitatively justified. The late bucket is near break-even/negative with weak expectancy.

### Prior-day trend state

| Bucket | Trades | Net USD | PF | Win rate | Avg/trade |
|---|---:|---:|---:|---:|---:|
| prior down | 74 | 2862.50 | 1.8718 | 0.5946 | 38.6824 |
| prior down large | 171 | 6467.25 | 1.7520 | 0.5965 | 37.8202 |
| prior up | 89 | 711.25 | 1.1487 | 0.5506 | 7.9916 |
| prior up large | 294 | 2967.00 | 1.1916 | 0.5612 | 10.0918 |

Interpretation:

Long breakouts are much stronger after prior down days than after prior up days. This is a plausible mechanism: opening-range long breakouts may work best as reversal/repair after prior-session weakness, not as continuation after already-extended up days.

### Gap direction and size

Gap direction:

| Bucket | Trades | Net USD | PF | Win rate | Avg/trade |
|---|---:|---:|---:|---:|---:|
| gap down | 289 | 4819.25 | 1.3043 | 0.5813 | 16.6756 |
| gap up | 340 | 8221.25 | 1.5040 | 0.5676 | 24.1801 |

Absolute gap / prior range:

| Bucket | Trades | Net USD | PF | Win rate | Avg/trade |
|---|---:|---:|---:|---:|---:|
| `<=0.05` | 52 | 1186.50 | 1.5401 | 0.6154 | 22.8173 |
| `0.05-0.10` | 50 | -1095.25 | 0.7134 | 0.4400 | -21.9050 |
| `0.10-0.20` | 101 | 502.50 | 1.0934 | 0.5248 | 4.9752 |
| `0.20-0.35` | 125 | 3314.75 | 1.4762 | 0.5840 | 26.5180 |
| `>0.35` | 302 | 9269.50 | 1.6722 | 0.6026 | 30.6937 |

Interpretation:

Gap direction itself is not a blocker. Gap size has a non-linear result. Tiny gaps and very large gaps work; `0.05-0.10` is weak. Do not turn this into a rule yet because the shape is not monotonic.

### VWAP distance at signal

| Bucket | Trades | Net USD | PF | Win rate | Avg/trade |
|---|---:|---:|---:|---:|---:|
| `<=0` | 23 | 418.25 | 1.2841 | 0.4783 | 18.1848 |
| `0-1` | 17 | 307.50 | 1.2879 | 0.5294 | 18.0882 |
| `1-2` | 85 | 2016.50 | 1.3969 | 0.5412 | 23.7235 |
| `2-3` | 155 | 606.50 | 1.0645 | 0.4839 | 3.9129 |
| `3-4` | 138 | 4381.25 | 1.6281 | 0.5942 | 31.7482 |
| `>4` | 213 | 5556.00 | 1.6819 | 0.6573 | 26.0845 |

Interpretation:

VWAP distance is broadly supportive, especially `>=3 ATR`. The weak `2-3` bucket is the only warning zone, but again not monotonic enough to promote as a filter without forward testing.

## MFE/MAE finding

This is the strongest distinction between winners and losers:

```text
winners:
  avg MFE60 = 42.1804
  avg MAE60 = 24.8678
  avg MFE60/risk = 0.5177
  avg MAE60/risk = 0.2898

losers:
  avg MFE60 = 25.6301
  avg MAE60 = 54.4654
  avg MFE60/risk = 0.3295
  avg MAE60/risk = 0.7123
```

Losing trades experience adverse excursion early and do not generate sufficient 60-minute continuation. This suggests the next useful research direction is a live-manageability study:

```text
Can adverse excursion within the first 30-60 minutes identify failures early enough to reduce DD?
```

That is a management/risk question, not an entry-filter question.

## Recommendation

Do not add a new static entry filter yet.

The most defensible next hypotheses are:

1. Time guard:

```text
avoid opening_range_box_breakout_long after 14:00
```

Rationale:

```text
14:00+ bucket = 70 trades / -595.25 / PF 0.7635
late_chase bucket = 112 trades / -41.25 / PF 0.9908
```

2. Prior-day trend conditioning:

```text
favor long ORB after prior down or prior down large days
```

Rationale:

```text
prior down + prior down large = 245 trades / +9329.75
prior up + prior up large = 383 trades / +3678.25
```

3. Management audit:

```text
study first 30-60m MAE as an early failure detector
```

Rationale:

```text
loss avg MAE60/risk = 0.7123
win avg MAE60/risk = 0.2898
```

Next ticket:

```text
QFA-ORB-BREAKOUT-LONG-TIME-PRIOR-TREND-MANAGEMENT-AUDIT-01
```

Scope:

```text
test after-14:00 exclusion
test prior-day trend conditioning
test early MAE-based management diagnostics
preserve no-promotion / no-broker / no-ORDER_INTENT authority
```
