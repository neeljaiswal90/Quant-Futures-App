# QFA ORB Low-Regime 100-150 Risk-Band Hypothesis

Secondary Quant Review Handoff

Date: 2026-06-20

## Executive summary

This handoff packages the ORB regime/risk-band research for independent quantitative review.

Current disposition:

```text
ORB_LOW_REGIME_100_150_RISK_BAND_FAILED_TO_VALIDATE_BOUNDARY_FIT_FORWARD_ONLY
```

The current evidence generated a regime-conditioned hypothesis:

```text
In low regime, ORB no-fade risk>30 trades with 100 < risk_points <= 150 appear materially weaker than neighboring included trades.
```

It does not prove promotion readiness. After secondary quant review, the correct label is stricter: failed-to-validate / boundary-fit candidate, correctly blocked.

Promotion remains blocked because:

```text
1. The hypothesis was generated from the same 12-month research corpus.
2. Nested and disjoint historical windows are diagnostic only.
3. The exact 100-150 boundary is not uniquely proven versus nearby placebo bands.
4. Trade counts remain below ADR-0016 strategy-level thresholds.
5. The training-half deflated evidence is weak.
6. The effective same-corpus search denominator is materially larger than the 5-band placebo table.
7. Clean validation requires future live/local Rithmic capture after this hypothesis freeze.
```

No broker, live, Phase 6, roster, order translation, or `ORDER_INTENT` authority is granted by this research.

## Reviewer role requested

Please review as an adversarial quantitative analyst.

Primary objective:

```text
Determine whether the frozen low-regime 100-150 exclusion is a robust ex-ante rule worth forward shadow validation, or whether it remains a boundary-fit artifact.
```

Secondary objective:

```text
Recommend the minimum forward-capture validation design required before any shadow/paper promotion claim.
```

## Source data

Historical research corpus:

```text
D:\QFA-cache\databento\mnq-continuous-12mo-2025-06-20_2026-06-20
```

Instrument:

```text
MNQ continuous
```

Primary bars used:

```text
Databento OHLCV 1m RTH bars
```

Verified-but-not-primary schemas in runner report:

```text
definition
trades
tbbo
mbp-1
```

Cost model:

```text
point_value_usd = 2
tick_size_points = 0.25
round_turn_cost_usd = 2.00
```

Execution model:

```text
signal-close entry at candidate.entry_price
subsequent 1m OHLCV bars for stop/target/close exits
conservative stop-before-target when same bar can touch both
one open trade per strategy per trading date
cross-strategy overlap allowed
```

Known limitation:

```text
This is not an MBP queue-position fill simulation.
```

## Code surfaces

Primary backtest runner:

```text
scripts/backtester/run-mnq-12mo-strategy-backtest.ts
```

OOS/scenario summary analyzer:

```text
scripts/backtester/analyze-mnq-orb-oos-walkforward-validation.ts
```

Disjoint-window diagnostic analyzer:

```text
scripts/backtester/analyze-mnq-orb-disjoint-window-diagnostics.ts
```

Hypothesis freeze spec:

```text
docs/research/qfa-orb-low-regime-100-150-forward-shadow-validation-01.md
```

New runner capability added for this research:

```text
QFA_BACKTEST_REGIME_RISK_EXCLUDE_RANGES
```

Syntax:

```text
low:100:150
high:100:150
```

Semantics:

```text
Exclude candidates only when the current ex-ante regime label matches and min < risk_points <= max.
```

Risk points definition:

```text
risk_points = abs(entry_price - stop_price)
```

## Regime method

The regime label is ex-ante relative to candidate generation.

Runner basis:

```text
prior-session RTH range percentile over 60 sessions
high when prior range percentile >= 0.67
else low
```

The regime is not contemporaneously computed from the current trade's future outcome.

Review request:

```text
Verify the exact implementation and confirm that no current-session look-ahead enters the regime label.
```

## Strategy family under review

Baseline profile:

```text
opening_range_box no-fade risk>30 day-stop-300
```

