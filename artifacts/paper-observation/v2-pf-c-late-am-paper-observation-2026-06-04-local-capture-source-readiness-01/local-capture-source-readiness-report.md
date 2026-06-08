# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-LOCAL-CAPTURE-SOURCE-READINESS-01

Determination: `LOCAL_CAPTURE_SOURCE_READINESS_READY_FOR_FEATURE_SNAPSHOT_BUILDER`

## Source readiness

| Field | Value |
|---|---|
| target_session_id | `2026-06-04-rth` |
| source_file | `D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-03/MNQ_globex.obs01.jsonl` |
| source_file_role | `continuous_globex_capture_containing_2026-06-04_rth` |
| observation_window_start_utc | `2026-06-04T13:30:00.000000000Z` |
| observation_window_end_utc | `2026-06-04T20:00:00.000000000Z` |
| window_basis | `RTH` |
| accounting_slots_expected | `390` |
| snapshot_cadence_basis | `one closed 1m accounting slot` |
| rth_trade_records | `1468963` |
| rth_trade_slots_present | `390` |
| rth_trade_slots_missing | `0` |
| first_rth_record_utc | `2026-06-04T13:30:00.000044389Z` |
| last_rth_record_utc | `2026-06-04T19:59:59.999888867Z` |
| raw_or_normalized_trade_source_ready | `true` |
| quote_mid_ready | `true` |
| closed_1m_bar_ready | `true` |
| session_vwap_ready | `true` |
| atr14_ready | `true` |
| atr14_ready_slots | `377` |
| sigma_pts_ready | `true` |
| signed_shock_vwap_ready | `true` |
| signed_shock_vwap_ready_slots | `377` |
| feature_computable_slots | `377` |
| warmup_excluded_slots | `13` |
| VIXCLS_prior_close_ready | `true` |
| VXNCLS_prior_close_ready | `true` |
| scoped_regime_label_ready | `true` |
| session_is_rth_ready | `true` |
| session_is_halt_ready | `true` |
| session_is_roll_block_ready | `true` |
| source_ready_slots | `390` |
| ready_for_feature_snapshot_builder | `true` |
| quote_source_records_scanned_in_window | `93577` |
| finite_quote_records_scanned_in_window | `93577` |

## Candidate feasibility

| Field | Value |
|---|---|
| candidate_eligible_points | `303` |
| candidate_eligible_non_excluded_points | `183` |
| candidate_eligible_excluded_points | `120` |
| best_or_first_candidate_eligible_non_excluded_timestamp_utc | `2026-06-04T14:58:00.000000000Z` |
| timestamp_ns | `1780585080000000000` |
| entry_hour_utc | `14` |
| regime_label | `low` |
| signed_shock_vwap | `2.9421` |
| threshold_name | `parameters.low_shock_threshold_pos` |
| threshold_value | `2.7` |
| threshold_comparison_result | `2.9421 >= 2.7` |
| base_predicates_pass_before_utc_gate | `true` |
| utc_exclusion_gate_status | `NON_EXCLUDED_BY_UTC_16_18_GATE` |

## Authority locks

| Field | Value |
|---|---|
| paper_runtime_invoked | `false` |
| StrategyFeatureSnapshot_materialized | `false` |
| STRAT_EVAL | `0` |
| CANDIDATE | `0` |
| ORDER_INTENT | `0` |
| observation_day_eligible | `false` |
| observation_day_increment | `0` |
| qfa_410b_or_qfa_611_run | `false` |
| Databento_fetch_attempted | `false` |
| broker_live_authorized | `false` |
| phase_6_authorized | `false` |
| active_candidate_roster_mutated | `false` |
| global_regime_labels_mutated | `false` |

## Output hashes

| Artifact | LF SHA-256 |
|---|---|
| bounded_local_capture_source_readiness_jsonl | `22f3734084208d16e207720170dea8c8b7c07bc749dba34999800a5dda68fb06` |
| local_capture_source_readiness_report_json | `10b65ffe2dac687e25cf95c90fb90be05d8e9708ccba7d118feb24db26db1354` |
| local_capture_source_readiness_report_md | `b83eccf21dfa3466958dbc2e17c7a0a99d7bb0140db7a4a18c4f9d7c9e70fd5e` |

Recommended next ticket: `V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FEATURE-SNAPSHOT-BUILDER-IMPL-01`
