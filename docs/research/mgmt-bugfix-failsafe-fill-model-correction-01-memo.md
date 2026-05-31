# MGMT-BUGFIX-FAILSAFE-FILL-MODEL-CORRECTION-01 Memo

Date: 2026-05-31
Substrate: origin/main at `747ae998e957ee4bd8a1e7691299b5beffc3b4ae`
Class: Production code fix - fail-safe / stop-hit dispatch precedence

## 1. Context

This PR implements the stop-priority correction scoped by `MGMT-BUGFIX-FAILSAFE-FILL-MODEL-CORRECTION-SCOPE-01`.

The prior review found that `fail_safe:max_adverse_r_exceeded` could preempt the declared stop on a bar where the declared stop was also touched. That routed the exit through `FAIL_SAFE_EXIT` at `market.mark_price` instead of through `evaluateStopHit` at the declared `active_stop_price`.

The correction is intentionally narrow: only `fail_safe:max_adverse_r_exceeded` declines when the same market input also satisfies the shared stop-hit predicate. Hard fail-safe reasons and spread fail-safe behavior remain unchanged.

## 2. Mechanism

Before, `evaluateFailSafe` constructed a `FAIL_SAFE_EXIT` for every reason returned by `firstFailSafeReason`:

```ts
const reason = firstFailSafeReason(position, profile, market);
if (reason === undefined) {
  return { position, actions: [], reasons: [] };
}

const exitQuantity = Math.max(0, Math.floor(position.remaining_quantity));
```

After this PR, the `max_adverse_r_exceeded` same-bar stop-overlap case returns no action and no terminal reason before exit quantity or exit price is computed:

```ts
if (
  reason === 'fail_safe:max_adverse_r_exceeded' &&
  Number.isFinite(position.active_stop_price) &&
  position.active_stop_price > 0 &&
  isStopHit(position, market)
) {
  return {
    position,
    actions: [],
    reasons: ['fail_safe:declined_stop_overlap'],
  };
}
```

Because `terminal_reason` is omitted, the existing `evaluatePositionManager` dispatch loop falls through to `evaluateStopHit`, which emits `EXIT_FULL` with reason `stop:hit` at `active_stop_price`.

No dispatch-loop change was made in `position-manager/index.ts`.

## 3. `isStopHit` export rationale

`isStopHit` is now exported from `position-manager/stops.ts` so `evaluateFailSafe` can reuse the exact stop-hit predicate instead of duplicating it.

The predicate body is unchanged:

```ts
if (position.side === 'long') {
  return (market.low_price ?? market.mark_price) <= position.active_stop_price;
}
return (market.high_price ?? market.mark_price) >= position.active_stop_price;
```

This avoids predicate drift if future stop-hit semantics change.

## 4. Test coverage matrix

| Surface | Coverage |
|---|---|
| `failsafe-stop-priority-correction.test.ts` | New focused tests for short same-bar overlap, residual max-adverse when stop is not touched, invalid stop precedence, hard-class fail-safe preservation, spread fail-safe preservation, and long-side symmetry. |
| `failsafe-fill-model-review.test.ts` | Predecessor synthetic same-bar case updated with ticket annotations; residual fail-safe fill-model cases keep wider stops so they continue testing fail-safe behavior rather than stop overlap. |
| `management-exit-order-intent-parity.test.ts` | Loose parity test for management exit order intents: flatten side, quantity, market order type, IOC time-in-force, and runner-enriched `management_action_id` linkage. It intentionally does not assert journal exit price equals order-intent price. |
| `position-manager.test.ts` | Existing max-adverse overlap expectations updated from `FAIL_SAFE_EXIT` to `EXIT_FULL` / `stop:hit`, with ticket annotations. |
| Backtester real-archive / held-out tests | Three expected-value blocks updated for the corrected four-tuple: `exit_reason` `fail_safe` -> `stop_loss`, `management_action_type` `FAIL_SAFE_EXIT` -> `EXIT_FULL`, `management_action_reason` fail-safe -> `stop:hit`, and `fail_safe_context` object -> `null`. |

