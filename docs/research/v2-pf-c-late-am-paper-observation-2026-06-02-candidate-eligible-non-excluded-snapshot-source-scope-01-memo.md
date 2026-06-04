# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-CANDIDATE-ELIGIBLE-NON-EXCLUDED-SNAPSHOT-SOURCE-SCOPE-01 memo

## Summary

Determination:

```text
CANDIDATE_ELIGIBLE_NON_EXCLUDED_SNAPSHOT_SOURCE_AVAILABLE
```

The diagnostic used the 2026-06-02 OBS01 trade source and MBP1 quote source to scan causal closed-bar timestamps for a candidate-eligible, non-excluded snapshot source. Candidate-eligible means inherited v2 base predicates pass before the UTC exclusion gate is evaluated.

## Availability result

| Field | Value |
|---|---|
| candidate_eligible_snapshot_available | true |
| non_excluded_snapshot_available | true |
| candidate_eligible_non_excluded_snapshot_available | true |
| candidate_timestamp_ns_if_available | 1780427100000000000 |
| candidate_timestamp_utc_if_available | 2026-06-02T19:05:00.000000000Z |
| base_predicate_status | READY_ON_NON_EXCLUDED_SOURCE_TIMESTAMP |
| utc_exclusion_gate_status | NON_EXCLUDED_SOURCE_TIMESTAMP_AVAILABLE |

## Selected candidate point

| Field | Value |
|---|---|
| base_predicates_pass | true |
| base_predicates_pass_before_utc_gate | true |
| context.regime_label | "low" |
| context.session_vwap | 30642.6641 |
| context.signed_shock_vwap.value | 2.7449 |
| entry_hour_utc | 19 |
| indicators.atr14_pts | 9.048 |
| indicators.sigma_pts | 5.1814 |
| quote.mid_px | 30667.5 |
| session.is_halt | false |
| session.is_roll_block | false |
| session.is_rth | true |
| snapshot_value_compared | 2.7449 |
| threshold_comparison_result | "2.7449 >= 2.7" |
| threshold_name | "parameters.low_shock_threshold_pos" |
| threshold_value | 2.7 |
| timestamp_ns | "1780427100000000000" |
| timestamp_utc | "2026-06-02T19:05:00.000000000Z" |
| utc_exclusion_gate_status | "NON_EXCLUDED_BY_UTC_16_18_GATE" |

## Predicate and source provenance

| Field | Consumer status | Placeholder used | Source-ready anchor | Repo path / source |
|---|---|---:|---|---|
| session.is_rth | READY | false | PR #303 source window begins before RTH open; PR #307 MNQ session calendar provenance | apps/strategy_runtime/src/session/mnq-session-calendar.ts |
| session.is_halt | READY | false | PR #307 HALT_ROLL_CALENDAR_SOURCE_READY_FOR_FEATURE_BUILDER | apps/strategy_runtime/src/session/mnq-session-calendar.ts |
| session.is_roll_block | READY | false | PR #307 HALT_ROLL_CALENDAR_SOURCE_READY_FOR_FEATURE_BUILDER | apps/strategy_runtime/src/session/mnq-roll-calendar.ts; apps/strategy_runtime/src/session/mnq-session-policy.ts |
| context.regime_label | READY | false | PR #305 SCOPED_REGIME_LABEL_SOURCE_ACQUIRED_NOT_GLOBAL | scoped paper-observation source acquired by PR #305; global artifacts/regime/regime-labels.json read-only |
| quote.mid_px | READY_IF_TIMESTAMP_HAS_FINITE_QUOTE | false | 2026-06-02 MBP1 bid/ask source scan | D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02/MNQ_rth.mbp1.jsonl |
| indicators.atr14_pts | READY_IF_TIMESTAMP_HAS_AT_LEAST_14_CLOSED_BARS | false | PR #303 source-readiness formula carried forward; recomputed from closed 1m bars | D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02/MNQ_rth.obs01.jsonl |
| indicators.sigma_pts | READY_IF_TIMESTAMP_HAS_CLOSED_BARS | false | PR #308 consumer compatibility proof; recomputed from source-backed closed bars | D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02/MNQ_rth.obs01.jsonl |
| context.signed_shock_vwap.value | READY_IF_TIMESTAMP_HAS_VWAP_ATR_QUOTE | false | PR #303/PR #308 signed_shock_vwap source semantics | D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02/MNQ_rth.obs01.jsonl; D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02/MNQ_rth.mbp1.jsonl |
| config lineage | READY | false | PR #286 variant-owned runtime config source; PR #308 feature snapshot config lineage compatibility | config/strategies/regime_shock_reversion_short_v2_utc_16_18_exclusion.yaml |
| inherited v2 base predicate threshold | READY_IF_SIGNED_SHOCK_MEETS_THRESHOLD | false | PR #309 rejection provenance | apps/strategy_runtime/src/strategies/regime_shock_reversion_short_v2.ts |

## Source scan counts

| Field | Value |
|---|---|
| source_trade_records | 518356 |
| used_trade_records | 508896 |
| source_quote_records | 372599 |
| finite_quote_records | 300750 |
| closed_1m_bars_constructed | 245 |
| non_excluded_source_ready_points | 127 |
| candidate_eligible_points | 85 |
| candidate_eligible_excluded_points | 32 |

## Reason if unavailable

```json
null
```

## Hygiene checks

| Field | Value |
|---|---|
| malformed_iso_timestamp_pattern_absent | true |
| checked_pattern | 550Z.550603543Z |
| checked_scope | generated timestamp values |

## Anchors

- PR #308 source-backed snapshot: `feature-v2pf-20260602-1780423199835478000`
- PR #309 result: `STRAT_EVAL_SMOKE_PARTIAL_PASS_BASE_REJECTION_PRECEDES_UTC_GATE`
- PR #309 base rejection provenance: `parameters.low_shock_threshold_pos = 2.7`, compared against `-1.7986`

## Output hashes

| File | LF SHA-256 |
|---|---|
| bounded-candidate-eligible-non-excluded-source-scope.jsonl | bef6f28655b42d580d3d214747a38d539c5a4ec5d631f5e2c923f5f27afb1d08 |
| candidate-eligible-non-excluded-source-scope-report.json | 4e5f8b98a1fe57e9a90410dffc22448007722c1dee803b940b18e05a3a154ed4 |
| candidate-eligible-non-excluded-source-scope-report.md | 026abb8ff0f723fbdd520b8454c8054bc1e2569d46a7a94872aceb5de970f7d4 |

## Authority caveat

This is source-scope evidence only. It does not materialize a production `StrategyFeatureSnapshot`, invoke paper runtime, emit or claim `STRAT_EVAL`, `CANDIDATE`, or `ORDER_INTENT`, run qfa-410b/qfa-611, award observation-day credit, or create paper/live/broker/Phase 6/roster authority.

## Recommended next ticket

```text
V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-CANDIDATE-ELIGIBLE-SNAPSHOT-BUILDER-IMPL-01
```
