# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-08-LOCAL-CAPTURE-SOURCE-READINESS-01

Determination: `LOCAL_CAPTURE_SOURCE_READINESS_BLOCKED_NO_CANDIDATE_ELIGIBLE_NON_EXCLUDED_POINT`

## Source readiness

| Field | Value |
|---|---|
| target_session_id | `2026-06-08-rth` |
| source_file | `D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-08/MNQ_globex.obs01.jsonl` |
| source_file_role | `continuous_globex_capture_containing_2026-06-08_rth` |
| observation_window_start_utc | `2026-06-08T13:30:00.000000000Z` |
| observation_window_end_utc | `2026-06-08T20:00:00.000000000Z` |
| window_basis | `RTH` |
| accounting_slots_expected | `390` |
| snapshot_cadence_basis | `one closed 1m accounting slot` |
| rth_trade_records | `1713081` |
| rth_trade_slots_present | `390` |
| rth_trade_slots_missing | `0` |
| first_rth_record_utc | `2026-06-08T13:30:00.001092437Z` |
| last_rth_record_utc | `2026-06-08T19:59:59.997824545Z` |
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
| ready_for_feature_snapshot_builder | `false` |
| quote_source_records_scanned_in_window | `25351110` |
| finite_quote_records_scanned_in_window | `25351110` |

## Candidate feasibility

| Field | Value |
|---|---|
| candidate_eligible_points | `0` |
| candidate_eligible_non_excluded_points | `0` |
| candidate_eligible_excluded_points | `0` |
| regime_label | `high` |
| threshold_name | `parameters.low_shock_threshold_pos` |
| threshold_value | `2.7` |
| base_predicates_pass_before_utc_gate | `false` |

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
| bounded_local_capture_source_readiness_jsonl | `0a16b7907e46f999ccbb09905e18f64a7956d90cbe46ff40898408888e978d3a` |
| local_capture_source_readiness_report_json | `69db00935b2bbba379269ec2c42fdea89194e0483d656126a88f3d591caaf289` |
| local_capture_source_readiness_report_md | `00180a73b1094a2ee3f9d33f49c0bd2508fd6e285c3fbb8a3ae6a484599b90ee` |

Recommended next ticket: `V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-08-NO-CANDIDATE-ELIGIBLE-DISPOSITION-01`
