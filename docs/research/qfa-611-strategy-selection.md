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
