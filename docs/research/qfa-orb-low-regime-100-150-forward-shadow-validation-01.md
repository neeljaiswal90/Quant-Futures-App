# QFA-ORB-LOW-REGIME-100-150-FORWARD-SHADOW-VALIDATION-01

## Determination

```text
ORB_LOW_REGIME_100_150_RISK_BAND_HYPOTHESIS_FROZEN_FOR_FORWARD_VALIDATION
```

## Purpose

Freeze the ORB low-regime moderate-risk exclusion as a hypothesis generated from the 12-month Databento/QFA-cache research set, and define the only acceptable validation path before any shadow promotion claim.

This document does not promote the strategy. It explicitly separates:

```text
historical hypothesis generation != validation
forward live/local Rithmic capture == validation ground
```

## Frozen hypothesis

Profile under test:

```text
base_profile = opening-range-box no-fade risk>30 day-stop-300 profile
regime_filter = existing ex-ante prior-session RTH range percentile regime label
rule = exclude candidates only when regime_label == low and 100 < risk_points <= 150
```

Equivalent runner configuration:

```powershell
$env:QFA_BACKTEST_REGIME_RISK_EXCLUDE_RANGES = "low:100:150"
```

No alternate risk-band boundaries may be substituted during validation.

Explicitly disallowed during validation:

```text
low:80:130
low:90:140
low:110:160
low:120:170
any new risk-band cut discovered from forward data
any regime threshold retune
any target/stop/chase retune
any strategy roster mutation
```

## Historical evidence status

The current historical work supports the hypothesis but does not validate it.

Known findings:

```text
12-month source = D:\QFA-cache Databento MNQ continuous archive
scenario universe inspected = at least 26 ORB scenarios after placebo expansion
baseline = no-fade risk>30 day-stop-300
tested rule = low-regime-only 100 < risk_points <= 150 exclusion
```

Full-sample comparison:

```text
baseline no-fade risk>30:
  trades = 254
  net_pnl_usd = 5558.50
  profit_factor = 1.3167
  max_drawdown_usd = 3400.25

low:100:150 exclusion:
  trades = 215
  net_pnl_usd = 7485.00
  profit_factor = 1.5704
  max_drawdown_usd = 2886.50
```

Constraint:

```text
The same 12-month data generated and stress-tested the rule.
Nested suffix OOS slices are diagnostic only.
They are not clean validation.
```

## Nested-window confound resolution

Historical diagnostics may still be used to detect obvious fragility, but they must be labeled as diagnostics.

Required diagnostic split families:

```text
train_early_test_middle
train_middle_test_early
train_late_test_early
non_overlapping_rolling_blocks
```

Disallowed claim:

```text
Nested suffix windows prove OOS robustness.
```

Allowed claim:

```text
Nested and disjoint historical windows did or did not reveal immediate fragility inside the hypothesis-generation corpus.
```

## Forward validation ground

Only future live/local Rithmic capture after hypothesis freeze is clean validation.

Valid source:

```text
live/local Rithmic capture
OBS01 / MBP1 capture path used by QFA-612 shadow-mode pipeline
full RTH session capture preferred
```

Invalid source:

```text
additional slices of the same 2025-06-20 to 2026-06-20 QFA-cache research corpus
post-hoc boundary variants selected after seeing forward performance
manually cherry-picked session subsets
```

## Forward shadow-mode contract

Runtime mode:

```text
shadow only
ORDER_INTENT = 0
broker/live authority = false
Phase 6 authority = false
roster mutation = false
paper_observation_stop_after_candidate = true
```

Required logged streams:

```text
all candidate-eligible ORB triggers
included candidates after frozen rule
excluded low-regime 100-150 candidates
regime label source for each candidate
risk_points source for each candidate
entry/stop/target definition
would-have PnL for excluded candidates
strategy marker counts
ORDER_INTENT count
```

Hard invariant:

```text
ORDER_INTENT_count must remain 0
```

## Forward success criteria

Minimum forward sample before any promotion claim:

```text
preferred = 45 to 60 full RTH sessions
or = at least 300 strategy-level candidate events
```

Evaluation must report:

```text
included candidate performance
excluded low-regime 100-150 candidate would-have performance
baseline no-fade risk>30 counterfactual
daily drawdown impact
monthly/weekly stability
trade count by strategy
trade count by regime
trade count by risk band
DSR/PSR/HAC-Sharpe inputs
ADR-0016 gate status
```

Promotion requires all of:

```text
forward excluded low-regime 100-150 candidates remain materially worse than included candidates
forward baseline no-fade risk>30 is improved by the frozen exclusion
no alternate neighboring boundary materially dominates the frozen rule in a predeclared placebo audit
strategy-level trade count gate is either met or explicitly waived only for continued shadow, not live/paper promotion
ORDER_INTENT remains 0 during validation
```

## Predeclared placebo audit

Placebo boundaries are allowed only as a falsification check after the frozen rule has been evaluated.

Predeclared placebo set:

```text
low:80:130
low:90:140
low:110:160
low:120:170
high:100:150
```

Interpretation:

```text
If neighboring low-regime placebo boundaries consistently dominate low:100:150, the exact 100-150 rule remains boundary-fit.
If high:100:150 performs similarly to low:100:150, the regime-specific mechanism is weakened.
If low:100:150 improves baseline while high:100:150 does not, the regime-conditioned hypothesis is strengthened.
```

## Authority boundary

This artifact authorizes:

```text
forward shadow validation specification
artifact generation
read-only performance analysis
```

This artifact does not authorize:

```text
ORDER_INTENT
order translation
order adapter calls
broker adapter calls
paper fills
production account use
live broker authority
Phase 6 authority
ACTIVE_STRATEGY_IDS mutation
CANDIDATE_STRATEGY_IDS mutation
strategy roster mutation
```

## Next implementation ticket

```text
QFA-ORB-LOW-REGIME-100-150-FORWARD-SHADOW-HARNESS-01
```

Scope:

```text
Build a shadow-only harness that consumes future live/local Rithmic capture,
emits included/excluded ORB candidate streams under the frozen low:100:150 rule,
and records performance rollups with ORDER_INTENT locked at 0.
```

