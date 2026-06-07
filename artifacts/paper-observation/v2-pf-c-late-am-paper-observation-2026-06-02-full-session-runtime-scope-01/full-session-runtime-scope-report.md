# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FULL-SESSION-RUNTIME-SCOPE-01

Determination: `FULL_SESSION_RUNTIME_SCOPE_READY_FOR_IMPL`

## Scope decision

This ticket scopes the minimum bounded full-session/window paper-runtime evidence contract. It does not run the full session and does not authorize observation-day credit.

| Field | Value |
|---|---|
| candidate-only smoke sufficient for day credit | `false` |
| implementation authorized by this ticket | `false` |
| observation_day_eligible | `false` |
| observation_day_increment | `0` |
| order intent authorized | `false` |

## Prior anchors

| Anchor | Result |
|---|---|
| PR #314 | `STRAT_EVAL=1`, `CANDIDATE=1`, `ORDER_INTENT=0`, `paper_observation_stop_after_candidate=true` |
| PR #315 | `OBSERVATION_DAY_SCOPE_BLOCKED_REQUIRES_FULL_SESSION_RUNTIME`, candidate-only day credit rejected |

## Window contract

| Field | Value |
|---|---|
| observation_window_start_utc | `2026-06-02T13:30:00.000000000Z` |
| observation_window_end_utc | `2026-06-02T20:00:00.000000000Z` |
| window_basis | `2026-06-02-rth` |
| snapshot_cadence_basis | `one closed 1m accounting slot from 13:30:00Z inclusive to 20:00:00Z exclusive` |
| rth_window_minutes | `390` |
| warmup_exclusion_count | `implementation_must_compute_and_report_explicitly` |
| expected_snapshot_count_formula | `(20:00:00Z - 13:30:00Z) / 1 minute = 390 full-session accounting slots before any explicitly reported warmup/source-gap exclusions` |
| full_session_accounting_slot_count_required | `390` |
| PR #310 diagnostic bar_points_scanned | `245` |
| PR #310 diagnostic count is full-session requirement | `false` |
| full_session_claim_valid | `true` |
| observed_source_window_first_ts_utc | `2026-06-02T13:30:00.000095000Z` |
| observed_source_window_last_ts_utc | `2026-06-02T20:05:00.550603543Z` |
| source_backed_feature_snapshot_count_required | `390` |
| snapshot_spacing_or_event_basis | `closed_1m_bar_event_basis_with_finite_quote_session_vwap_atr14_sigma_regime_halt_roll_config_lineage` |
| paper_runtime_entrypoint_or_harness | `PaperTradingSession.processFeatureSnapshot(...) loop over bounded source-backed snapshots, or a dedicated script harness that constructs StrategyRuntimeRunner with the same paper-only guard contract` |
| strategy_id | `regime_shock_reversion_short_v2_utc_16_18_exclusion` |
| paper_observation_explicit_strategy_ids required | `true` |
| paper_observation_stop_after_candidate required | `true` |

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

## Guard behavior

| Field | Value |
|---|---|
| primary_guard_repo_path | `apps/strategy_runtime/src/orchestration/runner.ts` |
| primary_guard_symbol_or_function | `StrategyRuntimeRunner.processFeatureSnapshot(...)` |
| paper_session_entry_repo_path | `apps/strategy_runtime/src/paper-trading/paper-trading-runner.ts` |
| paper_session_entry_symbol_or_function | `PaperTradingSession.processFeatureSnapshot(...)` |
| stop_before | `rankCandidates(...), sizing/risk, createEntryOrderIntent(...), order adapter, broker adapter, fill handling` |

## Source stack

| Field | Value |
|---|---|
| source-backed feature snapshot path exists | `true` |
| candidate-eligible non-excluded point exists | `true` |
| candidate point | `2026-06-02T19:05:00.000000000Z` |
| candidate signed_shock_vwap | `2.7449` |
| session_vwap / ATR14 / signed_shock / regime / halt-roll | `READY` |

## Source anchors

| PR | Label | LF SHA-256 |
|---:|---|---|
| 303 | `source_readiness_2026_06_02` | `446138e94cc66a96f83dab555bace5ec57e91f0461a8621f881f30f237ea5a39` |
| 305 | `scoped_regime_label_source_acquire` | `13d56192fc1155a9eb6dd7bd612c8336612136655534b16964fef20560e25f7a` |
| 307 | `halt_roll_calendar_source_extend` | `d21e93f80518da7215b6f066a9fbd41b45047f48b9b46b2addf106b8da97ab7f` |
| 310 | `candidate_eligible_non_excluded_source_scope` | `4e5f8b98a1fe57e9a90410dffc22448007722c1dee803b940b18e05a3a154ed4` |
| 311 | `candidate_eligible_snapshot_builder_impl` | `5984e170f795f5c96309407bd262c473d6e59f347145d8ef8284d82bf9350784` |
| 314 | `paper_runtime_candidate_smoke_impl` | `c443e34f3c724e2b4ec962e4f05f77b5ed7ddc6f0591622d9ae888888801b52f` |
| 315 | `paper_runtime_observation_day_scope` | `bce140ece37f237d561f2d37289f85f703d91645250b44d3bdddf4e3fe33500d` |

## Output hashes

| Artifact | LF SHA-256 |
|---|---|
| bounded JSONL | `5899646431f908e7e5b78fdf97323869ad2817865359f76e8fff81a33c260e4f` |
| report JSON | `afab7b4fa1367e63ec4bf9797f4890cf9e91a561f941bb706152c58775820c1c` |

Recommended next ticket: `V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FULL-SESSION-RUNTIME-IMPL-01`
