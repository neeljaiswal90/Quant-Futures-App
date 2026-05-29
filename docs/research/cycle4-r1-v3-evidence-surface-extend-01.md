# CYCLE4-R1-V3-EVIDENCE-SURFACE-EXTEND-01

Date: 2026-05-29

Substrate: `cb804f2fa8ef6c22c74e82cb07e8f991c23d221e`

Status: evidence-surface extension only

## 1. Context

`CYCLE4-R1-V3-FAILSAFE-FORENSICS-01` identified that the current v3 held-out artifact was sufficient for exit-reason aggregate forensics, but not sufficient to explain why fail-safe exits occurred.

The source v3 artifact anchor remains:

| Field | Value |
|---|---|
| Source artifact SHA-256 | `40c3941a3351fd915da9c40835268eaa076caac4e23f92fc985b47f69d6f83c2` |
| Total trades | `889` |
| Fail-safe exits | `262` |
| Net PnL | `-102600` cents |

This ticket extends the held-out evidence surface so the next forensics pass can distinguish fail-safe subtypes and the runtime context around each fail-safe exit.

## 2. Field inventory

| Field | Class | Source | Action | Notes |
|---|---|---|---|---|
| `management_action_reason` | already-in-exits | `trades[].exits[]` | preserved | Exact `fail_safe:*` reason path already existed. |
| `management_action_type` | already-in-exits | `trades[].exits[]` | preserved | `FAIL_SAFE_EXIT`, `TAKE_PARTIAL`, `TAKE_PROFIT`, etc. |
| `target_label` | already-in-exits | `trades[].exits[]` | preserved | PT1/PT2/runner labels remain nested per exit. |
| `fail_safe_context.market_authority` | load-bearing-context | position manager market input | added | Captures stale/gap/authoritative state where available. |
| `fail_safe_context.market_is_stale` | load-bearing-context | position manager market input | added | Null when not supplied. |
| `fail_safe_context.mark_price` | load-bearing-context | position manager market input | added | Captures mark price used by fail-safe evaluation. |
| `fail_safe_context.bid_px` | load-bearing-context | latest quote | added | Null when unavailable. |
| `fail_safe_context.ask_px` | load-bearing-context | latest quote | added | Null when unavailable. |
| `fail_safe_context.active_stop_price` | load-bearing-context | target position | added | Context for missing/invalid stop attribution. |
| `fail_safe_context.remaining_quantity` | load-bearing-context | target position | added | Context for invalid quantity attribution. |
| `fail_safe_context.position_profile_id` | load-bearing-context | target position | added | Context for profile mismatch attribution. |
| `fail_safe_context.position_profile_version` | load-bearing-context | target position | added | Null when absent. |
| `fail_safe_context.management_profile_id` | load-bearing-context | resolved management profile | added | Runtime profile used during evaluation. |
| `fail_safe_context.management_profile_version` | load-bearing-context | resolved management profile | added | Runtime profile version. |
| `fail_safe_context.validation_path` | load-bearing-context | `fail_safe:invalid_target_position:<path>` reason suffix | added | Null unless recoverable from reason string. |
| `trade_id` | stable-identity | trade ledger closed trade | added | Enables stable per-trade joins. |
| `session_id` | stable-identity | journal event session mapping | added | Enables per-session concentration analysis. |
| `entry_price` | price/tick-context | trade ledger average entry price | added | Supports price-level forensics. |
| `exit_price` | price/tick-context | trade ledger average exit price | added | Supports price-level forensics. |
| `vix_prior_close_percentile` | desired-entry-context | real-archive session source | added | Null when unavailable. |
| signed-shock value | unavailable/deferred | not serialized per trade | deferred | Requires future evidence-surface work if needed. |
| recent signed-shock values | unavailable/deferred | not serialized per trade | deferred | Requires future evidence-surface work if needed. |
| VIX freshness | unavailable/deferred | not serialized per trade | deferred | Requires future evidence-surface work if needed. |

## 3. Schema changes

The held-out artifact remains `schema_version: 1`.

The extension is additive only:

| Surface | Change |
|---|---|
| Trade record | Added `trade_id`, `session_id`, `entry_price`, `exit_price`, and `vix_prior_close_percentile`. |
| Exit record | Added `fail_safe_context`, nullable for non-fail-safe exits. |
| Existing fields | No existing field was renamed, removed, or semantically changed. |