Strategy allowlist:

```text
low:
  opening_range_box_breakout_long
  opening_range_box_regime_long

high:
  opening_range_box_breakout_short
```

Daily stop:

```text
QFA_BACKTEST_DAILY_LOSS_STOP_USD = 300
```

Minimum risk:

```text
QFA_BACKTEST_MIN_RISK_POINTS = 30.0001
```

Frozen rule:

```text
QFA_BACKTEST_REGIME_RISK_EXCLUDE_RANGES = low:100:150
```

Explicitly disallowed:

```text
low:80:130
low:90:140
low:110:160
low:120:170
any boundary switching after seeing results
any regime threshold retune
any target/stop/chase retune
```

## High-level evidence

Search-denominator caveat:

```text
The placebo table below is not the full selection denominator.
Earlier same-corpus work also included multiple exclusion variants, risk caps, drawdown-stop scenarios, day/risk policies, and band attribution scans.
The honest multiple-testing denominator is closer to 75 to 100 configurations than 5.
```

Full-sample comparison:

| Scenario | Rule | Trades | Net PnL | PF | Max DD | PnL/DD |
|---|---|---:|---:|---:|---:|---:|
| baseline no-fade risk>30 | none | 254 | 5558.50 | 1.3167 | 3400.25 | 1.6347 |
| frozen low exclusion | low:100:150 | 215 | 7485.00 | 1.5704 | 2886.50 | 2.5931 |
| high placebo exclusion | high:100:150 | 242 | 5349.50 | 1.3240 | 2856.25 | 1.8729 |

Interpretation:

```text
The improvement is regime-conditioned. Excluding high-regime 100-150 does not reproduce the improvement.
```

## Placebo boundary audit

Low-regime placebos:

| Rule | Trades | Net PnL | PF | Max DD |
|---|---:|---:|---:|---:|
| low:80:130 | 208 | 3929.00 | 1.2645 | 3879.50 |
| low:90:140 | 212 | 5231.50 | 1.3635 | 3755.00 |
| low:100:150 | 215 | 7485.00 | 1.5704 | 2886.50 |
| low:110:160 | 213 | 6146.00 | 1.4586 | 2886.50 |
| low:120:170 | 222 | 6558.50 | 1.4727 | 2886.50 |

Interpretation:

```text
low:100:150 is best full-sample, but nearby low-regime bands also improve results.
The exact boundary is not uniquely proven and remains boundary-fit until future untouched capture supports it.
```

## Nested OOS diagnostics

These are diagnostic only because all windows are slices of the same searched 12-month corpus.

Promoted profile:

```text
orb-regime-nofade-riskgt30-excl100to150-daystop300
```

Nested suffix results:

| Train end | Test start | Test trades | Test PnL | Test PF |
|---|---:|---:|---:|---:|
| 2025-12-31 | 2026-01-01 | 91 | 7414.25 | 2.3507 |
| 2026-01-31 | 2026-02-01 | 79 | 6182.50 | 2.2061 |
| 2026-03-31 | 2026-04-01 | 48 | 5207.25 | 2.7090 |
| 2026-04-30 | 2026-05-01 | 25 | 2849.50 | 2.2724 |

Interpretation:

```text
The candidate did not collapse in late-period suffix diagnostics.
This is useful but not clean OOS proof.
The promoted profile was not cleanly selected by train-only evidence in the earlier split and had weak train-split deflated evidence.
```

## Disjoint-window diagnostics

Determination:

```text
ORB_DISJOINT_WINDOW_DIAGNOSTICS_COMPLETE_NOT_CLEAN_OOS
```

These are stress tests inside the same 12-month corpus.

| Diagnostic | Test block | Baseline net | Frozen rule net | High placebo net |
|---|---|---:|---:|---:|
| train early / test middle | middle | -1330.75 | -654.00 | -1120.00 |
| train middle / test early | early | 1019.00 | 1956.50 | 599.25 |
| train late / test early | early | 1019.00 | 1956.50 | 599.25 |
| rolling Q3 to Q4 | Q4 2025 | -2529.50 | -2119.50 | -2085.00 |
| rolling Q4 to Q1 | Q1 2026 | 1981.25 | 2440.75 | 1747.50 |
| rolling Q1 to Q2 | Q2 2026 partial | 5087.75 | 5207.25 | 5087.75 |

