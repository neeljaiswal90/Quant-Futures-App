# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-PAPER-RUNTIME-CANDIDATE-SMOKE-IMPL-01

Determination: `PAPER_RUNTIME_CANDIDATE_SMOKE_IMPL_PASSED_CANDIDATE_EMITTED_ORDER_INTENT_SUPPRESSED`

## Runtime counts

| Marker | Count |
|---|---:|
| STRAT_EVAL | 1 |
| CANDIDATE | 1 |
| RANK | 0 |
| SIZING | 0 |
| RISK_GATE | 0 |
| ORDER_INTENT | 0 |
| SIM_FILL | 0 |
| POSITION | 0 |

## Candidate payload summary

| Field | Value |
|---|---|
| candidate_strategy_id | `regime_shock_reversion_short_v2_utc_16_18_exclusion` |
| candidate_timestamp_utc | `2026-06-04T14:58:00.000000000Z` |
| candidate_entry_hour_utc | `14` |
| candidate_utc_gate_status | `NON_EXCLUDED_BY_UTC_16_18_GATE` |
| candidate_signed_shock_vwap | `2.9421` |
| candidate_threshold_comparison | `2.9421 >= 2.7` |

## Guard boundary

| Field | Value |
|---|---|
| guard_insertion_repo_path | `apps/strategy_runtime/src/orchestration/runner.ts` |
| guard_insertion_symbol_or_function | `StrategyRuntimeRunner.processFeatureSnapshot(...) ranked candidate loop` |
| stop_before_symbol_or_function | `rankCandidates(...) and createEntryOrderIntent(...)` |
| allowed_marker_before_stop | `CANDIDATE` |
| disallowed_marker_after_stop | `ORDER_INTENT` |
| paper_observation_stop_after_candidate | `true` |

## Guardrail proofs

| Proof | Status |
|---|---|
| non_paper_runtime_with_stop_after_candidate_rejected | `true` |
| stop_after_candidate_without_explicit_strategy_ids_rejected | `true` |
| default_runtime_behavior_unchanged | `true` |
| normal_candidate_pipeline_without_guard_still_reaches_rank_or_order_boundary_in_test | `true` |

## Authority locks

No order translation, order adapter, broker adapter, paper fill, qfa-410b/qfa-611, roster/config mutation, Phase 6 authority, or observation-day credit is created by this smoke.

## Determinism caveat

`npx tsx scripts/backtester/check-determinism.mts` was blocked by worktree dependency resolution: `Cannot find module parquetjs-lite`. Drift classification is `DETERMINISM_CHECK_BLOCKED_WORKTREE_DEPENDENCY_RESOLUTION`.

## Output hashes

| Artifact | LF SHA-256 |
|---|---|
| bounded JSONL | `04b88b4f714f56701bf150c383c54f36426e475789d75b4f641963faa7365647` |
| report JSON | `098fb6d8e5e9a9da450bd43b6653dbf51bf74560218207c83430998a12ad44c2` |

Recommended next ticket: `V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-PAPER-RUNTIME-OBSERVATION-DAY-SCOPE-01`