All updates are assertion-only for the three scope-expanded backtester files; synthetic fixtures were not changed.

## 5. Determinism report (PROCESS-03)

Same-worktree baseline and branch determinism were run with `npx tsx scripts/backtester/check-determinism.mts`.

| Hash | Baseline | Branch |
|---|---|---|
| `final_chain_hash` | `dcb48d0fc454f6a6627d865f637b61b8d00b90dc37ca119d053ada4cd4400261` | `dcb48d0fc454f6a6627d865f637b61b8d00b90dc37ca119d053ada4cd4400261` |
| `final_phase2_hash` | `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b` | `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b` |
| `final_phase4_hash` | `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090` | `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090` |

PROCESS-03 classification: no-drift observed.

Mechanistic explanation: the determinism fixture is a single-strategy, 3-event minimal DBN fixture and does not exercise the corrected same-bar `max_adverse_r + stop` overlap path. The correction is therefore invisible to the determinism oracle. That is a positive narrowness signal: the fix changes the targeted overlap behavior without changing the default determinism fixture's runtime or journal surface.

## 6. PnL directional expectation

This PR does not regenerate held-out artifacts and does not claim a new profit factor.

Directionally, PR #277 identified approximately 118 matched v2 trades where the post-fix path had reclassified old stop-loss exits into deeper fail-safe exits. This correction is expected to route that class back through declared stop handling when same-bar stop overlap is present.

The magnitude of any recovered PnL, revised PF, or verdict outcome is not claimed here. Precise v2/v3 re-attribution requires a separate artifact-generation and selection ticket against the corrected engine.

## 7. Live-parity disposition

The new orchestration parity test pins the loose parity contract currently supported by the architecture:

- management exits flatten the position side (`short` -> `buy`, `long` -> `sell`)
- quantity equals the management action exit quantity
- order type remains `market`
- time-in-force remains `ioc`
- runner-enriched `ORDER_INTENT` payloads preserve `management_action_id` linkage

The test intentionally does not assert tight parity between backtest journal `exit_price` and live/simulated order fill price. Tight parity would require a separate fill-model refactor and is out of scope.

## 8. Backward-compatibility surface

Existing tests that encoded the old same-bar preempt-then-fail-safe behavior were updated with inline `MGMT-BUGFIX-FAILSAFE-FILL-MODEL-CORRECTION-01` annotations.

The updated expectations are limited to the corrected overlap behavior:

- `fail_safe` exit reason becomes `stop_loss`
- `FAIL_SAFE_EXIT` action type becomes `EXIT_FULL`
- fail-safe action reason becomes `stop:hit`
- fail-safe context becomes `null` because no fail-safe action fired

Hard fail-safe classes still preempt, including profile mismatch, stale/gap market, invalid market price, missing stop, invalid quantity, and invalid target position. `fail_safe:max_spread_ticks_exceeded` remains unchanged.

## 9. Out-of-scope items

Out of scope for this PR:

- bid/ask realism
- dispatch-loop reordering in `position-manager/index.ts`
- removing or changing `max_adverse_r`
- changing `max_spread_ticks`
- strategy parameter tuning
- strategy YAML, generator, registry, or roster changes
- qfa-410b or qfa-611 artifact regeneration
- held-out or selection artifact updates
- ADR updates

Any future v2/v3 re-attribution under the corrected engine is a separate ticket, such as `MGMT-BUGFIX-EDGE-ATTRIBUTION-02`; it is not implicit in this PR.

## 10. Authority caveat

This PR fixes a backtest-engine dispatch precedence bug between `fail_safe:max_adverse_r_exceeded` and the declared stop. It does NOT tune any strategy parameter, create any new variant, mutate any roster, regenerate any artifact, or reopen ADR-0024 LD-024-3 Step 4 verdict reconciliation. Any future v2/v3 re-attribution under the corrected engine is a separate ticket.

No activation, paper observation, broker dispatch, live dispatch, or Phase 6 authority is created.
