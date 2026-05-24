# MOC Family A descriptive research report

Generated note: Deterministic MOC-R7 report; no wall-clock timestamp emitted.

## Input artifact SHAs

- R1 `event-day-manifest.json`: `1aa076833537f5fbe1bead661e7fd806702a3686dec5f6d945eb27239192dc19`
- R2 `event-paths-methodology.md`: `36d5d83e21f93df94e914a48a5c2df24f151f9f85424ff508f3c3a8cf043da26`
- R2 `event-aggregates.parquet`: `5c6e67701f54038592a387b4d7bb053637f7f9b172a62bad3bd19b60711dc3b9`
- R2 `event-stream.sha256.txt`: `21f293e5c1a295d8c0eec1be415298f12c8b0629373a3505d3dad2cd96e5a5f2`
- R3 `triggered-events.parquet`: `7da601066b958e484238a7fe767f6aead80df83ea38d54bbba1616b6b5dead3f`
- R3 `triggered-events-methodology.md`: `3a83016d264e6ba948b8ebd4c8ebafe62940e73edddd402dc2eaf84e956697db`
- R4 `expectancy-tables.parquet`: `4341c862047b23414218c92ce56c9ae299f6cef496de304aa767feedd87b75cd`
- R4 `expectancy-tables-methodology.md`: `f5dd384302a87d3b11fa464e9220c4a237c0b0f60cf841a678f01bd7bd7b3a18`
- R4 `research-grid-manifest.json`: `8b41582e1dec3da049e31dab030a3e02b9a3e7973ddbad761e2874e3d4eda924`
- R5 `conditioning-tables.parquet`: `1bc098e10e39d588962d89594c432ee8df87776352c69f625db42b83a6db5fd3`
- R5 `conditioning-summary.md`: `ced051303380ff931d3511fc61d014b87ef7bd651150a84e5fa1acaaad4a27ed`
- R6 `robustness-report.md`: `af91ecf7fad8fca381a8f72b7bec9862ab4cb0786ce871235b34cc9164e6efbb`

## 1. Executive summary

Verdict: **NO-GO**.

Plan A Family A breakout-capture research is closed on the current MNQ-only sim03 corpus. The leading MNQ cell has attractive raw expectancy, but the literal Plan A R7 criteria trigger NO-GO through failed bootstrap confidence bounds and failed multiple-testing correction. The sample-power gate also fails by a wide margin.

Best full-R4 cell: pt=6.0, stop=2.0, cost=mnq_low, latency=0ms, arm=5s, offset=3.0, reference=bid_ask, protection=null, expected_daily_pnl_usd=1.1633333333.
Top mnq_mid/100ms sample-power cell: pt=6.0, stop=2.0, cost=mnq_mid, latency=100ms, arm=5s, offset=3.0, reference=bid_ask, protection=null, expected_daily_pnl_usd=1.0333333333.
Observed trades/session: `0.2000000000`. Required sessions for 300 trades: `1500`. Available sessions: `30`.

Headline numbers:

| metric | value | source |
|---|---:|---|
| top full-table expected_daily_pnl_usd | 1.1633333333 | R4 expectancy-tables |
| top mnq_mid/100ms expectancy_per_trade_usd | 5.1666666667 | R4 expectancy-tables |
| top mnq_mid/100ms trade_frequency_per_session | 0.2000000000 | R4 expectancy-tables |
| sample-power required_sessions | 1500 | R7 gate |
| bootstrap lower bound | -5.5000000000 | R6 robustness-report |
| DSR correction | fail: zero sample standard deviation | R6 robustness-report |

## 2. Event definition + corpus inventory

Family A uses C0/I0 discipline from MOC-R1. C0 is the cash-close instant. I0 is the imbalance anchor at C0 minus 10 minutes. R2/R3/R4 operate over event windows relative to I0, not C0.

| inventory item | value | source |
|---|---:|---|
| manifest sessions | 31 | R1 manifest |
| data-present RTH sessions | 30 | R1 manifest |
| synthesized holiday rows | 1 | R1 manifest |
| macro-day rows | 2 | R1 manifest |
| event-aggregate rows | 30 | R2 event-aggregates |
| triggered-event rows | 21600 | R3 triggered-events |
| expectancy rows | 90720 | R4 expectancy-tables |
| conditioning rows | 362880 | R5 conditioning-tables |

