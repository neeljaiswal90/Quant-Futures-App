# QFA ORB expanded-cache backtest - 2019-05-06 to 2026-06-20

## Disposition

`ORB_EXPANDED_CACHE_BACKTEST_COMPLETE_PROMOTION_BLOCKED`

The broader `D:\QFA-cache` OHLCV cache materially weakens the current ORB mechanism profile. The 2025-2026 result is not representative of the 2019-2026 history.

Do not promote the ORB mechanism profile from this evidence. Do not tune new thresholds from this expanded corpus without pre-registering a new hypothesis first.

## Data audit

Local cache reviewed:

```text
D:\QFA-cache\databento\mnq-continuous-included-2019-05-06_2026-06-20
```

Available schemas:

| Schema | Files | Approx size | First file | Last file |
|---|---:|---:|---|---|
| definition | 7 | 0.001 GB | definition_2019-05-06_2020-06-20.dbn.zst | definition_2025-06-20_2026-06-20.dbn.zst |
| ohlcv-1d | 7 | 0.000 GB | ohlcv_1d_2019-05-06_2020-06-20.dbn.zst | ohlcv_1d_2025-06-20_2026-06-20.dbn.zst |
| ohlcv-1h | 7 | 0.001 GB | ohlcv_1h_2019-05-06_2020-06-20.dbn.zst | ohlcv_1h_2025-06-20_2026-06-20.dbn.zst |
| ohlcv-1m | 7 | 0.044 GB | ohlcv_1m_2019-05-06_2020-06-20.dbn.zst | ohlcv_1m_2025-06-20_2026-06-20.dbn.zst |
| ohlcv-1s | 7 | 1.201 GB | ohlcv_1s_2019-05-06_2020-06-20.dbn.zst | ohlcv_1s_2025-06-20_2026-06-20.dbn.zst |
| statistics | 7 | 0.060 GB | statistics_2019-05-06_2020-06-20.dbn.zst | statistics_2025-06-20_2026-06-20.dbn.zst |
| status | 7 | 0.000 GB | status_2019-05-06_2020-06-20.dbn.zst | status_2025-06-20_2026-06-20.dbn.zst |

Backtest coverage loaded:

```text
first_rth_bar_utc = 2019-05-06T13:30:00.000000000Z
last_rth_bar_utc = 2026-06-19T16:59:00.000000000Z
sessions = 1839
complete_390_slot_sessions = 1768
sessions_with_missing_slots = 71
```

Important caveat:

This expanded cache is OHLCV-oriented. It does not include the 12-month full-depth `trades`, `tbbo`, and `mbp-1` schemas used by the prior 12-month cache. The ORB runner was executed with explicit OHLCV-only opt-in:

```text
QFA_BACKTEST_ALLOW_OHLCV_ONLY_CACHE=true
```

The default full-depth 12-month cache guard remains fail-closed.

## Strategy contract

Baseline contract:

```text
strategies = opening_range_box_breakout_long, opening_range_box_breakout_short, opening_range_box_regime_long
regime allowlist = low: opening_range_box_breakout_long | opening_range_box_regime_long; high: opening_range_box_breakout_short
min_risk_points = 30.0001
daily_loss_stop_usd = 300
execution_model = signal-close entry at generated candidate.entry_price; exits from subsequent 1m OHLCV bars
ORDER_INTENT = 0
broker/live/roster authority = none
```

Compared scenarios:

```text
baseline = no-fade risk>30 daystop300
raw_band = low regime exclude 100 < risk_points <= 150
mechanism = low regime require first30 volume >= trailing median and exclude 0.75 < risk_points / prior_session_range <= 1.0
```

## Full-sample results

| Scenario | Trades | Net USD | PF | Max DD | PnL/DD | Win rate | Avg/trade |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 2094 | 23580.00 | 1.1934 | 5068.75 | 4.6520 | 0.5148 | 11.26 |
| raw low 100-150 exclusion | 1851 | 18304.25 | 1.1759 | 5252.75 | 3.4847 | 0.5057 | 9.89 |
| mechanism volume+riskprior | 1024 | 8514.50 | 1.1250 | 3350.50 | 2.5413 | 0.5107 | 8.31 |

Expanded-history conclusion:

