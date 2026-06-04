# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-STRAT-EVAL-SMOKE-01 memo

## Purpose

Smoke the PR #308 source-backed StrategyFeatureSnapshot through the narrow current strategy generator for `regime_shock_reversion_short_v2_utc_16_18_exclusion`.

## Determination

`STRAT_EVAL_SMOKE_PARTIAL_PASS_BASE_REJECTION_PRECEDES_UTC_GATE`

| Outcome field | Value |
|---|---|
| strat_eval_plumbing_status | `PASSED` |
| candidate_gate_proof_status | `BLOCKED_BY_BASE_REJECTION` |

The smoke emitted a strategy-evaluation marker, so strategy-evaluation plumbing works. It did not reach the UTC gate as the candidate suppression reason. The inherited v2 strategy rejected the snapshot first, so claiming `EXCLUDED_BY_UTC_16_18_GATE` as the candidate suppression reason would overstate the current path.

## Evidence

| Field | Value |
|---|---|
| feature_snapshot_id | `feature-v2pf-20260602-1780423199835478000` |
| strategy_id | `regime_shock_reversion_short_v2_utc_16_18_exclusion` |
| target_timestamp_ns | `1780423199835478000` |
| target_entry_hour_utc | `17` |
| target_timestamp_variant_gate_status | `EXCLUDED_BY_UTC_16_18_GATE` |
| STRAT_EVAL_count | `1` |
| CANDIDATE_count | `0` |
| ORDER_INTENT_count | `0` |
| candidate_suppression_reason | `BASE_STRATEGY_REJECTION_PRECEDES_UTC_GATE:regime_shock_reversion_short_v2_utc_16_18_exclusion:low_regime_shock_below_strict_pos_threshold` |

## Rejection threshold provenance

| Field | Value |
|---|---|
| strategy_source_path | `apps/strategy_runtime/src/strategies/regime_shock_reversion_short_v2.ts` |
| symbol_or_function | `firstRegimeShockReversionShortV2Rejection(...)` |
| threshold_name | `parameters.low_shock_threshold_pos` |
| threshold_value | `2.7` |
| snapshot_value_compared | `-1.7986` |
| comparison_result | `-1.7986 < 2.7; inherited v2 base predicate rejects before candidate construction` |
| why_rejection_precedes_utc_gate | generateRegimeShockReversionShortV2Utc1618Exclusion(...) calls generateRegimeShockReversionShortV2WithParameters(...) first and only checks the UTC 16-18 exclusion after inherited.candidate exists. |

## Authority boundary

No full paper observation, broker/live dispatch, order intent, paper fill, qfa-410b, qfa-611, Phase 6, active roster, candidate roster, strategy config, management config, paper config, broker/live config, global regime label mutation, or observation-day credit was created.

## Recommended next ticket

`V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-CANDIDATE-ELIGIBLE-NON-EXCLUDED-SNAPSHOT-SOURCE-SCOPE-01`

This smoke proves STRAT_EVAL plumbing, but the PR #308 snapshot is both inside the UTC 16-18 exclusion window and rejected by inherited v2 signal thresholds before the UTC gate. The next source scope should identify or build a causal source-backed snapshot that is candidate-eligible and outside the exclusion window. Candidate-eligible means inherited v2 base predicates pass before the UTC exclusion gate is evaluated.