The synthesized 2026-04-03 Good Friday row is retained in the calendar manifest and excluded from data-present RTH computations. This preserves the calendar signal without creating artificial trade rows.

## 3. Family taxonomy reminder

Family A breakout-capture verdict only. This report does NOT claim directional MOC prediction. Predictive strategies (Family C) require NOII / QQQ-ETF basket / cross-market data and are out of scope here.

The tested thesis is whether event-level OCO breakout capture around the MOC imbalance anchor is robust enough to proceed. It is not an assertion that the model forecasts the sign of the closing auction move.

## 4. Eight descriptive tables

### Table 1 — Corpus sessions by day of week

| day_of_week | sessions | source |
|---|---:|---|
| Fri | 5 | R1 manifest |
| Mon | 7 | R1 manifest |
| Thu | 6 | R1 manifest |
| Tue | 6 | R1 manifest |
| Wed | 6 | R1 manifest |

### Table 2 — Calendar flags

| flag | true_sessions | false_sessions | source |
|---|---:|---:|---|
| is_macro_day | 1 | 29 | R1 manifest |
| is_roll_week | 0 | 30 | R1 manifest |
| is_month_end | 1 | 29 | R1 manifest |
| is_quarter_end | 1 | 29 | R1 manifest |
| is_triple_witching | 1 | 29 | R1 manifest |

### Table 3 — Pre-event spread buckets at I0-10s

| spread_ticks | sessions | source |
|---|---:|---|
| 1 | 3 | R2 event-aggregates |
| 2 | 23 | R2 event-aggregates |
| 3 | 4 | R2 event-aggregates |

### Table 4 — Pre-event imbalance buckets at I0-10s

| imbalance_bucket | sessions | source |
|---|---:|---|
| neutral | 18 | R2 event-aggregates |
| strong_ask | 6 | R2 event-aggregates |
| strong_bid | 6 | R2 event-aggregates |

### Table 5 — First-minute event path ranges

| metric | mean | median | max | source |
|---|---:|---:|---:|---|
| first_5s_range_pts | 14.3417 | 12.3750 | 55.5000 | R2 event-aggregates |
| first_30s_range_pts | 21.1708 | 17.7500 | 55.5000 | R2 event-aggregates |
| first_60s_range_pts | 23.4833 | 19.6250 | 55.5000 | R2 event-aggregates |

### Table 6 — R3 trigger outcome distribution

| outcome | rows | source |
|---|---:|---|
| both_sides | 19600 | R3 triggered-events |
| buy_only | 1840 | R3 triggered-events |
| sell_only | 160 | R3 triggered-events |

### Table 7 — R4 expectancy by cost scenario

| cost_scenario | max_daily_pnl | mean_daily_pnl | min_daily_pnl | source |
|---|---:|---:|---:|---|
| mnq_high | 0.8333333333 | -0.0760276308 | -0.4900000000 | R4 expectancy-tables |
| mnq_low | 1.1633333333 | 0.0767501470 | -0.1255555556 | R4 expectancy-tables |
| mnq_mid | 1.0333333333 | 0.0165649618 | -0.2566666667 | R4 expectancy-tables |

### Table 8 — Research-grid and conditioning coverage

| item | value | source |
|---|---:|---|
| trigger_cells | 720 | R4 research-grid-manifest |
| exit_cells | 42 | R4 research-grid-manifest |
| cost_cells | 3 | R4 research-grid-manifest |
| total_screened_cells_max | 90720 | R4 research-grid-manifest |
| surviving_condition_buckets | 4 | R4/R5 outputs |

## 5. Conditioning section

R5 found that only four (dimension, bucket) groups survived the n>=20 filter: `is_roll_week=false`, `is_macro_day=false`, the boring weekday calendar-combinatorial bucket, and `pre_event_spread_ticks_t_minus_10s=2`. Five of nine dimensions had zero surviving buckets.

Top-10 conditioned rows from R5:

