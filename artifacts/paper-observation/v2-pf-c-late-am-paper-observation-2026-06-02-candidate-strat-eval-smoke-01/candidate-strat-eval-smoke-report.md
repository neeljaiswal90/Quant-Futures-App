# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-CANDIDATE-STRAT-EVAL-SMOKE-01

## Determination

```text
CANDIDATE_STRAT_EVAL_SMOKE_PASSED_CANDIDATE_EMITTED_ORDER_INTENT_SUPPRESSED
```

## Counts

| Field | Value |
|---|---:|
| STRAT_EVAL_count | `1` |
| CANDIDATE_count | `1` |
| ORDER_INTENT_count | `0` |

## Candidate summary

| Field | Value |
|---|---|
| candidate_strategy_id | `regime_shock_reversion_short_v2_utc_16_18_exclusion` |
| candidate_timestamp_ns | `1780427100000000000` |
| candidate_timestamp_utc | `2026-06-02T19:05:00.000000000Z` |
| candidate_entry_hour_utc | `19` |
| candidate_regime_label | `low` |
| candidate_signed_shock_vwap | `2.7449` |
| candidate_threshold_name | `parameters.low_shock_threshold_pos` |
| candidate_threshold_value | `2.7` |
| candidate_threshold_comparison | `2.7449 >= 2.7` |
| candidate_utc_gate_status | `NON_EXCLUDED_BY_UTC_16_18_GATE` |
| candidate_emission_reason | `BASE_PREDICATES_PASS_AND_NON_EXCLUDED_BY_UTC_GATE` |
| candidate_id | `candidate-feature-v2pf-20260602-1780427100000000000-regime_shock_reversion_short_v2_utc_16_18_exclusion` |
| direction | `short` |
| entry_price | `30667.5` |
| stop_price | `30671.75` |
| risk_points | `4.25` |
| confidence | `0.58` |
| first_reason | `regime_shock_reversion_short_v2_utc_16_18_exclusion:armed` |

## Source and gate

| Field | Value |
|---|---|
| feature_snapshot_id | `feature-v2pf-20260602-1780427100000000000` |
| target_timestamp_utc | `2026-06-02T19:05:00.000000000Z` |
| target_entry_hour_utc | `19` |
| target_timestamp_variant_gate_status | `NON_EXCLUDED_BY_UTC_16_18_GATE` |
| signed_shock_vwap | `2.7449` |
| low_shock_threshold_pos | `2.7` |
| threshold_comparison_result | `2.7449 >= 2.7` |
| order_intent_suppression_reason | `NARROW_STRAT_EVAL_SMOKE_NO_ORDER_TRANSLATION` |

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

```text
V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-PAPER-RUNTIME-CANDIDATE-SMOKE-SCOPE-01
```

Scope whether the candidate-emitting source-backed snapshot can enter the dedicated paper-runtime path without broker/live authority, and define what must remain suppressed before any observation-day accounting can be considered.