Interpretation:

```text
The frozen rule improves baseline in 5 of 6 disjoint diagnostic test blocks.
It does not rescue Q4 2025, but reduces the loss.
High-regime placebo does not consistently match the frozen rule.
Still not clean validation.
These diagnostics are better read as stress tests that failed to invalidate the frozen rule, not as validation evidence.
```

## Key artifacts

Forward hypothesis freeze:

```text
docs/research/qfa-orb-low-regime-100-150-forward-shadow-validation-01.md
```

Low-regime risk-band validation:

```text
artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-low-regime-risk-band-validation-01/low-regime-risk-band-validation-report.md
artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-low-regime-risk-band-validation-01/low-regime-risk-band-validation-report.json
```

Disjoint diagnostics:

```text
artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-disjoint-window-diagnostics-01/orb-disjoint-window-diagnostics-report.md
artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-disjoint-window-diagnostics-01/orb-disjoint-window-diagnostics.csv
artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-disjoint-window-diagnostics-01/orb-disjoint-window-diagnostics-report.json
```

OOS/scenario summaries:

```text
artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-oos-walkforward-validation-01/
artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-oos-wf-2026q1-test-01/
artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-oos-wf-2026q2-test-01/
artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-oos-wf-2026may-test-01/
artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-low-regime-band-validation-wf-2026q1-01/
artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-low-regime-band-validation-wf-2026feb-01/
artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-low-regime-band-validation-wf-2026q2-01/
artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-low-regime-band-validation-wf-2026may-01/
```

Historical scenario directories:

```text
artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-regime-nofade-riskgt30-daystop300/
artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-regime-nofade-riskgt30-low-excl100to150-daystop300/
artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-regime-nofade-riskgt30-high-excl100to150-daystop300/
artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-regime-nofade-riskgt30-low-placebo80to130-daystop300/
artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-regime-nofade-riskgt30-low-placebo90to140-daystop300/
artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-regime-nofade-riskgt30-low-placebo110to160-daystop300/
artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-regime-nofade-riskgt30-low-placebo120to170-daystop300/
```

## Reproduction commands

Baseline no-fade risk>30 day-stop-300:

```powershell
$env:QFA_BACKTEST_ROSTER_MODE = "orb-regime-nofade-riskgt30-daystop300"
$env:QFA_BACKTEST_OUTPUT_PREFIX = "mnq-12mo-orb-regime-nofade-riskgt30-daystop300"
$env:QFA_MNQ_12MO_BACKTEST_ARTIFACT_DIR = "artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-regime-nofade-riskgt30-daystop300"
$env:QFA_BACKTEST_STRATEGY_FILTER = "opening_range_box_breakout_long,opening_range_box_breakout_short,opening_range_box_regime_long"
$env:QFA_BACKTEST_REGIME_STRATEGY_ALLOWLIST = "low:opening_range_box_breakout_long|opening_range_box_regime_long;high:opening_range_box_breakout_short"
$env:QFA_BACKTEST_DAILY_LOSS_STOP_USD = "300"
$env:QFA_BACKTEST_MIN_RISK_POINTS = "30.0001"
$env:QFA_BACKTEST_TARGET_MODE = "all_targets"
npx tsx scripts/backtester/run-mnq-12mo-strategy-backtest.ts
```

Frozen low-regime 100-150 exclusion:

