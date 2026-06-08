# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FULL-SESSION-SOURCE-SNAPSHOT-WINDOW-REPAIR-01

Determination: `FULL_SESSION_SOURCE_SNAPSHOT_WINDOW_BLOCKED_RAW_CAPTURE_ABSENCE`

## Slot accounting

| Field | Value |
|---|---|
| accounting_slots_expected | `390` |
| source_backed_feature_snapshot_slots_ready | `226` |
| slots_missing_source | `151` |
| warmup_excluded_slots | `13` |
| slots_failed_closed | `0` |
| slots_processed | `390` |
| full_session_snapshot_window_ready_for_runtime_impl | `false` |
| observation_window_start_utc | `2026-06-02T13:30:00.000000000Z` |
| observation_window_end_utc | `2026-06-02T20:00:00.000000000Z` |
| snapshot_cadence_basis | `one closed 1m accounting slot` |

## Missing range

| Field | Value |
|---|---|
| missing_source_slot_count | `151` |
| first_missing_source_slot_utc | `2026-06-02T13:32:00.000000000Z` |
| last_missing_source_slot_utc | `2026-06-02T16:02:00.000000000Z` |
| missing_reason_counts | `[object Object]` |
| required_prior_blocker_first_missing_source_slot_utc | `2026-06-02T13:32:00.000000000Z` |
| required_prior_blocker_last_missing_source_slot_utc | `2026-06-02T16:02:00.000000000Z` |
| prior_blocker_reproduced | `true` |

## Source diagnosis

| Field | Value |
|---|---|
| raw_capture_path | `D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02/MNQ_rth.jsonl` |
| normalized_obs_path | `D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02/MNQ_rth.obs01.jsonl` |
| mbp1_path | `D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02/MNQ_rth.mbp1.jsonl` |
| raw_records_total | `9757140` |
| raw_records_in_observation_window | `9409772` |
| raw_capture_slots_present | `239` |
| raw_capture_slots_absent | `151` |
| normalized_trade_records_total | `518356` |
| normalized_trade_records_in_observation_window | `497219` |
| normalized_trade_bar_slots_present | `239` |
| normalized_trade_bar_slots_absent | `151` |
| quote_records_total | `371656` |
| finite_quote_records_total | `299806` |
| quote_records_with_null_mid | `0` |
| quote_slots_with_records | `239` |
| quote_mid_ready_slots | `390` |
| first_raw_capture_ts_utc | `2026-06-02T13:30:00.000095000Z` |
| last_raw_capture_ts_utc | `2026-06-02T19:59:59.999772655Z` |
| first_normalized_trade_ts_utc | `2026-06-02T13:30:00.000999143Z` |
| last_normalized_trade_ts_utc | `2026-06-02T19:59:59.998202839Z` |
| first_quote_ts_utc | `2026-06-02T13:30:00.000095000Z` |
| last_quote_ts_utc | `2026-06-02T20:00:59.769286000Z` |
| root_blocker_family | `raw capture absence for missing slot range` |
| artifact_windowing_bug_detected | `false` |
| script_selection_bug_detected | `false` |

## Authority locks

| Field | Value |
|---|---|
| paper_runtime_invoked | `false` |
| STRAT_EVAL | `0` |
| CANDIDATE | `0` |
| ORDER_INTENT | `0` |
| observation_day_eligible | `false` |
| observation_day_increment | `0` |
| qfa_410b_or_qfa_611_run | `false` |
| broker_live_authorized | `false` |
| phase_6_authorized | `false` |
| active_candidate_roster_mutated | `false` |
| strategy_config_mutated | `false` |
| management_config_mutated | `false` |
| global_regime_labels_mutated | `false` |
| StrategyFeatureSnapshot_materialized | `false` |

## Output hashes

| Artifact | LF SHA-256 |
|---|---|
| bounded_full_session_source_snapshot_window_repair_jsonl | `b09ad09845193952ed63f63b4457cf8c484d74ca23c3e71a6dcd6120fa801a18` |
| full_session_source_snapshot_window_repair_report_json | `263b894b8f20a8ba3a78ea054070e64c3112854c8185b5a97b522a1f1fdeac6f` |
| full_session_source_snapshot_window_repair_report_md | `32c8e09a7ada378c069f3f83b42a37c3d7af2fde34cc7792ed5a09685ca3f29f` |

Recommended next ticket: `V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-RTH-RAW-CAPTURE-SOURCE-BACKFILL-01`