The raw `100-150` exclusion and the scale-aware volume+riskprior mechanism both underperform the baseline on the 2019-2026 history. The current mechanism profile is not robust enough for promotion.

## By-strategy breakdown

### Baseline

| Strategy | Trades | Net USD | PF | Max DD | Avg/trade |
|---|---:|---:|---:|---:|---:|
| opening_range_box_breakout_long | 631 | 13286.00 | 1.4133 | 1767.25 | 21.06 |
| opening_range_box_breakout_short | 324 | -1526.50 | 0.9490 | 4653.50 | -4.71 |
| opening_range_box_regime_long | 1139 | 11820.50 | 1.1974 | 2472.25 | 10.38 |

### Raw low 100-150 exclusion

| Strategy | Trades | Net USD | PF | Max DD | Avg/trade |
|---|---:|---:|---:|---:|---:|
| opening_range_box_breakout_long | 500 | 10403.75 | 1.4489 | 1208.75 | 20.81 |
| opening_range_box_breakout_short | 324 | -1526.50 | 0.9490 | 4653.50 | -4.71 |
| opening_range_box_regime_long | 1027 | 9427.00 | 1.1850 | 3162.50 | 9.18 |

### Mechanism volume+riskprior

| Strategy | Trades | Net USD | PF | Max DD | Avg/trade |
|---|---:|---:|---:|---:|---:|
| opening_range_box_breakout_long | 225 | 5643.25 | 1.4925 | 1319.50 | 25.08 |
| opening_range_box_breakout_short | 324 | -1526.50 | 0.9490 | 4653.50 | -4.71 |
| opening_range_box_regime_long | 475 | 4397.75 | 1.1645 | 2115.50 | 9.26 |

## Period stability

| Scenario | Period | Trades | Net USD | PF | Avg/trade |
|---|---|---:|---:|---:|---:|
| baseline | 2019-2024 | 1691 | 14298.25 | 1.1532 | 8.46 |
| baseline | 2025-2026 | 403 | 9281.75 | 1.3247 | 23.03 |
| baseline | 2026 only | 114 | 7069.00 | 1.9052 | 62.01 |
| raw low 100-150 | 2019-2024 | 1519 | 7437.00 | 1.0904 | 4.90 |
| raw low 100-150 | 2025-2026 | 332 | 10867.25 | 1.4981 | 32.73 |
| raw low 100-150 | 2026 only | 92 | 7648.00 | 2.3933 | 83.13 |
| mechanism | 2019-2024 | 841 | 3569.50 | 1.0670 | 4.24 |
| mechanism | 2025-2026 | 183 | 4945.00 | 1.3336 | 27.02 |
| mechanism | 2026 only | 60 | 6313.25 | 2.7160 | 105.22 |

Interpretation:

The mechanism profile is heavily dependent on recent 2026 conditions. From 2019-2024 it is only marginally positive:

```text
2019-2024 mechanism PF = 1.0670
2019-2024 mechanism avg/trade = 4.24
```

This is too weak for promotion, especially because the profile was derived after seeing the 2025-2026 research path.

## Artifacts

```text
artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-regime-nofade-riskgt30-daystop300
artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-regime-nofade-riskgt30-low-excl100to150-daystop300
artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-mechanism-low-volume-ge-median-excl-riskprior075to100-daystop300
```

Runner change:

```text
scripts/backtester/run-mnq-12mo-strategy-backtest.ts
```

Added opt-in cache mode:

```text
QFA_BACKTEST_ALLOW_OHLCV_ONLY_CACHE=true
```

## Recommendation

Stop treating the ORB mechanism profile as a promotion candidate.

Recommended next direction:

1. Keep the expanded-cache result as the new governing evidence.
2. Do not tune new risk or volume thresholds against 2019-2026.
3. If ORB remains under study, simplify to the baseline long-only components and analyze why `opening_range_box_breakout_short` is structurally negative.
4. Consider a separate regime-specific review of `opening_range_box_breakout_long`, because it remains the strongest long-history component:

```text
opening_range_box_breakout_long:
  trades = 631
  net = 13286.00
  PF = 1.4133
  avg_net_trade = 21.06
  max_drawdown = 1767.25
```

5. Forward-shadow work should prioritize the robust component, not the fitted low-regime exclusion.

No broker, paper runtime, ORDER_INTENT, live trading, Phase 6, or roster authority is created by this research.
