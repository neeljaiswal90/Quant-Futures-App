# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FULL-SESSION-RUNTIME-SCOPE-01

Determination: `FULL_SESSION_RUNTIME_SCOPE_READY_FOR_IMPL`

## Scope decision

This ticket scopes the minimum bounded 2026-06-04 full-session/window paper-runtime evidence contract. It does not run the full session and does not authorize observation-day credit.

## Window contract

| Field | Value |
|---|---|
| observation_window_start_utc | `2026-06-04T13:30:00.000000000Z` |
| observation_window_end_utc | `2026-06-04T20:00:00.000000000Z` |
| window_basis | `2026-06-04-rth` |
| accounting_slots_expected | `390` |
| source_ready_slots_required | `390` |
| warmup_excluded_slots_expected | `13` |
| feature_computable_slots_required | `377` |
| expected_snapshot_count_formula | `390 accounting slots - 13 warmup-excluded slots = 377 source-backed feature-computable snapshots` |
| full_session_claim_valid | `true` |

## Runtime marker requirements

| Marker/class | Requirement |
|---|---|
| SESSION_MANIFEST | required |
| FEATURE_SNAPSHOT_INGEST or equivalent | required |
| STRAT_EVAL | required |
| CANDIDATE | allowed/expected when predicates pass |
| ORDER_INTENT | must remain `0` |
| RANK / SIZING / RISK_GATE | must remain `0` with stop-after-candidate guard active |
| SIM_FILL / POSITION | must remain `0` |

## Source stack

| Field | Value |
|---|---|
| source_ready_slots | `390` |
| feature_computable_slots | `377` |
| warmup_excluded_slots | `13` |
| candidate_eligible_non_excluded_points | `183` |
| candidate point | `2026-06-04T14:58:00.000000000Z` |
| candidate signed_shock_vwap | `2.9421` |

## Authority locks

Observation-day eligibility remains `false` and increment remains `0`. No ORDER_INTENT, order translation, adapter, broker, fill, qfa-410b/qfa-611, roster, broker/live, or Phase 6 authority is created.

## Output hashes

| Artifact | LF SHA-256 |
|---|---|
| bounded JSONL | `c74b61c1b9f408b3e2c42b92f2c9d0f07a2d0811009951a0189e5c76a2f126ee` |
| report JSON | `78752d28dfd24d811c5373a3fa0b219eef5cf72f5cb2f8f76d01fc7c8a4a2e13` |

Recommended next ticket: `V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FULL-SESSION-RUNTIME-IMPL-01`
