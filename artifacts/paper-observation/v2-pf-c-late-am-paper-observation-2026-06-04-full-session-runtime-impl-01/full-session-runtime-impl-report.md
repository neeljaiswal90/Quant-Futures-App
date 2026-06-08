# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FULL-SESSION-RUNTIME-IMPL-01

Determination: `FULL_SESSION_RUNTIME_IMPL_PASSED_CANDIDATE_ONLY_GUARD`

## Slot accounting

| Field | Value |
|---|---|
| accounting_slots_expected | `390` |
| source_ready_slots | `390` |
| source_backed_snapshots_emitted | `377` |
| snapshots_ingested | `377` |
| slots_processed | `390` |
| slots_missing_source | `0` |
| slots_failed_closed | `0` |
| warmup_excluded_slots | `13` |
| skipped_slots | `0` |
| first_slot_utc | `2026-06-04T13:30:00.000000000Z` |
| last_slot_utc | `2026-06-04T19:59:00.000000000Z` |
| observation_window_start_utc | `2026-06-04T13:30:00.000000000Z` |
| observation_window_end_utc | `2026-06-04T20:00:00.000000000Z` |
| slot_cadence | `1m_closed_bar_accounting_slot` |

## Runtime marker counts

| Marker | Count |
|---|---:|
| SESSION_MANIFEST | 2 |
| FEATURE_SNAPSHOT_INGEST | 377 |
| STRAT_EVAL | 377 |
| CANDIDATE | 182 |
| RANK | 0 |
| SIZING | 0 |
| RISK_GATE | 0 |
| ORDER_INTENT | 0 |
| SIM_FILL | 0 |
| EXEC_REJECT | 0 |
| POSITION | 0 |

## Authority locks

| Field | Value |
|---|---|
| observation_day_eligible | `false` |
| observation_day_increment | `0` |
| paper_runtime_invoked | `true` |
| full_session_runtime_harness_invoked | `true` |
| paper_observation_stop_after_candidate | `true` |
| order_translation_invoked | `false` |
| order_adapter_call_count | `0` |
| broker_adapter_call_count | `0` |
| paper_fill_count | `0` |
| qfa_410b_or_qfa_611_run | `false` |
| ACTIVE_STRATEGY_IDS_mutated | `false` |
| CANDIDATE_STRATEGY_IDS_mutated | `false` |
| broker_live_authorized | `false` |
| phase_6_authorized | `false` |

## Boundary result

`STRAT_EVAL` and `CANDIDATE` were allowed through the bounded paper-runtime harness for source-backed ingested slots. `ORDER_INTENT`, ranking, sizing, risk, fills, positions, adapters, broker/live, Phase 6, and observation-day credit remained suppressed.

## Output hashes

| Artifact | LF SHA-256 |
|---|---|
| bounded_full_session_runtime_impl_jsonl | `8e89086f7b37208012c1149ce514e1370f6be6525736a6f4eae08ee28ff42b69` |
| full_session_runtime_impl_report_json | `c921ebb8c7d9847bc842584790864821b6b1ac71ec4db4f728c9a97494b114af` |
| full_session_runtime_impl_report_md | `c1c26881a8fb8d42164bb5bf586b731f83d30b1ac1c8baa5678efcd5d82d7b57` |

Recommended next ticket: `V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-OBSERVATION-DAY-ACCOUNTING-SCOPE-01`
