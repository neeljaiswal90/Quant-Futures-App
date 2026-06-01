# V2-PF-C-LATE-AM-PAPER-OBSERVATION-SOURCE-DATA-EXTEND-01 Memo

## 1. Context

PR #297 concluded that a capture-backed feature builder is plausible, but the bounded `obs01` trade-only sample cannot honestly produce v2 feature snapshots by itself. This ticket extends and inventories bounded Rithmic source-data inputs before any future builder emits `StrategyFeatureSnapshot` records.

## 2. Source-data scope

This ticket is source-data only. It does not run the paper strategy runtime, emit feature snapshots, call `PaperTradingSession.processFeatureSnapshot(...)`, or produce `STRAT_EVAL`, `CANDIDATE`, or `ORDER_INTENT` evidence.

## 3. Bounded source selection

Selection policy: `first_N_valid_source_records_by_file_order_then_merge_by_source_ts_ns_source_path_source_line_number`. The bounded source payload is written to `artifacts/paper-observation/v2-pf-c-late-am-paper-observation-source-data-extend-01/bounded-source-events.jsonl` and has LF SHA-256 `0ab171e087826aaffb14cfbf6d3e5a51bd81173ace17efe85528790452010788`. Full source-file hashes are labeled `point_in_time_full_file` because the Rithmic captures are live/growing surfaces.

## 4. Source inventory

| Item | Readiness | Evidence |
| --- | --- | --- |
| trade_source | available | 7 bounded TRADE records |
| quote_source | available | 33 bounded QUOTE records |
| depth_or_mbo_source | diagnostic_available | 80 bounded depth/MBO records |
| session_join_source | unavailable_deferred | No capture-backed session join record emitted in this source-data pass |
| regime_join_source | unavailable_deferred | No capture-backed regime join record emitted in this source-data pass |
| vix_join_source | unavailable_deferred | VIX contracts/loaders are present in repo, but no capture-time VIX join record is emitted here |
| source_files | available | obs01, mbp1, and mbo files inspected |

## 5. Bounded event counts

| Record type | Count |
| --- | --- |
| DEPTH_OR_MBO_DIAGNOSTIC | 80 |
| QUOTE | 33 |
| TRADE | 7 |

## 6. v2 behavior-bearing readiness

| Behavior-bearing field | Status | Notes |
| --- | --- | --- |
| created_ts_ns | source_time_available | Feature builder can derive candidate timestamps only after deterministic bar/snapshot construction is specified |
| session.is_rth / is_halt / is_roll_block | blocked_join_required | Requires capture-time session calendar join; no snapshot emitted by this ticket |
| quote.mid_px | source_available_builder_required | MBP1 quote source is available, but builder must define causal quote-to-snapshot selection |
| instrument.tick_size | static_config_required | MNQ tick size can be supplied by instrument config in future builder implementation |
| indicators.sigma_pts | blocked_indicator_builder_required | Requires causal rolling-bar indicator construction from source events |
| context.regime_label | blocked_join_required | Requires causal regime label join against artifact source |
| context.signed_shock_vwap.value | blocked_indicator_builder_required | Requires causal signed-shock calculation from source events |
| config lineage | available_from_existing_paper_wrapper | regime_shock_reversion_short_v2_utc_16_18_exclusion |

## 7. Parser accounting and provenance

Each bounded record carries `record_type`, `source_path`, `source_line_number`, `source_ts_ns`, `derived_ts_ns`, `source_event_id`, `causality_status`, `source_record_lf_sha256`, and a source-specific payload. Parser accounting is serialized in the JSON report.

## 8. Determination

Determination: `SOURCE_DATA_PARTIAL_EXTENSION_REMAINS_BLOCKED`. Quote/trade/depth source data can be bounded and proven, but behavior-bearing session, regime, sigma, and signed-shock construction remain future builder or source-join work.

## 9. Observation-day lock

Observation-day eligible: `false`. Observation-day increment: `0`. This ticket cannot count toward the 45/60 paper-observation day requirement.

## 10. Recommended next ticket

`V2-PF-C-LATE-AM-PAPER-OBSERVATION-SESSION-REGIME-SHOCK-SOURCE-EXTEND-01` should extend or pin the remaining session/regime/signed-shock source joins before implementing a capture-backed feature builder.

## 11. Authority caveat

No broker/live dispatch, Phase 6 authority, active roster mutation, candidate roster mutation, or paper-observation day credit is created by this ticket.