| rank | dimension | bucket | pt | stop | cost | latency | arm | offset | reference | protection | n | daily_pnl | p_pt | p_stop |
|---:|---|---|---:|---:|---|---:|---:|---:|---|---|---:|---:|---:|---:|
| 1 | pre_event_spread_ticks_t_minus_10s | 2 | 6.0 | 3.0 | mnq_low | 0 | 10 | 3.0 | microprice | null | 23 | 1.2908695652 | 0.7391304348 | 0.2608695652 |
| 2 | pre_event_spread_ticks_t_minus_10s | 2 | 6.0 | 3.0 | mnq_low | 0 | 10 | 3.0 | microprice | 0.5 | 23 | 1.2908695652 | 0.7391304348 | 0.2608695652 |
| 3 | pre_event_spread_ticks_t_minus_10s | 2 | 6.0 | 3.0 | mnq_low | 0 | 10 | 3.0 | microprice | 1.0 | 23 | 1.2908695652 | 0.7391304348 | 0.2608695652 |
| 4 | pre_event_spread_ticks_t_minus_10s | 2 | 6.0 | 3.0 | mnq_low | 0 | 10 | 3.0 | microprice | 1.5 | 23 | 1.2908695652 | 0.7391304348 | 0.2608695652 |
| 5 | pre_event_spread_ticks_t_minus_10s | 2 | 6.0 | 3.0 | mnq_low | 100 | 10 | 3.0 | microprice | null | 23 | 1.2908695652 | 0.7391304348 | 0.2608695652 |
| 6 | pre_event_spread_ticks_t_minus_10s | 2 | 6.0 | 3.0 | mnq_low | 100 | 10 | 3.0 | microprice | 0.5 | 23 | 1.2908695652 | 0.7391304348 | 0.2608695652 |
| 7 | pre_event_spread_ticks_t_minus_10s | 2 | 6.0 | 3.0 | mnq_low | 100 | 10 | 3.0 | microprice | 1.0 | 23 | 1.2908695652 | 0.7391304348 | 0.2608695652 |
| 8 | pre_event_spread_ticks_t_minus_10s | 2 | 6.0 | 3.0 | mnq_low | 100 | 10 | 3.0 | microprice | 1.5 | 23 | 1.2908695652 | 0.7391304348 | 0.2608695652 |
| 9 | pre_event_spread_ticks_t_minus_10s | 2 | 6.0 | 3.0 | mnq_low | 500 | 10 | 3.0 | microprice | null | 23 | 1.2908695652 | 0.7391304348 | 0.2608695652 |
| 10 | pre_event_spread_ticks_t_minus_10s | 2 | 6.0 | 3.0 | mnq_low | 500 | 10 | 3.0 | microprice | 0.5 | 23 | 1.2908695652 | 0.7391304348 | 0.2608695652 |

This concentration is informative but not sufficient for Plan B. The leading conditioned cell is a 23-event subset and therefore still short of Plan A's sample-power standard.

## 6. Robustness verdict

| R6 check | result | verdict impact |
|---|---|---|
| Walk-forward stability | N/A: six 5-session folds, all n<20 | Not FULL-GO eligible; not an actual NO-GO walk-forward fail |
| Block-bootstrap CIs | FAIL: all top-10 mnq_mid/100ms CI lower bounds = -5.5 | NO-GO trigger fires |
| DSR multiple-testing correction | FAIL: zero sample standard deviation | NO-GO trigger fires |
| Roll-period stratification | N/A: no roll-week sessions | Not FULL-GO eligible |
| Latency monotonicity | PASS: flat across 0/100/500/1000ms | FULL-GO criterion passes |
| Parameter perturbation | FAIL: 2 perturbations exceed 30% | FULL-GO criterion fails |

R6 preserved CF-44 anti-near-miss discipline: failures were not converted to N/A, thresholds were not weakened, and DSR failure was not method-switched into a more favorable test.

## 7. Top-3 candidate parameter-lock baselines

Because the final verdict is NO-GO, there is **no recommendation** and Plan B is closed for this corpus. The following top-3 cells are recorded only as diagnostic baselines, not parameter locks:

| rank | pt | stop | cost | latency | arm | offset | reference | protection | daily_pnl | exp_usd | freq |
|---:|---:|---:|---|---:|---:|---:|---|---|---:|---:|---:|
| 1 | 6.0 | 2.0 | mnq_low | 0 | 5 | 3.0 | bid_ask | null  1.1633333333 | 5.8166666667 | 0.2000000000 |
| 2 | 6.0 | 2.0 | mnq_low | 0 | 5 | 3.0 | bid_ask | 0.5  1.1633333333 | 5.8166666667 | 0.2000000000 |
| 3 | 6.0 | 2.0 | mnq_low | 0 | 5 | 3.0 | bid_ask | 1.0  1.1633333333 | 5.8166666667 | 0.2000000000 |

