# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FEATURE-SNAPSHOT-BUILDER-IMPL-01

## Determination

`FEATURE_SNAPSHOT_BUILDER_IMPL_EMITTED_SOURCE_BACKED_SNAPSHOT`

## Snapshot

| Field | Value |
|---|---|
| strategy_id | `regime_shock_reversion_short_v2_utc_16_18_exclusion` |
| feature_snapshot_id | `feature-v2pf-20260602-1780423199835478000` |
| created_ts_ns | `1780423199835478000` |
| created_ts_utc | `2026-06-02T17:59:59.835Z.835478000Z` |
| bars_in_snapshot | `119` |
| sigma_pts | `5.5567` |
| atr14_pts | `9.9665` |
| session_vwap | `30645.9255` |
| signed_shock_vwap | `-1.7986` |
| scoped_regime_label | `low` |

## Variant UTC gate interpretation

| Field | Value |
|---|---|
| target_entry_hour_utc | `17` |
| target_timestamp_variant_gate_status | `EXCLUDED_BY_UTC_16_18_GATE` |
| expected_next_strat_eval_smoke_outcome | `STRAT_EVAL_MARKER_ALLOWED_BUT_CANDIDATE_SUPPRESSED_BY_VARIANT_GATE` |

## Consumer compatibility proof

| Snapshot field path | Value present | Placeholder used | Source-ready anchor | Consumer status |
|---|---:|---:|---|---|
| `created_ts_ns` | `true` | `false` | PR #303 latest finite mid quote timestamp / PR #307 target event | `READY` |
| `quote.mid_px` | `true` | `false` | PR #303 latest finite mid quote | `READY` |
| `session.is_rth` | `true` | `false` | PR #306 source recheck / 2026-06-02 RTH source window | `READY` |
| `session.is_halt` | `true` | `false` | PR #307 MNQ session calendar | `READY` |
| `session.is_roll_block` | `true` | `false` | PR #307 MNQ roll calendar and session policy | `READY` |
| `indicators.sigma_pts` | `true` | `false` | Repo-faithful real-archive formula from bounded closed bars | `READY` |
| `context.regime_label` | `true` | `false` | PR #305 scoped paper-observation regime label source | `READY` |
| `context.signed_shock_vwap.value` | `true` | `false` | PR #303 signed_shock_vwap source readiness using atr_14 basis | `READY` |
| `config.config_hash / config.config_version` | `true` | `false` | Variant-owned strategy config YAML | `READY` |

## Source anchors

| PR | Anchor | Value |
|---|---|---|
| #303 | source readiness commit | `9c5a874374125574b2a93f55d84b9c9ad3d69466` |
| #303 | bounded source readiness LF SHA256 | `3e79062c0c8cb490e05534ed67d8ccbf9e0f64529c01179bf61e3c6c785e14bf` |
| #304 | source inputs LF SHA256 | `f9e2ac81a5577b24a7b72fe884f88ec7323c12d2d9d7a74a358fb1291ac8fac8` |
| #305 | scoped regime label source LF SHA256 | `152e7fbfdfca52494edbb11a7364cfbbaf33e9d03390bca1f17ee739e38d9662` |
| #306 | feature source recheck LF SHA256 | `53289beb5e013c4031004bf5a3296ded7085d9c1db585e7152d8b3df1825aadc` |
| #307 | halt/roll calendar LF SHA256 | `ce65d57bfb323ad3d90e4cec682b58c0cb627b0f95ef0520451d2c41a68cbd25` |

## Guardrails

| Guardrail | Value |
|---|---|
| active_roster_mutated | `false` |
| broker_live_authorized | `false` |
| candidate_count | `0` |
| candidate_roster_mutated | `false` |
| global_regime_labels_mutated | `false` |
| observation_day_eligible | `false` |
| observation_day_increment | `0` |
| order_intent_count | `0` |
| paper_runtime_invoked | `false` |
| phase_6_authorized | `false` |
| qfa_410b_or_qfa_611_run | `false` |
| strat_eval_count | `0` |
| strategy_feature_snapshot_emitted | `1` |

## Next ticket

`V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-STRAT-EVAL-SMOKE-01`

Verify STRAT_EVAL marker generation from the source-backed snapshot, while expecting CANDIDATE=0 / ORDER_INTENT=0 for this specific timestamp because the UTC 16-18 exclusion gate should suppress entries.

This PR materializes a bounded, causal feature snapshot artifact only. It does not invoke paper runtime strategy evaluation or create observation-day, broker/live, Phase 6, active-roster, candidate-roster, qfa-410b, or qfa-611 authority.
