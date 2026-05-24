# MOC-R6 robustness report

Generated note: Deterministic MOC-R6 report; no wall-clock timestamp emitted.

## Preamble: inputs, loader, and top-K cells

Input artifact SHAs:
- R4 expectancy-tables.parquet: `4341c862047b23414218c92ce56c9ae299f6cef496de304aa767feedd87b75cd`
- R5 conditioning-tables.parquet: `1bc098e10e39d588962d89594c432ee8df87776352c69f625db42b83a6db5fd3`
- R5 conditioning-summary.md: `ced051303380ff931d3511fc61d014b87ef7bd651150a84e5fa1acaaad4a27ed`
- R3 triggered-events.parquet: `7da601066b958e484238a7fe767f6aead80df83ea38d54bbba1616b6b5dead3f`
- R2 event-aggregates.parquet: `5c6e67701f54038592a387b4d7bb053637f7f9b172a62bad3bd19b60711dc3b9`
- R1 event-day-manifest.json: `1aa076833537f5fbe1bead661e7fd806702a3686dec5f6d945eb27239192dc19`
- R4 research-grid-manifest.json: `8b41582e1dec3da049e31dab030a3e02b9a3e7973ddbad761e2874e3d4eda924`

Production statistical helpers used read-only:
- `scripts/strategy-selection/_lib/block_bootstrap.py`
- `scripts/strategy-selection/_lib/psr_dsr.py`

Robustness-suite.py loads `block_bootstrap.py` and `psr_dsr.py` via
`importlib.util.spec_from_file_location` because `scripts/strategy-selection/`
is hyphenated and not Python-importable as a package. A scoped `sys.path.insert`
to `scripts/strategy-selection/_lib/` resolves `psr_dsr.py` sibling imports
(`hac_sharpe`, `returns`, `thresholds`). `sys.modules[name] = mod` registration
before `spec.loader.exec_module(mod)` is required for `dataclasses` to resolve
`cls.__module__` lookups inside `psr_dsr.py`. Production modules remain
unmodified; only this script process augments the loader path.

Top-10 cells from full R4 expectancy table ranked by `expected_daily_pnl_usd`:

| rank | pt | stop | cost | latency | arm | offset | reference | protection | n_total | n_one_side | n_both | n_neither | p_one_side | p_both | p_pt | p_stop | p_time | p_miss | exp_usd | exp_pts | freq | daily_pnl |
|---:|---:|---:|---|---:|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 6.0 | 2.0 | mnq_low | 0 | 5 | 3.0 | bid_ask | null | 30 | 6 | 24 | 0 | 0.2000000000 | 0.8000000000 | 0.6666666667 | 0.3333333333 | 0.0000000000 | 0.0000000000 | 5.8166666667 | 3.3333333333 | 0.2000000000 | 1.1633333333 |
| 2 | 6.0 | 2.0 | mnq_low | 0 | 5 | 3.0 | bid_ask | 0.5 | 30 | 6 | 24 | 0 | 0.2000000000 | 0.8000000000 | 0.6666666667 | 0.3333333333 | 0.0000000000 | 0.0000000000 | 5.8166666667 | 3.3333333333 | 0.2000000000 | 1.1633333333 |
| 3 | 6.0 | 2.0 | mnq_low | 0 | 5 | 3.0 | bid_ask | 1.0 | 30 | 6 | 24 | 0 | 0.2000000000 | 0.8000000000 | 0.6666666667 | 0.3333333333 | 0.0000000000 | 0.0000000000 | 5.8166666667 | 3.3333333333 | 0.2000000000 | 1.1633333333 |
| 4 | 6.0 | 2.0 | mnq_low | 0 | 5 | 3.0 | bid_ask | 1.5 | 30 | 6 | 24 | 0 | 0.2000000000 | 0.8000000000 | 0.6666666667 | 0.3333333333 | 0.0000000000 | 0.0000000000 | 5.8166666667 | 3.3333333333 | 0.2000000000 | 1.1633333333 |
| 5 | 6.0 | 2.0 | mnq_low | 0 | 5 | 3.0 | microprice | null | 30 | 6 | 24 | 0 | 0.2000000000 | 0.8000000000 | 0.6666666667 | 0.3333333333 | 0.0000000000 | 0.0000000000 | 5.8166666667 | 3.3333333333 | 0.2000000000 | 1.1633333333 |
| 6 | 6.0 | 2.0 | mnq_low | 0 | 5 | 3.0 | microprice | 0.5 | 30 | 6 | 24 | 0 | 0.2000000000 | 0.8000000000 | 0.6666666667 | 0.3333333333 | 0.0000000000 | 0.0000000000 | 5.8166666667 | 3.3333333333 | 0.2000000000 | 1.1633333333 |
| 7 | 6.0 | 2.0 | mnq_low | 0 | 5 | 3.0 | microprice | 1.0 | 30 | 6 | 24 | 0 | 0.2000000000 | 0.8000000000 | 0.6666666667 | 0.3333333333 | 0.0000000000 | 0.0000000000 | 5.8166666667 | 3.3333333333 | 0.2000000000 | 1.1633333333 |
| 8 | 6.0 | 2.0 | mnq_low | 0 | 5 | 3.0 | microprice | 1.5 | 30 | 6 | 24 | 0 | 0.2000000000 | 0.8000000000 | 0.6666666667 | 0.3333333333 | 0.0000000000 | 0.0000000000 | 5.8166666667 | 3.3333333333 | 0.2000000000 | 1.1633333333 |
| 9 | 6.0 | 2.0 | mnq_low | 0 | 5 | 3.0 | mid | null | 30 | 6 | 24 | 0 | 0.2000000000 | 0.8000000000 | 0.6666666667 | 0.3333333333 | 0.0000000000 | 0.0000000000 | 5.8166666667 | 3.3333333333 | 0.2000000000 | 1.1633333333 |
| 10 | 6.0 | 2.0 | mnq_low | 0 | 5 | 3.0 | mid | 0.5 | 30 | 6 | 24 | 0 | 0.2000000000 | 0.8000000000 | 0.6666666667 | 0.3333333333 | 0.0000000000 | 0.0000000000 | 5.8166666667 | 3.3333333333 | 0.2000000000 | 1.1633333333 |

