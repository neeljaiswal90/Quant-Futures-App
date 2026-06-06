# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-PAPER-RUNTIME-CANDIDATE-SMOKE-IMPL-01

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

## Guard boundary

| Field | Value |
|---|---|
| guard_insertion_repo_path | `apps/strategy_runtime/src/orchestration/runner.ts` |
| guard_insertion_symbol_or_function | `StrategyRuntimeRunner.processFeatureSnapshot(...) ranked candidate loop` |
| stop_before_symbol_or_function | `rankCandidates(...) and createEntryOrderIntent(...)` |
| allowed_marker_before_stop | `CANDIDATE` |
| disallowed_marker_after_stop | `ORDER_INTENT` |
| paper_observation_stop_after_candidate | `true` |

## Guardrail proof status

| Proof | Status |
|---|---|
| non_paper_runtime_with_stop_after_candidate_rejected | `true` |
| stop_after_candidate_without_explicit_strategy_ids_rejected | `true` |
| default_runtime_behavior_unchanged | `true` |
| normal_candidate_pipeline_without_guard_still_reaches_rank_or_order_boundary_in_test | `true` |

## Candidate payload summary

| Field | Value |
|---|---|
| candidate_strategy_id | `regime_shock_reversion_short_v2_utc_16_18_exclusion` |
| candidate_timestamp_utc | `2026-06-02T19:05:00.000000000Z` |
| candidate_entry_hour_utc | `19` |
| candidate_utc_gate_status | `NON_EXCLUDED_BY_UTC_16_18_GATE` |
| candidate_signed_shock_vwap | `2.7449` |
| candidate_threshold_comparison | `2.7449 >= 2.7` |

## Authority locks

No order translation, order adapter, broker adapter, paper fill, qfa-410b/qfa-611, roster/config mutation, Phase 6 authority, or observation-day credit is created by this smoke.

## Determinism and TypeScript caveat

| Field | Value |
|---|---|
| final_phase2_hash | `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b` |
| final_phase4_hash | `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090` |
| drift_classification | `NO_DETERMINISM_DRIFT` |
| npx tsc -b tsconfig.json | `not a clean signal in this worktree because full-project dependency resolution hits existing operator-console / repo-split diagnostics outside touched files` |
| targeted touched-file/script TypeScript check | `fail` |
| targeted check note | `No touched-file/script errors remain; residual targeted errors are existing shared config/transport diagnostics outside touched files.` |

## Output hashes

| Artifact | LF SHA-256 |
|---|---|
| bounded JSONL | `c17238253fef8cdc0bfe800946123de3697bf79e6ff804d462762503baec5a4b` |
| report JSON | `c443e34f3c724e2b4ec962e4f05f77b5ed7ddc6f0591622d9ae888888801b52f` |

Recommended next ticket: `V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-PAPER-RUNTIME-OBSERVATION-DAY-SCOPE-01`
