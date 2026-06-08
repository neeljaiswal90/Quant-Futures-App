# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-CANDIDATE-STRAT-EVAL-SMOKE-RERUN-01 memo

## Summary

```text
CANDIDATE_STRAT_EVAL_SMOKE_RERUN_PASSED_CANDIDATE_EMITTED_ORDER_INTENT_SUPPRESSED
```

This rerun loads the PR #322 instrument-compatible source-backed snapshot and runs only the narrow strategy generator for `regime_shock_reversion_short_v2_utc_16_18_exclusion`. It proves `STRAT_EVAL = 1` and `CANDIDATE = 1` for the non-excluded 14:58Z point while keeping `ORDER_INTENT = 0`.

## Candidate payload

```json
{
  "candidate_emission_reason": "BASE_PREDICATES_PASS_AND_NON_EXCLUDED_BY_UTC_GATE",
  "candidate_entry_hour_utc": 14,
  "candidate_regime_label": "low",
  "candidate_signed_shock_vwap": 2.9421,
  "candidate_strategy_id": "regime_shock_reversion_short_v2_utc_16_18_exclusion",
  "candidate_threshold_comparison": "2.9421 >= 2.7",
  "candidate_threshold_name": "parameters.low_shock_threshold_pos",
  "candidate_threshold_value": 2.7,
  "candidate_timestamp_ns": "1780585080000000000",
  "candidate_timestamp_utc": "2026-06-04T14:58:00.000000000Z",
  "candidate_utc_gate_status": "NON_EXCLUDED_BY_UTC_16_18_GATE"
}
```

## Authority boundary

`ORDER_INTENT = 0` is caused by the intentionally narrow smoke scope: order translation, order adapter, broker adapter, paper runtime, and candidate persistence are not invoked.

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
