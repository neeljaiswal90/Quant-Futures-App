# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-RTH-RAW-CAPTURE-SOURCE-BACKFILL-01

Determination: `RTH_RAW_CAPTURE_SOURCE_BACKFILL_BLOCKED_PROVIDER_CREDENTIALS_ABSENT`

## Backfill summary

| Field | Value |
|---|---|
| target_missing_window_start_utc | `2026-06-02T13:32:00.000000000Z` |
| target_missing_window_end_utc | `2026-06-02T16:02:00.000000000Z` |
| target_missing_window_exclusive_end_utc | `2026-06-02T16:03:00.000000000Z` |
| target_window_end_basis | `target_missing_window_end_utc is the last missing 1m slot start; exclusive_end is used for coverage scanning` |
| target_missing_slots | `151` |
| missing_raw_capture_slots_repaired | `0` |
| target_missing_window_covered | `false` |
| full_session_source_snapshot_window_repair_ready_for_rerun | `false` |
| exact_blocker_family | `provider credentials absent after local source absence reproduced` |

## Local source inventory

| Field | Value |
|---|---|
| raw_capture_file_present | `true` |
| normalized_obs_file_present | `true` |
| trade_bar_source_present | `false` |
| quote_source_present | `true` |
| source_time_min_utc | `2026-06-02T13:26:24.026331100Z` |
| source_time_max_utc | `2026-06-02T20:05:00.550999717Z` |
| target_missing_window_covered | `false` |
| raw_capture_records_in_target_window | `0` |
| raw_capture_slots_covered_in_target_window | `0` |
| normalized_trade_records_in_target_window | `0` |
| normalized_trade_slots_covered_in_target_window | `0` |
| quote_records_in_target_window | `0` |
| quote_slots_covered_in_target_window | `0` |
| quote_mid_ready_slots_from_pr318_carry_forward_accounting | `390` |
| quote_lane_is_not_current_blocker | `true` |

## Provider/backfill status

| Field | Value |
|---|---|
| provider_backfill_attempted | `false` |
| provider_name | `Databento` |
| provider_credentials_available | `false` |
| provider_fetch_result | `not_attempted_credentials_absent` |
| provider_data_committable | `false` |

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
| canonical_backtest_or_regime_artifacts_mutated | `false` |
| fabricated_market_data | `false` |

## Output hashes

| Artifact | LF SHA-256 |
|---|---|
| bounded_rth_raw_capture_source_backfill_jsonl | `ffaae47f013421887eb1af256dcf82412dd3473af0d80501dbedfe93a6b62be5` |
| rth_raw_capture_source_backfill_report_json | `0e8f1ba667b95e535f956f30bbfb58f6ede26746cbefce368809cf844e438ec6` |
| rth_raw_capture_source_backfill_report_md | `bf8d1ef39bd2676551c554705f72057d9bd9fc2a5efabea042782ce3fd3f83f2` |

Recommended next ticket: `V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-RTH-RAW-CAPTURE-PROVIDER-CREDENTIALS-01`
