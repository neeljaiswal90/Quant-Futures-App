# QFA ORB mechanism research results - 2026-06-20

## Disposition

`ORB_MECHANISM_RESEARCH_DIAGNOSTIC_COMPLETE_NO_PROMOTION_AUTHORITY`

The raw low-regime `100 < risk_points <= 150` exclusion remains failed-to-validate / boundary-fit / forward-only. This research path tested whether a more defensible mechanism exists behind the prior result.

The strongest replacement hypothesis is not the raw 100-150 point band. It is:

```text
low regime
+ first 30m volume >= trailing 20-session first-30m median
+ exclude 0.75 < risk_points / prior_session_range <= 1.00
```

This is more defensible because it is scale-aware and participation-based. It is still diagnostic-only because the sample count is below ADR-0016-style thresholds and the train-side evidence remains weak.

## Source data

```text
cache = D:/QFA-cache/databento/mnq-continuous-12mo-2025-06-20_2026-06-20/ohlcv-1m
baseline = artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-regime-nofade-riskgt30-daystop300
raw_band = artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-regime-nofade-riskgt30-low-excl100to150-daystop300
mechanism_diagnostic = artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-mechanism-research-01
```

RTH sessions loaded by the mechanism analyzer: `258`.

Baseline trades enriched: `254`.

Frozen raw-band scenario trades: `215`.

## Research guardrails applied

This pass used the following guardrails to avoid p-hacking:

```text
candidate profile frozen before this volume pass:
  low regime
  first30_volume / trailing_20_session_first30_volume_median >= 1.0
  exclude 0.75 < risk_points / prior_session_range <= 1.0

new volume metrics added as diagnostics only:
  signal-bar volume ratio to trailing same-minute median
  cumulative volume to signal ratio to trailing same-minute median
  post-breakout 5m volume ratio to trailing same-window median

forbidden in this pass:
  no new threshold promotion
  no choosing best volume bucket
  no switching to alternate volume cutoffs
  no ORDER_INTENT / broker / roster authority
```

## Mechanism diagnostics

### Normalized risk

The low-regime loser cluster is clearer when expressed as normalized risk:

| Bucket | Trades | Net USD | PF | Mean/trade | 60m MFE | 60m MAE |
|---|---:|---:|---:|---:|---:|---:|
| low, `0.75 < risk/prior_range <= 1.00` | 17 | -833.00 | 0.6214 | -49.00 | 28.3382 | 86.3824 |
| low, `risk/ATR14 6-8` | 39 | -105.25 | 0.9578 | -2.6987 | 39.1282 | 56.5064 |
| low, `risk/ATR14 8-10` | 29 | -59.25 | 0.9716 | -2.0431 | 31.7759 | 63.6552 |

The raw low `100-150` set remains weak but not statistically decisive:

```text
trades = 53
net = -1357.00
PF = 0.7505
mean = -25.6038/trade
t = -0.895
```

### ORB quality and participation

Low-regime first-30m volume below trailing median is weak:

| Bucket | Trades | Net USD | PF | Mean/trade |
|---|---:|---:|---:|---:|
| low, first30 volume ratio `0.75-1.00` | 92 | -719.25 | 0.8926 | -7.8179 |
| low, first30 volume ratio `1.00-1.25` | 65 | 2921.50 | 1.8367 | 44.9462 |
| low, first30 volume ratio `1.25-1.50` | 25 | 2283.75 | 2.8270 | 91.3500 |

Low-regime OR close-location is directionally useful but less robust than participation:

| Bucket | Trades | Net USD | PF | Mean/trade |
|---|---:|---:|---:|---:|
| low, OR close location `<=0.25` | 62 | 210.50 | 1.0524 | 3.3952 |
| low, OR close location `0.25-0.50` | 31 | 209.25 | 1.1103 | 6.7500 |
| low, OR close location `0.50-0.75` | 37 | 1894.00 | 2.0614 | 51.1892 |
| low, OR close location `>0.75` | 83 | 2328.25 | 1.4520 | 28.0512 |

### Additional volume diagnostics

The additional volume indicators do not support adding another rule yet. They are useful for mechanism review, but several are non-monotonic, which is exactly where overfitting risk rises.

Low-regime signal-bar relative volume:

