# MOC-LO long-only counterfactual comparison

## Verdict

**ACCEPT LONG-ONLY ALSO FAILS.**

The binary recommendation is driven by the exploratory load-bearing tests: bootstrap CI lower bound and DSR. Marginal improvements in other criteria are not enough under CF-44 anti-near-miss discipline.

## Catalog provenance

- `triggered_events_sha`: `7da601066b958e484238a7fe767f6aead80df83ea38d54bbba1616b6b5dead3f`
- `expectancy_tables_sha`: `4341c862047b23414218c92ce56c9ae299f6cef496de304aa767feedd87b75cd`
- `event_stream_sha`: `f9effd810b609c03394e96c69e473e9d388eec82accdcbf8975494a307c330cb`
- `event_stream_attestation_sha`: `f9effd810b609c03394e96c69e473e9d388eec82accdcbf8975494a307c330cb  event-stream.parquet`
- `r7_report_sha`: `3bd67ae4fe7b1be14d307c4623777d9d2b7c6b54d58d720ecdfa31d2dbc8942b`
- `research_grid_manifest_sha`: `8b41582e1dec3da049e31dab030a3e02b9a3e7973ddbad761e2874e3d4eda924`
- Production statistical modules were loaded read-only using the MOC-R6 importlib + scoped sys.path + sys.modules registration pattern.

## Long-only top 10 by expected_daily_pnl_usd

| pt_pts | stop_pts | cost_scenario | latency_bucket_ms | arm_time_s | trigger_offset_pts | reference | stop_limit_protection_pts | n_long_entered | expectancy_per_trade_usd | expected_daily_pnl_usd |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 6 | 2.5 | mnq_low | 0 | 5 | 0.5 | bid_ask | 0.5 | 30 | 7.75 | 7.75 |
| 6 | 2.5 | mnq_low | 0 | 5 | 0.5 | bid_ask | 1.0 | 30 | 7.75 | 7.75 |
| 6 | 2.5 | mnq_low | 0 | 5 | 0.5 | bid_ask | 1.5 | 30 | 7.75 | 7.75 |
| 6 | 2.5 | mnq_low | 0 | 5 | 0.5 | bid_ask | null | 30 | 7.75 | 7.75 |
| 6 | 2.5 | mnq_low | 0 | 5 | 0.5 | mid | 0.5 | 30 | 7.75 | 7.75 |
| 6 | 2.5 | mnq_low | 0 | 5 | 0.5 | mid | 1.0 | 30 | 7.75 | 7.75 |
| 6 | 2.5 | mnq_low | 0 | 5 | 0.5 | mid | 1.5 | 30 | 7.75 | 7.75 |
| 6 | 2.5 | mnq_low | 0 | 5 | 0.5 | mid | null | 30 | 7.75 | 7.75 |
| 6 | 2.5 | mnq_low | 100 | 5 | 0.5 | bid_ask | 0.5 | 30 | 7.75 | 7.75 |
| 6 | 2.5 | mnq_low | 100 | 5 | 0.5 | bid_ask | 1.0 | 30 | 7.75 | 7.75 |

## Bilateral R4 top 10 by expected_daily_pnl_usd

| pt_pts | stop_pts | cost_scenario | latency_bucket_ms | arm_time_s | trigger_offset_pts | reference | stop_limit_protection_pts | expectancy_per_trade_usd | expected_daily_pnl_usd |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 6 | 2 | mnq_low | 0 | 5 | 3 | bid_ask | 0.5 | 5.8166666667 | 1.1633333333 |
| 6 | 2 | mnq_low | 0 | 5 | 3 | bid_ask | 1.0 | 5.8166666667 | 1.1633333333 |
| 6 | 2 | mnq_low | 0 | 5 | 3 | bid_ask | 1.5 | 5.8166666667 | 1.1633333333 |
| 6 | 2 | mnq_low | 0 | 5 | 3 | bid_ask | null | 5.8166666667 | 1.1633333333 |
| 6 | 2 | mnq_low | 0 | 5 | 3 | microprice | 0.5 | 5.8166666667 | 1.1633333333 |
| 6 | 2 | mnq_low | 0 | 5 | 3 | microprice | 1.0 | 5.8166666667 | 1.1633333333 |
| 6 | 2 | mnq_low | 0 | 5 | 3 | microprice | 1.5 | 5.8166666667 | 1.1633333333 |
| 6 | 2 | mnq_low | 0 | 5 | 3 | microprice | null | 5.8166666667 | 1.1633333333 |
| 6 | 2 | mnq_low | 0 | 5 | 3 | mid | 0.5 | 5.8166666667 | 1.1633333333 |
| 6 | 2 | mnq_low | 0 | 5 | 3 | mid | 1.0 | 5.8166666667 | 1.1633333333 |

## Direct A/B at long-only top-10 coordinates

