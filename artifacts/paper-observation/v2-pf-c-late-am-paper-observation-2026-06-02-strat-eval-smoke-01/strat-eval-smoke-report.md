# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-STRAT-EVAL-SMOKE-01

## Determination

`STRAT_EVAL_SMOKE_PARTIAL_PASS_BASE_REJECTION_PRECEDES_UTC_GATE`

| Outcome field | Value |
|---|---|
| strat_eval_plumbing_status | `PASSED` |
| candidate_gate_proof_status | `BLOCKED_BY_BASE_REJECTION` |

## Counts

| Field | Value |
|---|---:|
| STRAT_EVAL_count | `1` |
| CANDIDATE_count | `0` |
| ORDER_INTENT_count | `0` |

## Candidate suppression

| Field | Value |
|---|---|
| target_timestamp_variant_gate_status | `EXCLUDED_BY_UTC_16_18_GATE` |
| expected_suppression_reason | `EXCLUDED_BY_UTC_16_18_GATE` |
| actual_candidate_suppression_reason | `BASE_STRATEGY_REJECTION_PRECEDES_UTC_GATE:regime_shock_reversion_short_v2_utc_16_18_exclusion:low_regime_shock_below_strict_pos_threshold` |

## Interpretation

The narrow strategy generator emitted STRAT_EVAL, so evaluation plumbing passed. The inherited v2 strategy rejected the snapshot before the variant UTC gate could suppress a candidate, so candidate/UTC gate suppression remains unproven for the PR #308 snapshot.

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

## Guardrails

| Guardrail | Value |
|---|---|
| active_roster_mutated | `false` |
| broker_live_authorized | `false` |
| candidate_roster_mutated | `false` |
| full_paper_observation_invoked | `false` |
| global_regime_labels_mutated | `false` |
| management_config_mutated | `false` |
| observation_day_eligible | `false` |
| observation_day_increment | `0` |
| order_intent_emitted | `false` |
| paper_config_mutated | `false` |
| paper_fill_emitted | `false` |
| paper_runtime_invoked | `false` |
| phase_6_authorized | `false` |
| qfa_410b_run | `false` |
| qfa_611_run | `false` |
| strategy_config_mutated | `false` |

## Recommended next ticket

`V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-CANDIDATE-ELIGIBLE-NON-EXCLUDED-SNAPSHOT-SOURCE-SCOPE-01`

This smoke proves STRAT_EVAL plumbing, but the PR #308 snapshot is both inside the UTC 16-18 exclusion window and rejected by inherited v2 signal thresholds before the UTC gate. The next source scope should identify or build a causal source-backed snapshot that is candidate-eligible and outside the exclusion window. Candidate-eligible means inherited v2 base predicates pass before the UTC exclusion gate is evaluated.