| Bucket | Trades | Net USD | PF | Mean/trade |
|---|---:|---:|---:|---:|
| `<=0.75` | 54 | 2970.75 | 2.0934 | 55.0139 |
| `0.75-1.00` | 37 | 1998.75 | 2.7775 | 54.0203 |
| `1.00-1.25` | 20 | 21.75 | 1.0185 | 1.0875 |
| `1.25-1.50` | 28 | 363.75 | 1.2143 | 12.9911 |
| `>1.50` | 74 | -713.00 | 0.8837 | -9.6351 |

Interpretation:

High signal-bar relative volume is not automatically bullish for this ORB family. In low regime, the `>1.50` bucket is net-negative, which may indicate exhaustion/chase behavior rather than clean continuation.

Low-regime cumulative volume by signal minute:

| Bucket | Trades | Net USD | PF | Mean/trade |
|---|---:|---:|---:|---:|
| `<=0.75` | 28 | 777.50 | 1.7660 | 27.7679 |
| `0.75-1.00` | 97 | 294.25 | 1.0442 | 3.0335 |
| `1.00-1.25` | 61 | 2461.25 | 1.7344 | 40.3484 |
| `1.25-1.50` | 14 | 834.50 | 2.0252 | 59.6071 |
| `>1.50` | 13 | 274.50 | 1.2700 | 21.1154 |

Interpretation:

Cumulative volume is more coherent than signal-bar volume. The strongest low-regime zone is `>=1.0`, but sample sizes shrink quickly above `1.25`.

Low-regime post-breakout 5m volume:

| Bucket | Trades | Net USD | PF | Mean/trade |
|---|---:|---:|---:|---:|
| `<=0.75` | 47 | -486.75 | 0.8404 | -10.3564 |
| `0.75-1.00` | 53 | 2349.00 | 1.9713 | 44.3208 |
| `1.00-1.25` | 37 | 2147.00 | 2.0509 | 58.0270 |
| `1.25-1.50` | 29 | 409.00 | 1.2177 | 14.1034 |
| `>1.50` | 47 | 223.75 | 1.0647 | 4.7606 |

Interpretation:

The post-breakout 5m volume result is plausible but not actionable yet: very low follow-through volume is weak, moderate follow-through is strong, and very high follow-through does not help. That shape could be real exhaustion behavior, but it could also be another fitted bucket. Do not add it to the candidate profile without forward data.

## Full simulator recomputations

These reruns use the actual simulator with daily stop and trade sequencing intact, not only post-ledger filters.

Baseline contract:

```text
strategies = opening_range_box_breakout_long, opening_range_box_breakout_short, opening_range_box_regime_long
regime allowlist = low: long/regime_long; high: breakout_short
min risk points = 30.0001
daily stop = 300
```

| Scenario | Trades | Net USD | PF | Max DD | PnL/DD | Win rate | Avg/trade |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline no-fade risk>30 daystop300 | 254 | 5558.50 | 1.3167 | 3400.25 | 1.6347 | 0.5433 | 21.88 |
| raw low `100-150` exclusion | 215 | 7485.00 | 1.5704 | 2886.50 | 2.5931 | 0.5581 | 34.81 |
| low exclude `0.75 < risk/prior <= 1.00` | 241 | 6415.00 | 1.4129 | 2439.75 | 2.6294 | 0.5436 | 26.62 |
| low first30 volume >= median | 135 | 6108.25 | 1.6324 | 3279.50 | 1.8626 | 0.6074 | 45.25 |
| low volume >= median + exclude `0.75 < risk/prior <= 1.00` | 123 | 6712.75 | 1.8501 | 2520.50 | 2.6633 | 0.6098 | 54.58 |
| low volume >= median + OR close > 0.50 + exclude `0.75 < risk/prior <= 1.00` | 80 | 4928.75 | 1.8835 | 2442.00 | 2.0183 | 0.6125 | 61.61 |

Interpretation:

The best balance is the combined volume-plus-normalized-risk profile. It improves PF and PnL/DD versus baseline and raw-band variants while avoiding the arbitrary raw 100-150 boundary. The stricter OR-close profile has the highest PF but cuts the sample to `80` trades, making it less suitable as the next candidate.

Do not add signal-bar, cumulative-volume, or post-breakout-volume thresholds to the candidate yet. They are diagnostics for forward logging only.

