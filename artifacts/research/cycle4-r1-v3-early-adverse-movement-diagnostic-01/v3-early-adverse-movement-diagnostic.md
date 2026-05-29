# v3 Early Adverse Movement Diagnostic

## Anchor reconciliation

| Metric | Value |
|---|---:|
| Total trades | 889 |
| Max-adverse-R fail-safes | 245 |
| Target exits | 259 |
| Stop-loss exits | 363 |
| Spread fail-safes | 17 |
| Session-close exits | 5 |
| Total net PnL cents | -102600 |

## Class summaries

| Class | Count | Net PnL cents | Avg PnL cents | Median hold min | Under 2m % | Median MAE cents | Median MFE cents |
|---|---:|---:|---:|---:|---:|---:|---:|
| max_adverse_r | 245 | -580100 | -2367.76 | 1.0028 | 71.02 | -2400 | 650 |
| target | 259 | 742000 | 2864.86 | 1.9998 | 51.74 | -400 | 3450 |
| stop_loss | 363 | -313150 | -862.67 | 1.9956 | 60.33 | -1300 | 1000 |
| spread_fail_safe | 17 | 47650 | 2802.94 | 1.0047 | 88.24 | -1200 | 3550 |
| session_close | 5 | 1000 | 200 | 0.9998 | 80 | -200 | 450 |

## Candidate separators

| Feature | Actionability | Max adverse captured | Targets at risk | Net vs targets only cents | Notes |
|---|---|---:|---:|---:|---|
| exclude_vix_prior_close_percentile_ge_0_85 | pre-entry usable | 66 (26.94%) | 92 (35.52%) | -141350 | Not recommended as a standalone filter because targets have higher exposure than max-adverse trades. |
| exclude_vix_prior_close_percentile_0_25_to_0_50 | pre-entry usable | 101 (41.22%) | 94 (36.29%) | -9000 | Largest max-adverse count bucket, but target exposure is also large; needs richer context. |
| exclude_worst_spread_bucket_3_plus_ticks | pre-entry usable if spread_bucket is entry-time context | 40 (16.33%) | 45 (17.37%) | -40100 | Potentially available but likely broad; must quantify target loss before any implementation. |
| exclude_queue_bucket_1_to_5 | pre-entry usable if queue bucket is entry-time context | 123 (50.2%) | 150 (57.92%) | -162400 | Queue bucket is available, but current evidence does not prove a clean adverse-only separator. |
| hold_time_under_2_minutes | early-post-entry only | 174 (71.02%) | 134 (51.74%) | 34450 | Corroborates R2 chop-flip timing but is not a pre-entry filter. |
| mae_at_or_below_minus_2000_cents | outcome-only / diagnostic only | 154 (62.86%) | 2 (0.77%) | 454000 | Strong realized separator; useful only if future evidence finds a pre-entry proxy. |

## Break-even tradeoff

Break-even gap: 102600 cents.

PF pass gap, if gross profit is unchanged: 309593 cents.

Required average max-adverse trades avoided for break-even with no target loss: 44.

Required average max-adverse trades avoided for PF pass with no target loss: 131.

## Recommendation

Current serialized pre-entry fields do not provide a clean separator with acceptable winner-filter risk. Route a narrow evidence-surface extension or controlled replay instrumentation before tuning.

