# QFA-611 strategy selection v1

- Run status: `partial_evidence`
- Phase 6 dispatch authorized: `False`
- Execution fragility: `True`

| Strategy | Verdict | Evidence status | Reason |
|---|---|---|---|
| `trend_pullback_long` | REJECT | complete | three_or_more_stage1_thresholds_failed |
| `trend_pullback_short` | REJECT | complete | three_or_more_stage1_thresholds_failed |
| `breakout_retest_long` | RESEARCH_FURTHER | incomplete | sample standard deviation must be non-zero |
| `breakdown_retest_short` | RESEARCH_FURTHER | incomplete | sample standard deviation must be non-zero |
| `regime_mean_reversion_long` | REJECT | complete | three_or_more_stage1_thresholds_failed |
| `regime_mean_reversion_short` | RESEARCH_FURTHER | complete | one_or_two_thresholds_failed_within_20pct |
| `liquidity_sweep_reversal_long` | REJECT | complete | three_or_more_stage1_thresholds_failed |
| `liquidity_sweep_reversal_short` | REJECT | complete | three_or_more_stage1_thresholds_failed |