| pt_pts | stop_pts | cost_scenario | latency_bucket_ms | arm_time_s | trigger_offset_pts | reference | stop_limit_protection_pts | long_only_daily_usd | bilateral_daily_usd | delta_usd |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 6 | 2.5 | mnq_low | 0 | 5 | 0.5 | bid_ask | 0.5 | 7.75 | -0.0061111111 | 7.7561111111 |
| 6 | 2.5 | mnq_low | 0 | 5 | 0.5 | bid_ask | 1.0 | 7.75 | -0.0061111111 | 7.7561111111 |
| 6 | 2.5 | mnq_low | 0 | 5 | 0.5 | bid_ask | 1.5 | 7.75 | -0.0061111111 | 7.7561111111 |
| 6 | 2.5 | mnq_low | 0 | 5 | 0.5 | bid_ask | null | 7.75 | -0.0061111111 | 7.7561111111 |
| 6 | 2.5 | mnq_low | 0 | 5 | 0.5 | mid | 0.5 | 7.75 | -0.0061111111 | 7.7561111111 |
| 6 | 2.5 | mnq_low | 0 | 5 | 0.5 | mid | 1.0 | 7.75 | -0.0061111111 | 7.7561111111 |
| 6 | 2.5 | mnq_low | 0 | 5 | 0.5 | mid | 1.5 | 7.75 | -0.0061111111 | 7.7561111111 |
| 6 | 2.5 | mnq_low | 0 | 5 | 0.5 | mid | null | 7.75 | -0.0061111111 | 7.7561111111 |
| 6 | 2.5 | mnq_low | 100 | 5 | 0.5 | bid_ask | 0.5 | 7.75 | -0.0061111111 | 7.7561111111 |
| 6 | 2.5 | mnq_low | 100 | 5 | 0.5 | bid_ask | 1.0 | 7.75 | -0.0061111111 | 7.7561111111 |

## Buy/sell asymmetry

Plan A R3 one-sided cells: buy_only=1840, sell_only=160, ratio=11.5000. A simple one-sided-cell 50/50 chi-square diagnostic is 1411.2000 with z=37.5659; normal-tail p is approximately 0.0000e+00. This is statistically large at cell level, but grid cells are not independent because each session contributes many parameter cells.

## Both-sides buy-first resolution

both_sides total=19600; buy-first=12272; sell-first=7328; equal-ts=0. The implementation recomputes every long-side entry from the buy trigger using event-stream prints, so sell-first both_sides rows never copy R3's short-side singular fields.

## Bootstrap and DSR diagnostics

Top mnq_mid/100ms long-only cell: pt=6.0, stop=2.5, arm=5, offset=0.5, reference=bid_ask, protection=0.5.
Bootstrap: seed=551680880, replications=10000, block_length=3, mean=7.1000000000, ci_low=4.2666666667, ci_high=9.3666666667.
DSR: `{"benchmark_hurdle_sharpe": 0.068850986, "dsr_probability": 0.1194080475, "dsr_statistic": -1.1779511163, "effective_trial_count": 90720, "kurtosis": 3.0369444444, "observed_sharpe": 1.0265682014, "psr_hurdle_null": 0.9985473532, "psr_zero_null": 0.9992926756, "skewness": -1.4256285164, "status": "computed"}`.

## Plan A R7 criterion comparison

| Criterion | Bilateral R7 | Long-only | Evidence |
| --- | --- | --- | --- |
| Primary expectancy >= $1.50 at mnq_mid/100ms | true | True | $7.1000000000/trade |
| Stress expectancy > $0 at mnq_high/500ms | true | True | $6.1000000000/trade |
| Hit rate >= 0.45 | true | True | 0.8000000000 |
| Both-side false-trigger <= 0.20 | false | N/A | Long-only has no sell leg |
| Stop-limit miss-rate <= 0.10 | true | True | 0.0000000000 |
| Bootstrap CI lower bound > 0 | FAILED | PASS | ci_low=4.2666666667 |
| Multiple-testing correction survives | FAILED | FAIL | {"benchmark_hurdle_sharpe": 0.068850986, "dsr_probability": 0.1194080475, "dsr_statistic": -1.1779511163, "effective_trial_count": 90720, "kurtosis": 3.0369444444, "observed_sharpe": 1.0265682014, "psr_hurdle_null": 0.9985473532, "psr_zero_null": 0.9992926756, "skewness": -1.4256285164, "status": "computed"} |
| Parameter perturbation within 30% | FAILED | not recomputed | Counterfactual only; full stream would rerun R6 |
| Latency monotonicity | PASS | not recomputed | Counterfactual memo does not rerun full R6 |
| Trade frequency >= 0.5 and sample-power | FAILED | True | freq=1.0000000000 |
| NQ confirmation | N/A | N/A | No NQ corpus in this dispatch |

## Methodology notes

Rows preserve the R4 MNQ-only grid shape: 7 pt x 6 stop x 3 cost x 4 latency x 3 arm x 5 offset x 3 reference x 4 protection x 1 instrument = 90,720 rows. Long-only adds n_long_entered, p_long_entered, and exit_reason_share to the 23 R4-compatible columns.
Stop-market cells fill at the first print at or after the buy trigger. Stop-limit cells fill at the first print at or below stop_price + protection before I0+300s; otherwise they are counted as missed entries. First-touch exits walk forward from the long fill timestamp only, preserving no-lookahead discipline.
DSR decimal returns use per-session USD returns divided by a fixed $1,000 research notional. The scaling is deterministic and reported only for this exploratory screen; a full MOC-LO stream would restate the statistical protocol before production consideration.

## Binary recommendation

ACCEPT LONG-ONLY ALSO FAILS