```powershell
$env:QFA_BACKTEST_ROSTER_MODE = "orb-regime-nofade-riskgt30-low-excl100to150-daystop300"
$env:QFA_BACKTEST_OUTPUT_PREFIX = "mnq-12mo-orb-regime-nofade-riskgt30-low-excl100to150-daystop300"
$env:QFA_MNQ_12MO_BACKTEST_ARTIFACT_DIR = "artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-regime-nofade-riskgt30-low-excl100to150-daystop300"
$env:QFA_BACKTEST_STRATEGY_FILTER = "opening_range_box_breakout_long,opening_range_box_breakout_short,opening_range_box_regime_long"
$env:QFA_BACKTEST_REGIME_STRATEGY_ALLOWLIST = "low:opening_range_box_breakout_long|opening_range_box_regime_long;high:opening_range_box_breakout_short"
$env:QFA_BACKTEST_DAILY_LOSS_STOP_USD = "300"
$env:QFA_BACKTEST_MIN_RISK_POINTS = "30.0001"
$env:QFA_BACKTEST_REGIME_RISK_EXCLUDE_RANGES = "low:100:150"
$env:QFA_BACKTEST_TARGET_MODE = "all_targets"
npx tsx scripts/backtester/run-mnq-12mo-strategy-backtest.ts
```

Disjoint diagnostics:

```powershell
npx tsx scripts/backtester/analyze-mnq-orb-disjoint-window-diagnostics.ts
```

OOS/scenario summary analyzer:

```powershell
$env:QFA_ORB_OOS_TRAIN_END = "2026-01-31"
$env:QFA_ORB_OOS_TEST_START = "2026-02-01"
$env:QFA_ORB_OOS_ARTIFACT_DIR = "artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-oos-walkforward-validation-01"
npx tsx scripts/backtester/analyze-mnq-orb-oos-walkforward-validation.ts
```

## Required secondary review questions

1. Does the runner implement `QFA_BACKTEST_REGIME_RISK_EXCLUDE_RANGES` correctly?
2. Is `risk_points = abs(entry_price - stop_price)` the correct operational risk definition for this family?
3. Is the prior-session range percentile regime truly ex-ante?
4. Are the low-regime 100-150 excluded trades worse for a plausible market-structure reason, or only by sample accident?
5. Does Q4 2025 identify a regime/event/volatility condition where the frozen rule is insufficient?
6. Are nearby placebos close enough to keep the exact 100-150 rule classified as boundary-fit?
7. What forward sample threshold is sufficient before spending shadow capacity?
8. Should this rule be reviewed as:

```text
exact band = low:100:150
or broader moderate-risk low-regime family
```

9. What is the honest multiple-testing denominator after including the full ORB search path?
10. What is the standard error and confidence interval of the excluded low-regime 100-150 stream?
11. Does the excluded stream remain negative in future capture, or does it flip positive as in later historical slices?
12. How much of the full-sample improvement is direct avoided loss versus second-order daily-stop/time-slot substitution?
13. Is there a structural market mechanism for low-regime moderate-risk ORB weakness, or only sample attribution?

## Recommended forward validation design

Forward validation should use future live/local Rithmic capture only.

Profile:

```text
no-fade risk>30 day-stop-300
frozen exclusion = low:100:150
ORDER_INTENT = 0
paper_observation_stop_after_candidate = true
```

Minimum evidence:

```text
preferred = 45 to 60 full RTH sessions
or = at least 300 strategy-level candidate events
```

Required streams:

```text
included candidates
excluded low-regime 100-150 candidates
baseline counterfactual
regime label source
risk_points source
daily drawdown impact
weekly/monthly stability
strategy/regime/risk-band trade counts
ORDER_INTENT_count
```

Hard invariant:

```text
ORDER_INTENT_count = 0
```

## Current promotion status

```text
shadow promotion = blocked
paper/live promotion = blocked
broker authority = blocked
Phase 6 authority = blocked
roster mutation = blocked
```

Allowed next work:

```text
QFA-ORB-LOW-REGIME-100-150-FORWARD-SHADOW-HARNESS-01
```

Scope:

```text
Build a shadow-only harness that consumes future live/local Rithmic capture,
logs included/excluded ORB candidate streams under the frozen rule,
and produces performance rollups with ORDER_INTENT locked at 0.
```
