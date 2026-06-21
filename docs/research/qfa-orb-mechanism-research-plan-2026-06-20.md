# QFA ORB Mechanism Research Plan

Date: 2026-06-20

## Determination

```text
ORB_RAW_100_150_RULE_REJECTED_FOR_PROMOTION_MECHANISM_RESEARCH_NEXT
```

## Purpose

Replace the raw `100 < risk_points <= 150` ORB exclusion with a mechanism-driven research path.

The prior raw-band rule is blocked:

```text
status = failed-to-validate / boundary-fit / forward-only
```

This plan defines the next quantitative research sequence before any future shadow promotion claim.

## Research principle

Do not scan for another raw point band.

The next research must test mechanism variables:

```text
scale-aware risk
ORB quality / continuation pressure
low-regime continuation failure
daily-stop accounting interaction
```

## Priority 1: normalized risk filter

Goal:

```text
Replace raw 100-150 MNQ points with scale-aware risk definitions.
```

Candidate features:

```text
risk_points / prior_session_range
risk_points / trailing_20_session_median_range
risk_points / ATR14
risk_points / opening_range_width
opening_range_width / prior_session_range
opening_range_width / ATR14
```

Primary questions:

```text
1. Are low-regime losses concentrated in medium normalized-risk trades?
2. Does normalized risk explain the 100-150 raw-band weakness?
3. Is the effect stable across disjoint windows?
4. Does the effect survive if raw risk_points are removed from the model?
```

Required outputs:

```text
bucket table by normalized risk
strategy/regime/trade-count table
MFE/MAE by normalized risk
PnL and drawdown by normalized risk
disjoint-window diagnostic by normalized risk
placebo bucket check with fixed predeclared bins
```

Predeclared bins:

```text
risk_to_prior_range: <=0.25, 0.25-0.50, 0.50-0.75, >0.75
risk_to_atr14: <=2, 2-4, 4-6, >6
orb_width_to_prior_range: <=0.25, 0.25-0.50, 0.50-0.75, >0.75
```

## Priority 2: ORB quality filter

Goal:

```text
Measure whether a breakout has actual continuation pressure before candidate admission.
```

Candidate features:

```text
opening_range_close_location
first_30m_range_expansion
first_30m_volume_vs_trailing_median
entry_distance_from_session_vwap
signed_shock_vwap
delta_confirmation
breakout_bar_close_location
breakout_bar_body_fraction
breakout_bar_volume_ratio
```

Definitions:

```text
opening_range_close_location = (OR close - OR low) / OR width
first_30m_range_expansion = first_30m_range / prior_session_range
volume_ratio = first_30m_volume / trailing_20_session_first_30m_median_volume
vwap_distance = abs(entry_price - session_vwap) / ATR14
signed_shock_vwap = direction-adjusted distance from session VWAP
```

Primary questions:

```text
1. Do losing low-regime ORB trades lack continuation pressure at entry?
2. Does OR close location distinguish valid breakouts from fade-prone moves?
3. Does VWAP distance identify overextended entries?
4. Does volume confirmation rescue low-regime medium-risk trades?
```

Required outputs:

```text
quality-feature distribution for winners vs losers
quality-feature distribution for excluded vs included candidates
single-feature monotonicity tables
two-feature interaction table: normalized risk x ORB quality
disjoint-window stability table
```

## Priority 3: low-regime continuation failure

Goal:

```text
Test whether low-regime medium-width breakouts fail because continuation is weak after entry.
```

Primary comparison:

```text
low regime + breakout direction + OR width bucket
```

Measured against:

```text
subsequent 30-minute MFE/MAE
subsequent 60-minute MFE/MAE
subsequent 120-minute MFE/MAE
reversal rate
target-before-stop rate
time-to-MFE
time-to-MAE
```

Required buckets:

```text
OR_width_to_prior_range <=0.25
0.25 < OR_width_to_prior_range <=0.50
0.50 < OR_width_to_prior_range <=0.75
OR_width_to_prior_range >0.75
```

Mechanism threshold:

```text
A real continuation-failure mechanism should show poor MFE/MAE and high reversal rate before trade outcome filtering.
```

Required outputs:

```text
MFE/MAE table by regime, direction, OR width bucket
reversal-rate table by regime, direction, OR width bucket
entry-hour sensitivity table
disjoint-window stability table
```

## Priority 4: daily stop interaction

Goal:

```text
Separate signal-quality edge from portfolio/day-accounting edge.
```

Required scenarios:

```text
daily_stop_disabled
daily_stop_300_enabled
first_trade_only_per_strategy_day
sequential_reentry_allowed
```

Primary questions:

```text
1. Does the normalized/quality rule improve first-trade expectancy?
2. Does it only work by preserving daily stop budget for later trades?
3. How much PnL delta comes from avoided trades vs newly enabled later trades?
4. Does the rule reduce max daily drawdown independently of re-entry effects?
```

Required outputs:

```text
avoided-trade PnL
newly-enabled-trade PnL
first-trade-only comparison
sequential-reentry comparison
daily max drawdown table
day-level attribution
```

Interpretation:

```text
If the rule only works because it frees later trades, classify it as day-management logic, not signal-quality logic.
```

## Disallowed shortcuts

Do not:

```text
scan new raw point bands and promote the winner
switch from 100-150 to 90-140 based on same-corpus performance
claim clean OOS from the same 12-month corpus
use shadow promotion as a substitute for forward validation
ignore excluded-stream standard error
```

## Required statistical framing

Every candidate mechanism report must include:

```text
sample count
mean
standard deviation
standard error
95% confidence interval
Welch comparison against included stream
trade count by strategy/regime
disjoint-window stability
multiple-testing denominator
promotion status
```

Promotion status must remain:

```text
blocked
```

until future live/local Rithmic capture validates the pre-registered mechanism.

## Recommended next ticket

```text
QFA-ORB-NORMALIZED-RISK-AND-ORB-QUALITY-RESEARCH-01
```

Scope:

```text
Build a mechanism-analysis artifact over the existing 12-month corpus that computes normalized risk,
ORB quality, continuation MFE/MAE, and daily-stop interaction diagnostics.
No promotion, no broker action, no ORDER_INTENT, no roster mutation.
```

## Authority boundary

This plan authorizes:

```text
research artifact generation
read-only historical diagnostics
forward-validation planning
```

This plan does not authorize:

```text
ORDER_INTENT
order translation
broker/live authority
Phase 6 authority
roster mutation
paper/live promotion
```

