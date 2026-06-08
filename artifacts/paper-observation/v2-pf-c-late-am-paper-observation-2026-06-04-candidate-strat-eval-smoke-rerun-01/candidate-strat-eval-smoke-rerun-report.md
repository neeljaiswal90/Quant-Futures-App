# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-CANDIDATE-STRAT-EVAL-SMOKE-RERUN-01

## Determination

```text
CANDIDATE_STRAT_EVAL_SMOKE_RERUN_PASSED_CANDIDATE_EMITTED_ORDER_INTENT_SUPPRESSED
```

## Counts

| Field | Value |
|---|---:|
| STRAT_EVAL_count | `1` |
| CANDIDATE_count | `1` |
| ORDER_INTENT_count | `0` |

## Candidate payload

| Field | Value |
|---|---|
| candidate_strategy_id | `regime_shock_reversion_short_v2_utc_16_18_exclusion` |
| candidate_timestamp_utc | `2026-06-04T14:58:00.000000000Z` |
| candidate_entry_hour_utc | `14` |
| candidate_signed_shock_vwap | `2.9421` |
| candidate_threshold_comparison | `2.9421 >= 2.7` |
| candidate_utc_gate_status | `NON_EXCLUDED_BY_UTC_16_18_GATE` |
| candidate_emission_reason | `BASE_PREDICATES_PASS_AND_NON_EXCLUDED_BY_UTC_GATE` |
| candidate_id | `candidate-feature-v2pf-20260604-1780585080000000000-regime_shock_reversion_short_v2_utc_16_18_exclusion` |
| direction | `short` |
| entry_price | `30343` |
| stop_price | `30355.75` |
| risk_points | `12.75` |

## Order-intent suppression

```text
paper_runtime_invoked = false
order_translation_invoked = false
order_adapter_invoked = false
broker_adapter_invoked = false
candidate_persisted = false
order_intent_suppression_reason = NARROW_STRAT_EVAL_SMOKE_NO_ORDER_TRANSLATION
```

## Authority locks

```json
{
  "paper_runtime_invoked": false,
  "order_translation_invoked": false,
  "order_adapter_invoked": false,
  "broker_adapter_invoked": false,
  "candidate_persisted": false,
  "STRAT_EVAL": 1,
  "CANDIDATE": 1,
  "ORDER_INTENT": 0,
  "observation_day_eligible": false,
  "observation_day_increment": 0,
  "qfa_410b_or_qfa_611_run": false,
  "broker_live_authorized": false,
  "phase_6_authorized": false,
  "active_candidate_roster_mutated": false,
  "global_regime_labels_mutated": false
}
```

## Recommended next ticket

```text
V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-PAPER-RUNTIME-CANDIDATE-SMOKE-SCOPE-01
```