Verdict-dependent caveat: these are not authorized for MOC-A1, EXEC primitives, or any live/paper dispatch. A future research cycle may use them only as historical context.

## 8. Mathematical sample-power gate

Plan A R7 defines:

`observed_trades_per_strategy_per_session = leading-cell trade_frequency_per_session from R4 at mnq_mid/100ms`

`required_sessions = ceil(300 / observed_trades_per_strategy_per_session)`

Observed value: `0.2000000000` trades/session.
Computed required_sessions: `ceil(300 / 0.2000000000) = 1500`.
Available sessions: `30`.
Sample-power gate verdict: **FAIL**.

Since required_sessions exceeds available_sessions, MOC-CYCLE3 / Plan B is blocked until the archive is extended to the required session count or an ADR amendment explicitly creates a lower-power event-strategy exception to ADR-0016's 300-trade floor.

## 9. Three-state verdict

Verdict logic applied literally:

1. Check all FULL-GO criteria. FULL-GO requires every criterion to pass for the same parameter cell.
2. If FULL-GO is not met, check NO-GO triggers. If any trigger fires, verdict is NO-GO.
3. Otherwise, verdict is RESEARCH-GO / NEEDS-NQ.

### FULL-GO criteria

| criterion | value | pass |
|---|---|---|
| Primary expectancy >= $1.50 at mnq_mid/100ms | 5.1666666667 | true |
| Stress expectancy > $0 at mnq_high/500ms | 4.1666666667 | true |
| Hit rate p_pt_hit_before_stop >= 0.45 | 0.6666666667 | true |
| Both-side false-trigger <= 0.20 | 0.8000000000 | false |
| Stop-limit miss-rate <= 0.10 | 0.0000000000 | true |
| Walk-forward stability >=4/6 | N/A: all folds n<20 | false |
| Bootstrap CI lower bound > 0 | -5.5000000000 | false |
| Multiple-testing correction survives | DSR fail: zero std | false |
| Parameter perturbation within 30% in all 12 | fail: 2 perturbations exceed 30% | false |
| Latency monotonicity | pass | true |
| Trade frequency >=0.5 and required_sessions <= available | freq=0.2000000000, required=1500, available=30 | false |
| NQ confirmation mandatory | N/A: NQ corpus unavailable | false |

### NO-GO triggers

| trigger | value | fires |
|---|---|---|
| expectancy_per_trade_usd < $0.50 at mnq_mid/100ms | 5.1666666667 | false |
| Bootstrap 95% CI lower bound <= 0 | -5.5000000000 | true |
| Walk-forward stability actual fail | N/A, not actual fail | false |
| Latency monotonicity fails | pass | false |
| Multiple-testing correction kills leading cell | DSR fail | true |

### RESEARCH-GO / NEEDS-NQ check

This state is bypassed because NO-GO triggers fire. Sample-power remediation is in scope in principle, and NQ is missing, but Plan A's NO-GO trigger list is already satisfied.

FULL-GO does not hold. NO-GO triggers fire through bootstrap CI lower bound <= 0 and multiple-testing correction failure. Therefore the deterministic verdict is **NO-GO**.

RESEARCH-GO / NEEDS-NQ is not selected because the literal NO-GO triggers fire before the fallback state. NQ confirmation is missing, but missing NQ does not override failed bootstrap and failed DSR criteria.

## 10. Risks & open questions

- Corpus-size limitation is severe: sample-power requires 1500 sessions at the observed trade frequency.
- The top mnq_mid/100ms return vector is degenerate; R6 bootstrap and DSR surface the same zero-variance issue.
- R5 conditioning is underpowered for five of nine planned dimensions.
- Roll-week behavior is unobserved in this corpus.
- NQ confirmation is unavailable because QFA-119f has not supplied an NQ corpus.
- Family C predictive research remains out of scope and would require NOII / QQQ-ETF basket / cross-market data.

Closing statement: Plan A Family A descriptive research is complete for the current corpus. The documented outcome is negative for Plan B dispatch on this substrate.
