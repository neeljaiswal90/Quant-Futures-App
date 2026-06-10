# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-CANDIDATE-STRAT-EVAL-SMOKE-01 memo

## Summary

```text
CANDIDATE_STRAT_EVAL_SMOKE_BLOCKED_SNAPSHOT_CONSUMER_COMPATIBILITY_GAP
```

This smoke loads the PR #321 source-backed 2026-06-04 StrategyFeatureSnapshot and runs only the narrow strategy generator for `regime_shock_reversion_short_v2_utc_16_18_exclusion`. It proves `STRAT_EVAL = 1` and `CANDIDATE = 1` for the non-excluded 14:58Z point while keeping `ORDER_INTENT = 0`.

## Candidate payload summary

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

`ORDER_INTENT = 0` is caused by the intentionally narrow smoke scope: order translation, order adapter, broker adapter, paper runtime, and candidate persistence are not invoked. It is not evidence for or against a candidate-to-order path.

## Consumer compatibility gap

```json
{
  "missing_snapshot_field_path": "instrument.tick_size",
  "observed_error": "Cannot read properties of undefined (reading 'tick_size')",
  "required_expression": "snapshot.instrument.tick_size",
  "strategy_source_path": "apps/strategy_runtime/src/strategies/regime_shock_reversion_short_v2.ts",
  "symbol_or_function": "generateRegimeShockReversionShortV2WithParameters(...)"
}
```

```json
{
  "active_roster_mutated": false,
  "broker_live_authorized": false,
  "broker_adapter_invoked": false,
  "candidate_persisted": false,
  "candidate_roster_mutated": false,
  "full_paper_observation_invoked": false,
  "global_regime_labels_mutated": false,
  "management_config_mutated": false,
  "observation_day_eligible": false,
  "observation_day_increment": 0,
  "order_adapter_invoked": false,
  "order_intent_emitted": false,
  "order_translation_invoked": false,
  "paper_config_mutated": false,
  "paper_fill_emitted": false,
  "paper_runtime_invoked": false,
  "phase_6_authorized": false,
  "qfa_410b_run": false,
  "qfa_611_run": false,
  "strategy_config_mutated": false
}
```

## Recommended next ticket

```text
V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FEATURE-SNAPSHOT-BUILDER-COMPAT-REPAIR-01
```
