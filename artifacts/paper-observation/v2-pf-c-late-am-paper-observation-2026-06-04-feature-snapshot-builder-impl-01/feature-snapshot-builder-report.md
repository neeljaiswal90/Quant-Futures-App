# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FEATURE-SNAPSHOT-BUILDER-IMPL-01

## Determination

```text
FEATURE_SNAPSHOT_BUILDER_IMPL_EMITTED_SOURCE_BACKED_SNAPSHOT
```

## Source-backed StrategyFeatureSnapshot

| Field | Value |
|---|---|
| feature_snapshot_id | `feature-v2pf-20260604-1780585080000000000` |
| strategy_feature_snapshot_count | `1` |
| target_timestamp_utc | `2026-06-04T14:58:00.000000000Z` |
| target_entry_hour_utc | `14` |
| target_timestamp_variant_gate_status | `NON_EXCLUDED_BY_UTC_16_18_GATE` |
| feature_snapshot_builder_ready_for_candidate_strat_eval_scope | `true` |

## Selected candidate point

| Field | Value |
|---|---|
| timestamp_ns | `1780585080000000000` |
| timestamp_utc | `2026-06-04T14:58:00.000000000Z` |
| entry_hour_utc | `14` |
| utc_exclusion_gate_status | `NON_EXCLUDED_BY_UTC_16_18_GATE` |
| regime_label | `low` |
| quote.mid_px | `30343` |
| session_vwap | `30276.3494` |
| atr14_pts | `22.6538` |
| sigma_pts | `15.8651` |
| signed_shock_vwap | `2.9421` |
| threshold_comparison_result | `2.9421 >= 2.7` |
| base_predicates_pass_before_utc_gate | `true` |

## Consumer compatibility

| Snapshot field path | Value present | Placeholder used | Source-ready anchor | Consumer status |
|---|---:|---:|---|---|
| `created_ts_ns` | `true` | `false` | PR #320 selected candidate timestamp | `READY` |
| `quote.mid_px` | `true` | `false` | PR #320 finite quote_mid_px in bounded local capture source-readiness slot | `READY` |
| `session.is_rth` | `true` | `false` | PR #320 2026-06-04 RTH session source readiness | `READY` |
| `session.is_halt` | `true` | `false` | PR #320 halt calendar readiness | `READY` |
| `session.is_roll_block` | `true` | `false` | PR #320 roll calendar readiness | `READY` |
| `indicators.sigma_pts` | `true` | `false` | PR #320 closed 1m bar/sigma source readiness | `READY` |
| `context.regime_label` | `true` | `false` | PR #320 scoped FRED-backed regime label | `READY` |
| `context.signed_shock_vwap.value` | `true` | `false` | PR #320 signed_shock_vwap candidate source point | `READY` |
| `config.config_hash` | `true` | `false` | Variant-owned strategy config LF SHA-256 | `READY` |
| `config.config_version` | `true` | `false` | Variant-owned strategy config version | `READY` |

## Authority locks

```json
{
  "paper_runtime_invoked": false,
  "STRAT_EVAL": 0,
  "CANDIDATE": 0,
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

## Output hashes

| File | LF SHA-256 |
|---|---|
| bounded-feature-snapshot.jsonl | `501624e2dad8a3dea37cd935b6a77d91ec50f7bcccf1ccc4efb01fc2ceae1f10` |
| feature-snapshot-builder-report.json | `8fe5163347df7f0e4be91e071e5aa90a8d14a8d8bcc54f0e4007d345a49d8501` |
| feature-snapshot-builder-report.md | `faf08477e35dfe544ae8711c1acbb66b14b52f35d90c1f8bf1ace5cb3febe02a` |

## Recommended next ticket

```text
V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-CANDIDATE-STRAT-EVAL-SMOKE-01
```