## Check 1: Walk-forward stability

Methodology: Plan A's six calendar-month folds are impossible on the
2026-03-16 to 2026-04-27 sim03 corpus. R6 adapts to six equal-time folds of
five sessions each, preserving the six-fold shape while marking folds with
n_events_total < 20 as indicative only.

| fold | sessions | n_events_total | held-out top-decile? | verdict | train top-1 cell |
|---:|---|---:|---|---|---|
| 1 | 2026-03-16, 2026-03-17, 2026-03-18, 2026-03-19, 2026-03-20 | 5 | false | indicative only (n<20) | pt=6.0, stop=2.0, cost=mnq_low, lat=0, arm=5, offset=3.0, ref=bid_ask, protection=null |
| 2 | 2026-03-23, 2026-03-24, 2026-03-25, 2026-03-26, 2026-03-27 | 5 | false | indicative only (n<20) | pt=6.0, stop=2.0, cost=mnq_low, lat=0, arm=5, offset=3.0, ref=bid_ask, protection=null |
| 3 | 2026-03-30, 2026-03-31, 2026-04-01, 2026-04-02, 2026-04-06 | 5 | false | indicative only (n<20) | pt=6.0, stop=2.0, cost=mnq_low, lat=0, arm=5, offset=3.0, ref=bid_ask, protection=null |
| 4 | 2026-04-07, 2026-04-08, 2026-04-09, 2026-04-10, 2026-04-13 | 5 | false | indicative only (n<20) | pt=6.0, stop=2.0, cost=mnq_low, lat=0, arm=5, offset=3.0, ref=bid_ask, protection=null |
| 5 | 2026-04-14, 2026-04-15, 2026-04-16, 2026-04-17, 2026-04-20 | 5 | false | indicative only (n<20) | pt=6.0, stop=2.0, cost=mnq_low, lat=0, arm=5, offset=3.0, ref=bid_ask, protection=null |
| 6 | 2026-04-21, 2026-04-22, 2026-04-23, 2026-04-24, 2026-04-27 | 5 | false | indicative only (n<20) | pt=6.0, stop=2.0, cost=mnq_low, lat=0, arm=5, offset=3.0, ref=bid_ask, protection=null |

Result: 0/6 evaluable folds met top-decile criterion; all six folds have n<20 and are indicative only. Verdict: N/A due to corpus-size constraint, not pass.

## Check 2: Block-bootstrap on event days

Methodology: stationary block bootstrap via `block_bootstrap.py`, Politis-Romano
median block length `round(n^(1/3))`, 10,000 replications,
deterministic seed `1639091878`. Reported CIs are for top-10 cells at
mnq_mid / 100ms where matching cells exist.