## OOS diagnostics

The OOS analyzer discovered `30` ORB scenario directories and used `30` as the DSR deflator.

### Feb-forward split

```text
train <= 2026-01-31
test >= 2026-02-01
```

| Scenario | Split | Trades | Net USD | PF | PnL/DD | DSR | HAC daily t |
|---|---|---:|---:|---:|---:|---:|---:|
| baseline | train | 161 | -311.75 | 0.9712 | -0.0917 | 0.0131 | -0.1308 |
| baseline | test | 93 | 5870.25 | 1.8739 | 3.0065 | 0.6093 | 1.9072 |
| raw low `100-150` | train | 136 | 1302.50 | 1.1629 | 0.4512 | 0.0831 | 0.5745 |
| raw low `100-150` | test | 79 | 6182.50 | 2.2061 | 4.9859 | 0.7162 | 2.2246 |
| combined volume + normalized risk | train | 75 | 1527.25 | 1.3226 | 0.6059 | 0.1332 | 0.7883 |
| combined volume + normalized risk | test | 48 | 5185.50 | 2.6399 | 5.6952 | 0.6269 | 2.5002 |

### Q2-forward split

```text
train <= 2026-03-31
test >= 2026-04-01
```

| Scenario | Split | Trades | Net USD | PF | PnL/DD | DSR | HAC daily t |
|---|---|---:|---:|---:|---:|---:|---:|
| baseline | train | 195 | 470.75 | 1.0351 | 0.1384 | 0.0299 | 0.1604 |
| baseline | test | 59 | 5087.75 | 2.2301 | 5.5452 | 0.5906 | 2.0289 |
| raw low `100-150` | train | 167 | 2277.75 | 1.2261 | 0.7891 | 0.1470 | 0.8400 |
| raw low `100-150` | test | 48 | 5207.25 | 2.7090 | 5.6755 | 0.6565 | 2.3075 |
| combined volume + normalized risk | train | 90 | 2926.25 | 1.5276 | 1.1610 | 0.3114 | 1.3936 |
| combined volume + normalized risk | test | 33 | 3786.50 | 2.6113 | 4.1587 | 0.4414 | 1.9463 |

Interpretation:

The mechanism profile has better train-side evidence than the raw 100-150 rule in the Q2-forward split, but it still does not clear the statistical bar. The test slices are strong but small, and the train-side DSR remains below a promotion-grade threshold.

## Daily-stop interaction

The raw-band improvement is partly a day-management artifact:

```text
baseline trades = 254
baseline net = 5558.50
raw low 100-150 exclusion trades = 215
raw low 100-150 exclusion net = 7485.00
delta = +1926.50
avoided low 100-150 trades = 53
avoided low 100-150 net = -1357.00
baseline trades absent from frozen = 54 / -1437.50
frozen trades absent from baseline = 15 / +489.00
```

The `+489.00` newly-enabled component means some gain comes from freeing daily-stop/sequencing capacity, not only rejecting bad signal quality.

## Recommendation

Do not promote ORB yet.

If continuing the ORB family, freeze this as the next single hypothesis:

```text
low regime only:
  require first30_volume / trailing_20_session_first30_volume_median >= 1.0
  exclude 0.75 < risk_points / prior_session_range <= 1.0
high regime:
  keep existing breakout_short path unchanged
daily stop:
  keep $300
volume diagnostics:
  log signal_bar_volume_ratio, cumulative_volume_ratio, post_breakout_5m_volume_ratio
  do not filter on these yet
order authority:
  ORDER_INTENT remains 0 until separate approval
```

Next research step:

```text
QFA-ORB-MECHANISM-VOLUME-RISKPRIOR-WALKFORWARD-FORWARD-SHADOW-SCOPE-01
```

Scope:

1. Freeze the combined mechanism profile above.
2. Add no additional thresholds.
3. Run disjoint historical diagnostics for documentation only.
4. Use future live/local Rithmic capture as the actual proof set.
5. Track excluded-stream would-have PnL and included-stream PnL separately.
6. Require enough forward events to evaluate both the traded and excluded streams.

Promotion block remains:

```text
trade_count < 300
train-side DSR weak
current 12-month corpus already over-searched
clean proof requires future untouched capture
```