No top-level `fail_safe_reason` was added because the exact reason already exists at `trades[].exits[].management_action_reason`.

## 4. Fail-safe attribution path

Exact fail-safe reason attribution remains:

```text
trades[].exits[].management_action_reason
```

For fail-safe exits, this can contain values such as:

| Reason family |
|---|
| `fail_safe:profile_mismatch` |
| `fail_safe:stale_market` |
| `fail_safe:invalid_market_price` |
| `fail_safe:missing_stop` |
| `fail_safe:invalid_quantity` |
| `fail_safe:invalid_target_position:<path>` |
| other runtime-emitted `fail_safe:*` reasons |

The new `fail_safe_context` object sits beside that existing reason and captures the runtime context needed to explain it.

## 5. Backward compatibility

The selection driver compatibility test verifies that qfa-611 ignores additive evidence-surface fields transparently.

The artifact schema version remains `1`, matching the additive extension precedent from PR #252.

Existing selection verdict computation does not depend on the new fields.

## 6. Test coverage

Verification completed:

| Command | Result |
|---|---|
| `npx vitest run apps/backtester/tests/unit/held-out-validation/held-out-validation-real-archive.test.ts apps/backtester/tests/unit/held-out-validation/held-out-artifact-v1-roundtrip.test.ts` | PASS, `5/5` |
| `python -m pytest scripts/strategy-selection/_lib/tests` | PASS, `35 passed` |
| `npx vitest run` | PASS, `242 passed`, `1 skipped` |
| `npx tsc -b tsconfig.json` | PASS |
| `npm run lint --if-present` | PASS |
| `npx tsx scripts/backtester/check-determinism.mts` | PASS |

Added coverage includes:

| Test area | Coverage |
|---|---|
| Runtime fail-safe evidence | Asserts `fail_safe_context` is captured next to `FAIL_SAFE_EXIT`. |
| Target exits | Asserts non-fail-safe PT1/PT2 exits keep `fail_safe_context: null`. |
| Artifact projection | Asserts additive fields are emitted while preserving `schema_version: 1`. |
| qfa-611 compatibility | Asserts additive evidence fields do not alter selection evidence or verdict computation. |

## 7. PROCESS-03 hash and determinism report

Same-worktree baseline was captured before edits, then compared after implementation.

| Hash | Baseline | Post-change |
|---|---|---|
| `final_chain_hash` | `f4d4140ecbda93c9c7d26c826ccace242d3d1d776ae8e28f479e98ba059dcb1c` | `f4d4140ecbda93c9c7d26c826ccace242d3d1d776ae8e28f479e98ba059dcb1c` |
| `final_phase2_hash` | `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b` | `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b` |
| `final_phase4_hash` | `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090` | `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090` |

Classification: no drift.

The determinism fixture did not exercise a changed serialized evidence surface, so no runtime/journal, config-input lineage, or evidence-surface drift appeared in this check.

## 8. Future v3 forensics unlock

After this PR lands, the intended follow-up is:

```text
CYCLE4-R1-V3-FAILSAFE-FORENSICS-02
```

That rerun should use newly generated held-out artifacts with the extended evidence surface to distinguish:

| Analysis unlocked | Evidence path |
|---|---|
| fail-safe subtype concentration | `exits[].management_action_reason` |
| stale/gap/data-quality fail-safes | `exits[].fail_safe_context.market_authority` and `market_is_stale` |
| invalid price/stop attribution | `mark_price`, `bid_px`, `ask_px`, and `active_stop_price` |
| quantity/profile mismatch attribution | `remaining_quantity`, profile id/version fields |
| per-session concentration | `session_id` |
| price-level anatomy | `entry_price` and `exit_price` |
| VIX-band context | `vix_prior_close_percentile` where available |

## 9. Authority caveat

This ticket does not change strategy behavior, replay behavior, management behavior, PnL accounting, strategy YAMLs, registry status, or roster authority.

It does not activate any strategy, does not authorize paper observation, does not authorize broker/live dispatch, and does not authorize Phase 6.

`regime_shock_reversion_short_v3` remains registered inactive and explicit-replay only.