| rank | cell | n | block_len | ci_low | ci_high | pass_lower_gt_0 |
|---:|---|---:|---:|---:|---:|---|
| 1 | pt=6.0, stop=2.0, cost=mnq_mid, lat=100, arm=5, offset=3.0, ref=bid_ask, protection=null | 30 | 3 | -5.5000000000 | -5.5000000000 | false |
| 2 | pt=6.0, stop=2.0, cost=mnq_mid, lat=100, arm=5, offset=3.0, ref=bid_ask, protection=0.5 | 30 | 3 | -5.5000000000 | -5.5000000000 | false |
| 3 | pt=6.0, stop=2.0, cost=mnq_mid, lat=100, arm=5, offset=3.0, ref=bid_ask, protection=1.0 | 30 | 3 | -5.5000000000 | -5.5000000000 | false |
| 4 | pt=6.0, stop=2.0, cost=mnq_mid, lat=100, arm=5, offset=3.0, ref=bid_ask, protection=1.5 | 30 | 3 | -5.5000000000 | -5.5000000000 | false |
| 5 | pt=6.0, stop=2.0, cost=mnq_mid, lat=100, arm=5, offset=3.0, ref=microprice, protection=null | 30 | 3 | -5.5000000000 | -5.5000000000 | false |
| 6 | pt=6.0, stop=2.0, cost=mnq_mid, lat=100, arm=5, offset=3.0, ref=microprice, protection=0.5 | 30 | 3 | -5.5000000000 | -5.5000000000 | false |
| 7 | pt=6.0, stop=2.0, cost=mnq_mid, lat=100, arm=5, offset=3.0, ref=microprice, protection=1.0 | 30 | 3 | -5.5000000000 | -5.5000000000 | false |
| 8 | pt=6.0, stop=2.0, cost=mnq_mid, lat=100, arm=5, offset=3.0, ref=microprice, protection=1.5 | 30 | 3 | -5.5000000000 | -5.5000000000 | false |
| 9 | pt=6.0, stop=2.0, cost=mnq_mid, lat=100, arm=5, offset=3.0, ref=mid, protection=null | 30 | 3 | -5.5000000000 | -5.5000000000 | false |
| 10 | pt=6.0, stop=2.0, cost=mnq_mid, lat=100, arm=5, offset=3.0, ref=mid, protection=0.5 | 30 | 3 | -5.5000000000 | -5.5000000000 | false |

Result: pass only if every top-10 mnq_mid/100ms CI lower bound is > 0; failures are reported without threshold weakening.

## Check 3: Multiple-testing correction

Methodology choice: Deflated Sharpe Ratio via `psr_dsr.py`. Rationale: Plan A
allows DSR, SPA, or White's Reality Check; DSR reuses existing production
infrastructure and uses R4 `total_screened_cells_max=90,720` directly as
`effective_trial_count`.

Top-1 cell: pt=6.0, stop=2.0, cost=mnq_low, lat=0, arm=5, offset=3.0, ref=bid_ask, protection=null
effective_trial_count: 90720
DSR computation failed: ValueError: sample standard deviation must be non-zero
corrected_p_value: unavailable_due_to_dsr_failure
corrected_CI_note: unavailable because DSR failed on the observed return vector; bootstrap CIs in Check 2 remain reported separately.
Verdict: fail; R7 should treat multiple-testing correction as not survived.

## Check 4: Roll-period stratification

is_roll_week=true emitted rows: 0
is_roll_week=false emitted rows: 90720
Verdict: N/A — corpus has no roll-week sessions surviving the n<20 gate, so Plan A's sign/magnitude comparison is structurally inapplicable.

## Check 5: Latency monotonicity

| latency_ms | expectancy_per_trade_usd |
|---:|---:|
| 0 | 5.8166666667 |
| 100 | 5.8166666667 |
| 500 | 5.8166666667 |
| 1000 | 5.8166666667 |

Verdict: pass for monotone non-increasing criterion.

## Check 6: Parameter perturbation

Anchor cell: pt=6.0, stop=2.0, cost=mnq_low, lat=0, arm=5, offset=3.0, ref=bid_ask, protection=null; expectancy_per_trade_usd=5.8166666667

| dimension | direction | target | expectancy_per_trade_usd | verdict |
|---|---:|---|---:|---|
| arm_time_s | -1 | null |  | N/A grid-edge |
| arm_time_s | +1 | 10 | 5.2833333333 | pass |
| trigger_offset_pts | -1 | 2.0 | 1.5500000000 | fail |
| trigger_offset_pts | +1 | null |  | N/A grid-edge |
| reference | -1 | null |  | N/A grid-edge |
| reference | +1 | microprice | 5.8166666667 | pass |
| stop_limit_protection_pts | -1 | null |  | N/A grid-edge |
| stop_limit_protection_pts | +1 | 0.5 | 5.8166666667 | pass |
| pt_pts | -1 | 4.0 | 3.9500000000 | fail |
| pt_pts | +1 | null |  | N/A grid-edge |
| stop_pts | -1 | 1.5 | 5.1500000000 | pass |
| stop_pts | +1 | 2.5 | 5.4833333333 | pass |

Verdict: fail; 2 perturbations exceeded the 30% criterion. N/A grid-edge cases are not counted as failures.

## Implications for R7

R6 does not attempt to engineer a FULL-GO outcome. Corpus limitations from R5
carry forward: five of nine conditioning dimensions have no surviving n>=20
buckets, the walk-forward folds are five sessions each and therefore
statistically thin, and roll-week analysis is structurally N/A. These are
honest research signals for R7's three-state verdict and sample-power gate.
The likely outcome remains RESEARCH-GO/NEEDS-NQ unless R7's explicit
sample-power gate proves otherwise.
