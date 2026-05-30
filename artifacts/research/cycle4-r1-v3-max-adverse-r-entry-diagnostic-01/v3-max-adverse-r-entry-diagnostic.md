# CYCLE4-R1-V3-MAX-ADVERSE-R-ENTRY-DIAGNOSTIC-01

## Source

- Source artifact: `artifacts/held-out-validation/cycle4-r1-v3-early-adverse-diagnostic-02/regime_shock_reversion_short_v3-feb-mar-apr-2026.json`
- SHA-256: `acc2ee2f27e08fab09bf0c21cbce5f409b86633a4df51782357a07b565e3476f`
- Schema version: `1`

## Decision

- Decision: `NO_ENTRY_VARIANT_JUSTIFIED`
- Basis: best candidate clears break-even only by filtering 788/889 trades; this is strategy suppression, not a targeted max-adverse entry filter

## Anchor reconciliation

- Status: `matched`
- Total trades: `889`
- Max-adverse-R fail-safes: `245`
- Target exits: `259`
- Stop-loss exits: `363`
- Net PnL cents: `-102600`

## Within-exit-class winners and losers

| Class | Total | Winners | Losers | Net PnL cents |
|---|---:|---:|---:|---:|
| max_adverse_r | 245 | 0 | 245 | -580100 |
| session_close | 5 | 5 | 0 | 1000 |
| spread_fail_safe | 17 | 14 | 3 | 47650 |
| stop_loss | 363 | 113 | 250 | -313150 |
| target | 259 | 259 | 0 | 742000 |

## Best single-predicate candidate

| Rule | Complexity | Affected | Net delta | PF proxy | Target damage | Max adverse avoided | Top1 session | Top3 session | Fragile |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| vix_value < 26 | single_predicate | 820 | 195150 | 2.194194 | 572300 | 537650 | 20.07% | 50.09% | no |

## Best two-predicate candidate

| Rule | Complexity | Affected | Net delta | PF proxy | Target damage | Max adverse avoided | Top1 session | Top3 session | Fragile |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| vix_value < 26 AND entry_hour_utc_bucket != 14 | two_predicate | 788 | 212400 | 1.956446 | 518000 | 512600 | 20.01% | 50.53% | no |

## Top single-predicate candidates

| Rule | Complexity | Affected | Net delta | PF proxy | Target damage | Max adverse avoided | Top1 session | Top3 session | Fragile |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| vix_value < 26 | single_predicate | 820 | 195150 | 2.194194 | 572300 | 537650 | 20.07% | 50.09% | no |
| vix_value < 22 | single_predicate | 666 | 183700 | 1.250154 | 387600 | 356600 | 21.66% | 53.58% | no |
| vix_value < 22.37 | single_predicate | 666 | 183700 | 1.250154 | 387600 | 356600 | 21.66% | 53.58% | no |
| vix_prior_close_percentile < 0.8667 | single_predicate | 667 | 183650 | 1.25 | 387600 | 356600 | 21.66% | 53.58% | no |
| vix_value < 24 | single_predicate | 667 | 183650 | 1.25 | 387600 | 356600 | 21.66% | 53.58% | no |
| vix_value < 24.06 | single_predicate | 667 | 183650 | 1.25 | 387600 | 356600 | 21.66% | 53.58% | no |
| entry_hour_utc >= 15 | single_predicate | 829 | 180800 | 2.106865 | 593500 | 532650 | 18.13% | 47.03% | no |
| vix_prior_close_percentile < 0.9 | single_predicate | 670 | 176200 | 1.22882 | 397600 | 356600 | 21.57% | 53.34% | no |
| vix_prior_close_percentile < 0.9333 | single_predicate | 670 | 176200 | 1.22882 | 397600 | 356600 | 21.57% | 53.34% | no |
| entry_hour_utc_bucket != 14 | single_predicate | 841 | 171950 | 2.36785 | 622200 | 550050 | 18.51% | 46.72% | no |

## Top two-predicate candidates

| Rule | Complexity | Affected | Net delta | PF proxy | Target damage | Max adverse avoided | Top1 session | Top3 session | Fragile |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| vix_value < 26 AND entry_hour_utc_bucket != 14 | two_predicate | 788 | 212400 | 1.956446 | 518000 | 512600 | 20.01% | 50.53% | no |
| vix_value < 26 AND entry_hour_utc >= 15 | two_predicate | 779 | 211800 | 1.826021 | 501300 | 495200 | 19.58% | 50.79% | no |
| vix_value < 26 AND recent_shock.min_last_5 >= 1.4998 | two_predicate | 761 | 201450 | 1.674054 | 497200 | 485450 | 21.16% | 52.29% | no |
| vix_value < 26 AND recent_shock.min_last_5 >= 1.5 | two_predicate | 761 | 201450 | 1.674054 | 497200 | 485450 | 21.16% | 52.29% | no |
| entry_hour_utc_bucket != 14 AND recent_shock.min_last_5 >= 1.4998 | two_predicate | 778 | 192700 | 1.739737 | 530700 | 502950 | 20.19% | 49.85% | no |
| entry_hour_utc_bucket != 14 AND recent_shock.min_last_5 >= 1.5 | two_predicate | 778 | 192700 | 1.739737 | 530700 | 502950 | 20.19% | 49.85% | no |
| vix_value < 26 AND recent_shock.mean_last_3 >= 2.75 | two_predicate | 717 | 189700 | 1.429064 | 456900 | 439000 | 20.72% | 51.31% | no |
| vix_prior_close_percentile < 0.8667 AND recent_shock.min_last_5 >= 1.4998 | two_predicate | 634 | 188150 | 1.241872 | 353700 | 337800 | 22.07% | 54.04% | no |
| vix_prior_close_percentile < 0.8667 AND recent_shock.min_last_5 >= 1.5 | two_predicate | 634 | 188150 | 1.241872 | 353700 | 337800 | 22.07% | 54.04% | no |
| vix_prior_close_percentile < 0.9 AND recent_shock.min_last_5 >= 1.4998 | two_predicate | 634 | 188150 | 1.241872 | 353700 | 337800 | 22.07% | 54.04% | no |

## VIX freshness

| Class | True | False | Missing |
|---|---:|---:|---:|
| all_trades | 889 | 0 | 0 |
| max_adverse_r | 245 | 0 | 0 |
| session_close | 5 | 0 | 0 |
| spread_fail_safe | 17 | 0 | 0 |
| stop_loss | 363 | 0 | 0 |
| target | 259 | 0 | 0 |

## Recommendation

No entry-filter variant is justified from current pre-entry evidence; keep v3 registered-inactive and avoid further entry tuning unless new evidence is introduced.

## Authority caveat

No activation, paper observation, broker/live dispatch, Phase 6 authority, ACTIVE roster mutation, strategy mutation, or management-profile mutation is authorized.
