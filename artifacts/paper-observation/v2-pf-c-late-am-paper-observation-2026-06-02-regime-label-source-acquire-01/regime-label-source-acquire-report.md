# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-REGIME-LABEL-SOURCE-ACQUIRE-01

## Determination

`SCOPED_REGIME_LABEL_SOURCE_ACQUIRED_NOT_GLOBAL`

| Field | Value |
|---|---|
| target_session_id | 2026-06-02-rth |
| confirmed_label | low |
| raw_label | low |
| primary_value | 16.05 |
| primary_percentile | 0.05 |
| primary_prior_close_date | 2026-06-01 |
| transition_pending | false |
| materialization_scope | scoped_paper_observation_source_only |
| global_regime_labels_mutated | false |
| scoped_regime_label_source_lf_sha256 | 152e7fbfdfca52494edbb11a7364cfbbaf33e9d03390bca1f17ee739e38d9662 |
| report_json_lf_sha256 | 13d56192fc1155a9eb6dd7bd612c8336612136655534b16964fef20560e25f7a |
| recommended_next_ticket | V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FEATURE-SOURCE-RECHECK-01 |

## Boundary

- `artifacts/regime/regime-labels.json` was read only and not mutated.
- The label is scoped to paper-observation source-readiness only.
- No qfa-410b/qfa-611 run or global research/backtest regime authority is created.

## Authority

- No `StrategyFeatureSnapshot` was emitted.
- No `STRAT_EVAL`, `CANDIDATE`, or `ORDER_INTENT` markers were emitted.
- `observation_day_eligible=false` and `observation_day_increment=0` remain locked.
- No paper runtime, broker/live dispatch, Phase 6 authority, or roster mutation occurred.
