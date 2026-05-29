# CYCLE4-R1-V3-EARLY-ADVERSE-EVIDENCE-SURFACE-EXTEND-01

## 1. Context

`CYCLE4-R1-V3-EARLY-ADVERSE-MOVEMENT-DIAGNOSTIC-01` found that currently serialized pre-entry fields did not cleanly separate `regime_shock_reversion_short_v3` max-adverse-R fail-safe losses from target winners.

This ticket extends the held-out evidence surface only. It does not change strategy logic, management behavior, replay behavior, qfa-410b dispatch semantics, qfa-611 verdict logic, strategy rosters, or any activation authority.

## 2. Field inventory

| Field | Class | Source | Action | Notes |
|---|---|---|---|---|
| `trade_id` | already-present | held-out trade projection | unchanged | Stable per-trade identity remains present. |
| `session_id` | already-present | real-archive session | unchanged | Used for concentration analysis. |
| `entry_ts_ns` / `exit_ts_ns` | already-present | trade ledger / exit projection | unchanged | Supports hold-time analysis. |
| `entry_price` / `exit_price` | already-present | trade ledger | unchanged | Supports entry-to-exit movement diagnostics. |
| `exit_reason` | already-present | trade ledger | unchanged | Used for class definitions. |
| `management_action_reason` | already-present | `trades[].exits[]` | unchanged | Exact fail-safe reason remains on per-exit metadata. |
| `fail_safe_context` | already-present | fail-safe exit projection | extended | Existing context remains and now includes `adverse_r_at_exit`. |
| `vix_prior_close_percentile` | already-present | regime label / snapshot context lineage | unchanged | Represents the current primary VIX percentile evidence surface. |
| `vix_value` | new-pre-entry-context | entry snapshot context | added | Captured from the same entry-time feature snapshot used by the strategy. |
| `vix_fresh` | new-pre-entry-context | entry snapshot context | added | Captured at entry time. |
| `signed_shock_vwap` | new-pre-entry-context | entry snapshot context | added | Producer-owned signed-shock measurement, not recomputed by projection. |
| `signed_shock_vwap_recent_values` | new-pre-entry-context | entry snapshot context | added | Captured as an immutable copy when available. |
| `primary_percentile` | unavailable/deferred | regime labels | deferred | Already represented by `vix_prior_close_percentile` in the runtime snapshot contract. |
| `vxn_percentile` | unavailable/deferred | regime labels only | deferred | Not first-class runtime snapshot context; adding it would require a separate contract decision. |
| `spread_bucket` / `queue_ahead_bucket` | already-present | entry fill estimate | unchanged | Existing coarse liquidity context remains available. |
| `regime` | already-present | session regime label | unchanged | Existing held-out field. |
| `max_favorable_excursion_cents` / `max_adverse_excursion_cents` | already-present | lifecycle excursion tracker | unchanged | Outcome diagnostics only. |
| `first_minute_max_favorable_excursion_cents` | new-early-post-entry-context | first completed post-entry bar within 60 seconds | added | Causal post-entry path summary. |
| `first_minute_max_adverse_excursion_cents` | new-early-post-entry-context | first completed post-entry bar within 60 seconds | added | Causal post-entry path summary. |
| `first_minute_close_pnl_cents` | new-early-post-entry-context | first completed post-entry bar within 60 seconds | added | Causal post-entry path summary. |
| `first_minute_observed` | new-early-post-entry-context | lifecycle path observation | added | False when no completed post-entry bar is available inside the first-minute window. |
| `adverse_r_at_exit` | new-derived-exit-context | fail-safe exit context | added | Per-exit scalar computed from direction, entry price, exit mark, and risk points. |

## 3. Schema changes

The artifact schema remains `schema_version: 1`.

All additions are optional/additive fields. No existing field is renamed, removed, or reinterpreted.

New trade-level fields:

- `vix_value`
- `vix_fresh`
- `signed_shock_vwap`
- `signed_shock_vwap_recent_values`
- `first_minute_max_favorable_excursion_cents`
- `first_minute_max_adverse_excursion_cents`
- `first_minute_close_pnl_cents`
- `first_minute_observed`

New per-exit fail-safe context field:

- `adverse_r_at_exit`

## 4. Pre-entry context attribution path

The new pre-entry fields are captured from the `StrategyFeatureSnapshot.context` available at candidate/entry time. The projection does not recompute VIX, signed-shock, or recent signed-shock values from bar history.

This preserves producer-owned feature semantics:

- `vix_value` and `vix_fresh` come from the entry snapshot context.
- `signed_shock_vwap` comes from the entry snapshot context.
- `signed_shock_vwap_recent_values` is copied from the entry snapshot context when present.

## 5. First-minute path attribution path

The first-minute path summary is intentionally causal.

The entry-decision bar is not reused as post-entry movement evidence. The runner observes the first completed bar after the position opens, bounded to the first 60 seconds after entry. If no such bar is observed before the trade closes, `first_minute_observed` is `false` and the first-minute path fields remain `null`.

## 6. Adverse-R scalar attribution path

`adverse_r_at_exit` is projected only on per-exit `fail_safe_context` records. It is computed from the same direction, entry price, exit mark, and risk-point semantics used by the lifecycle position, not from average trade PnL.

This keeps exact fail-safe reason attribution at the existing access path:

`trades[].exits[].management_action_reason`

No redundant top-level `fail_safe_reason` field was added.

## 7. Backward compatibility

Existing artifacts remain readable because all fields are additive.

The qfa-611 selection driver is expected to ignore these fields. Its verdict computation must continue to consume the established aggregate and trade metadata fields only.

## 8. Test coverage

The implementation adds or updates tests for:

- real-archive per-trade projection of entry snapshot context and first-post-entry path fields
- held-out artifact projection of the new trade fields and `adverse_r_at_exit`
- committed fixture roundtrip compatibility
- qfa-611 additive-field ignore compatibility

## 9. PROCESS-03 hash/determinism report

Expected drift class: evidence-surface only.

The change extends serialized held-out evidence fields without changing runtime entries, exits, fills, trade count, PnL, strategy generation, management behavior, or qfa-611 verdict logic.

Verification result:

| Hash | Run A | Run B | Status |
|---|---|---|---|
| `final_chain_hash` | `ac6a3ce12f48de89b91d54054b26f1d23beedee648070f79e1133ced0013f510` | `ac6a3ce12f48de89b91d54054b26f1d23beedee648070f79e1133ced0013f510` | pinned |
| `final_phase2_hash` | `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b` | `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b` | pinned |
| `final_phase4_hash` | `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090` | `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090` | pinned |

PROCESS-03 classification: no drift in the determinism fixture. Future held-out artifacts generated with the extended projection are expected to show evidence-surface shape changes while preserving trade behavior and PnL anchors.

## 10. Future diagnostic unlock

After this PR lands, the intended follow-up is:

`CYCLE4-R1-V3-EARLY-ADVERSE-MOVEMENT-DIAGNOSTIC-02`

That rerun should use newly generated held-out artifacts to test whether entry-time signed-shock context, VIX freshness/value, and first-minute path behavior explain the `fail_safe:max_adverse_r_exceeded` loss class more clearly than the prior evidence surface could.

## 11. Authority caveat

This PR does not activate any strategy, does not authorize paper observation, does not authorize broker/live dispatch, does not authorize Phase 6, and does not mutate `ACTIVE_STRATEGY_IDS`.
