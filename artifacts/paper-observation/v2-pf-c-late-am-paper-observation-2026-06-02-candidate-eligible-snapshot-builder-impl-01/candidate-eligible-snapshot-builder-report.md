# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-CANDIDATE-ELIGIBLE-SNAPSHOT-BUILDER-IMPL-01

## Determination

```text
CANDIDATE_ELIGIBLE_SNAPSHOT_BUILDER_IMPL_EMITTED_SOURCE_BACKED_SNAPSHOT
```

## Selected candidate-backed snapshot

| Field | Value |
|---|---|
| feature_snapshot_id | `feature-v2pf-20260602-1780427100000000000` |
| timestamp_utc | `2026-06-02T19:05:00.000000000Z` |
| entry_hour_utc | `19` |
| utc_exclusion_gate_status | `NON_EXCLUDED_BY_UTC_16_18_GATE` |
| context.regime_label | `low` |
| quote.mid_px | `30667.5` |
| context.session_vwap | `30642.6641` |
| indicators.atr14_pts | `9.048` |
| indicators.sigma_pts | `5.1814` |
| context.signed_shock_vwap.value | `2.7449` |
| threshold_comparison_result | `2.7449 >= 2.7` |
| base_predicates_pass_before_utc_gate | `true` |

## Consumer compatibility

| Snapshot field path | Value present | Placeholder used | Source-ready anchor | Consumer status |
|---|---:|---:|---|---|
| `created_ts_ns` | `true` | `false` | PR #310 selected candidate timestamp | `READY` |
| `quote.mid_px` | `true` | `false` | 2026-06-02 MBP1 latest finite bid/ask at or before 19:05Z | `READY` |
| `session.is_rth` | `true` | `false` | PR #303 source window and PR #307 session calendar | `READY` |
| `session.is_halt` | `true` | `false` | PR #307 MNQ session calendar | `READY` |
| `session.is_roll_block` | `true` | `false` | PR #307 MNQ roll calendar and policy | `READY` |
| `indicators.sigma_pts` | `true` | `false` | Recomputed from source-backed closed 1m bars | `READY` |
| `context.regime_label` | `true` | `false` | PR #305 scoped regime-label source | `READY` |
| `context.signed_shock_vwap.value` | `true` | `false` | PR #310 selected candidate point | `READY` |
| `config.config_hash / config.config_version` | `true` | `false` | Variant-owned config lineage | `READY` |

## Guardrails

| Field | Value |
|---|---|
| STRAT_EVAL_count | `0` |
| CANDIDATE_count | `0` |
| ORDER_INTENT_count | `0` |
| observation_day_eligible | `false` |
| observation_day_increment | `0` |
| paper_runtime_invoked | `false` |
| broker_live_authorized | `false` |
| phase_6_authorized | `false` |

## Expected next candidate strat-eval smoke outcome

| Field | Value |
|---|---|
| expected_next_candidate_strat_eval_smoke_outcome | `STRAT_EVAL_AND_CANDIDATE_EXPECTED_ORDER_INTENT_SUPPRESSED` |
| STRAT_EVAL_count_expected | `1` |
| CANDIDATE_count_expected | `1` |
| ORDER_INTENT_count_expected | `0` |
| expectation_reason | The 19:05Z source-backed snapshot is non-excluded and inherited v2 base predicates pass before the UTC gate; the next smoke should prove candidate emission while still suppressing ORDER_INTENT and all execution/observation-day authority. |

## Output hashes

| File | LF SHA-256 |
|---|---|
| bounded-candidate-eligible-feature-snapshot.jsonl | `ecf32b6116263b3778819d29c2f2392153a123aec1daba91520323df353bce22` |
| candidate-eligible-snapshot-builder-report.json | `fb04d8a7f7aa865b2cb09bca31ad7e6d53c5fca53cdc2e214ca4715e0b7a1ed0` |

## Recommended next ticket

```text
V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-CANDIDATE-STRAT-EVAL-SMOKE-01
```

Verify STRAT_EVAL marker generation from the candidate-eligible source-backed snapshot while checking whether CANDIDATE behavior matches the non-excluded 19:05Z base-passing source point; still no observation-day credit unless separately scoped.
