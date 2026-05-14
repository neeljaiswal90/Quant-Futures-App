# QFA-611 strategy selection v1

- Run status: `complete`
- Phase 6 dispatch authorized: `True`
- Execution fragility: `False`

| Strategy | Verdict | Evidence status | Reason |
|---|---|---|---|
| `vwap_overnight_reversal_long` | REJECT | complete | three_or_more_stage1_thresholds_failed |
| `vwap_overnight_reversal_short` | REJECT | complete | three_or_more_stage1_thresholds_failed |
| `regime_shock_reversion_short_v2` | ADVANCE_TO_PAPER | complete | all_stage1_thresholds_passed |
