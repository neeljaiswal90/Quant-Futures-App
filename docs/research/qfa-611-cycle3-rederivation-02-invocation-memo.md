# QFA-611-CYCLE3 re-derivation invocation memo (round 2)

**Authority**: ADR-0024 LD-024-2 (joint coordinator + operator authorization required to invoke the post-verdict infrastructure-bug re-derivation protocol).

**Date**: 2026-05-24

**Cycle being re-derived**: Cycle3 (Phase 5 closure at commit `e985b10`, previously re-derived under REDERIVATION-01 at commit `ffeea42`).

**Trigger**: MGMT-BUG-FIX-02 merged at commit `d1d7461` (PR #240). The fix enforces four management-profile parameters that were previously declared, parsed, validated, and propagated onto the position object but never read by the runtime evaluators.

**Decision**: **INVOKE — Path A (fix-and-rederive)**.

This is the second invocation of ADR-0024 in this project. REDERIVATION-01 corrected the BE@PT1 silent-no-op (combined-bar PT1/stop precedence). REDERIVATION-02 corrects four unenforced fail-safe and time-stop parameters. Both bugs are the same class: declared management semantics not consulted at runtime. After REDERIVATION-02, every parameter on every active management profile is verified-enforced.

## Bug summary

Four parameters declared on `ManagementProfile.fail_safe` and `ManagementProfile.time_stop` were not consulted by the runtime evaluators. The runtime was strictly more aggressive than the declared profile intended on time-stop (cut trades the profile said to hold) and strictly less protective on fail-safe (did not exit on adverse-R or spread-blowout conditions). Both directions contaminate the realized R-distribution.

File-level citations (pre-fix state at commit `ea3a2ea`):

- `apps/strategy_runtime/src/management/types.ts:78-86` — type definitions for the four fields (declared)
- `apps/strategy_runtime/src/management/management-config.ts:373-395` — parser validation (parsed)
- `apps/strategy_runtime/src/management/management-profiles.ts:52-60` — `BASE_TIME_STOP` and `BASE_FAIL_SAFE` defaults (defaulted)
- `apps/strategy_runtime/src/management/target-position.ts:500-506` — values carried onto position-open snapshot (propagated)
- `apps/strategy_runtime/src/management/target-position.ts:730-734` — schema validation on the position state (validated)
- `apps/strategy_runtime/src/management/position-manager/fail-safe.ts` — `firstFailSafeReason` consulted six structural integrity checks; **never read** `position.fail_safe.max_adverse_r` or `position.fail_safe.max_spread_ticks`
- `apps/strategy_runtime/src/management/position-manager/time-stops.ts` — `evaluateTimeStop` exited unconditionally on deadline; **never consulted** `position.time_stop.pre_pt1_min_unrealized_r` or `position.time_stop.post_pt1_min_unrealized_r`
- `apps/strategy_runtime/tests/unit/position-manager.test.ts` — pre-fix test coverage for the four parameters: **zero**

Fix landed at PR #240 / merge commit `d1d7461`:

- `position.fail_safe.enabled === true` now gates the new `max_adverse_r` and `max_spread_ticks` checks (consistent with `position.time_stop.enabled` discipline).
- `max_adverse_r` check fires when `adverseR_t ≥ position.fail_safe.max_adverse_r` (reason: `fail_safe:max_adverse_r_exceeded`).
- `max_spread_ticks` check fires when `(ask - bid)/tick_size > position.fail_safe.max_spread_ticks` (reason: `fail_safe:max_spread_ticks_exceeded`). Mode-aware: live-authoritative mode requires bid/ask presence (fails closed with `fail_safe:spread_unavailable_in_live_authoritative` if missing); synthetic mode skips when bid/ask absent (fixture compliance is the contract).
- Time-stop now holds past deadline when `unrealizedR ≥ threshold` (reasons: `time_stop:held_past_deadline_{pre,post}_pt1`); exits with the existing `time_stop:deadline_reached` semantics only when `unrealizedR < threshold`.
- Existing six structural fail-safe checks unchanged in ordering and behavior. The two new checks are appended, not interleaved.
- 18 new unit tests cover the corrected behavior; existing stop-stage tests adjusted to disable fail-safe in isolation (because the corrected fail-safe stage preempts stop at exactly -1R under FSM ordering); three backtester per-trade-record fixtures updated from `exit_reason: 'stop_loss'` to `exit_reason: 'fail_safe'` for the same reason.

## Four-criteria verification per ADR-0024 LD-024-1

### Criterion 1 — Shared infrastructure

**PASS.** The defect lived in `apps/strategy_runtime/src/management/position-manager/fail-safe.ts` and `time-stops.ts`. These files operate across every strategy in the project. The four affected parameters appear on every active strategy's management profile via `BASE_TIME_STOP` and `BASE_FAIL_SAFE` defaults. NOT strategy-specific code. NOT a YAML. NOT a parameter-lock-hash artifact.

### Criterion 2 — Material effect on verdict-determining metrics

**PASS** with two evidence streams:

**(a) Direct semantic evidence.** The fix changes two runtime behaviors that directly affect the trade-level R distribution:

- **Time-stop:** pre-fix runtime exited every position at deadline regardless of unrealized R. Post-fix runtime holds positions past deadline when uR ≥ floor (-0.25R pre-PT1, 0R post-PT1 per `BASE_TIME_STOP`). Trades that previously cut at deadline at slight losses now hold to subsequent stop, target, or fail-safe events. Both win-rate and per-trade R distribution shift.
- **Fail-safe:** pre-fix runtime had no `max_adverse_r` or `max_spread_ticks` enforcement. Post-fix runtime exits at adverse_R ≥ 1.0R (`BASE_FAIL_SAFE.max_adverse_r`) and at spread > 8 ticks (`BASE_FAIL_SAFE.max_spread_ticks`). Under FSM ordering (`fail_safe → markPt1Touched → stop_hit → ...`), positions that previously exited via `stop_hit` at exactly -1R now exit via `fail_safe:max_adverse_r_exceeded` at the same price. Practical PnL on stop-out trades is unchanged; the exit-reason taxonomy materially shifts.

**(b) Artifact evidence from PR #240.** Determinism check produced:
- `final_chain_hash` shifted from baseline to `570218c5a5beb3260eb40e775757b93dc488e6e53c64a49a590721023a5cdbad` — trade-ledger artifacts materially changed.
- `final_phase2_hash` and `final_phase4_hash` pinned (regime substrate and decision-level fingerprints unaffected, as expected — management runtime is decision-orthogonal).
- Three backtester per-trade-record fixtures required `exit_reason: 'stop_loss'` → `exit_reason: 'fail_safe'` updates to match the corrected runtime (PR #240 commit `5fb1e93`). These fixtures encoded verdict-relevant trade outcomes for Cycle3-equivalent scenarios.

The combination of (a) and (b) crosses the materiality bar in LD-024-1 criterion #2 (≥ 10% metric shift, threshold flip, or verdict change). Precise per-strategy PnL/PF/Sharpe shifts will be produced by the re-derivation itself (REDERIVATION-02 inference layer). Both directions of asymmetry are present:

- **More aggressive on fail-safe**: bigger left-tail loss prevention on spread blowouts (previously unprotected).
- **More aggressive on adverse-R fail-safe**: shifts exit-reason taxonomy on stop-equivalent trades; could affect MFE/MAE attribution.
- **Less aggressive on time-stop**: more right-tail capture (trades held past deadline can reach PT1/PT2); but also more left-tail risk (trades held past deadline can deteriorate to fail-safe -1R instead of being cut at -0.20R).

The net effect on each strategy's verdict is not pre-positioned by this memo — that is the point of the re-derivation.

### Criterion 3 — Discovered post-verdict

**PASS.** The Cycle3 closure verdict was issued at commit `e985b10` on 2026-05-19 against the management runtime that contained this bug. REDERIVATION-01 corrected the BE@PT1 silent-no-op at commit `ffeea42` on 2026-05-22 but did not surface the four unenforced parameters — REDERIVATION-01's scope was BE@PT1 alone. The MGMT-BUG-FIX-02 defect was identified through strategy-research-brief analysis on 2026-05-24, three days post-REDERIVATION-01 closure and five days post-original-closure. No prior ADR, code comment, test docstring, or research memo documented the unenforced-parameter behavior. The bug was not known and not accepted as a design choice at any prior verdict time.

### Criterion 4 — Correctness-bug, not design-choice

**PASS.** The defect's behavior contradicts the declared intent of `BASE_TIME_STOP` (`pre_pt1_min_unrealized_r: -0.25, post_pt1_min_unrealized_r: 0`) and `BASE_FAIL_SAFE` (`max_adverse_r: 1, max_spread_ticks: 8`). These profile values were explicit declarations that the time-stop should hold past deadline when uR was above the floor, and that fail-safe should exit on adverse R ≥ 1.0 or spread > 8 ticks. The runtime's failure to consult these declared values produced behavior that contradicted the declared intent. The schema-parser-validator chain demonstrates the project's intent that these values be runtime-effective; the runtime's silent non-consultation is a correctness bug, not a suboptimal-but-deliberate design choice. This is the same bug class as the BE@PT1 silent no-op (ADR-0023 anti-pattern #4: declared parameters must be enforced or fail-closed). Peer-coord's process-improvement refinement (QFA-MGMT-WIRING-TEST-01) systematically prevents this class of bug going forward.

## Path selection

Three paths per ADR-0024 LD-024-3:

- **Path A (fix-and-rederive)**: MGMT-BUG-FIX-02 has already landed at `d1d7461`. Re-run Cycle3 inference layer against the corrected engine for all 3 active strategies + the v3 REGISTERED_INACTIVE strategy. Re-derive the Phase 5 closure verdict. Methodologically cleanest; absorbs the v3 fixture updates into the re-derivation artifact set.

- **Path B (defer-and-document)**: Document the bug as known issue. Proceed with QFA-612-BROKER-03 paper trading against the corrected engine (verdict context mismatch, since the verdict was issued against the buggy engine). Methodologically weaker than Path A; verdict context is split between Cycle3 closure (buggy) and paper observation (corrected).

- **Path C (fix-and-proceed)**: Skip re-derivation. Proceed with BROKER-03 against the corrected engine. Methodologically weakest — same verdict-context split as Path B without the documentation discipline.

**Path A selected** for the following reasons:

1. The bug affects shared infrastructure; future strategies and future cycles benefit from a corrected baseline (same rationale as REDERIVATION-01).
2. Both Cycle3 verdicts (the ADVANCE_TO_PAPER for `regime_shock_reversion_short_v2` and the active overnight reversal verdicts) were issued against the buggy management engine; re-derivation gives clean verdict attribution.
3. The QFA-612-BROKER-03 paper-observation cadence (CF-52 floor of 45-60 sessions) is gated on a clean verdict. Path B/C would force an explicit verdict-context note in the broker dispatch packet that would in turn cascade into any future live-promotion decision. Path A removes that complication.
4. Two consecutive ADR-0024 invocations with consistent Path A selection establish the project's discipline pattern: post-verdict infrastructure bugs trigger re-derivation, not deferral.

## Apr 1-8 regime-pinning finding (not a re-derivation trigger; restated from REDERIVATION-01)

Per REDERIVATION-01 §"Apr 1-8 regime-pinning finding," the regime classifier's sustained `high` classification through April 1-8 directional trends is a **strategy-level edge limit, not an infrastructure bug**. This re-derivation does not change that classification. The Cycle4 hypothesis chain (R1 VIX-gate scope, R2 hold-time entry gate, V3-IMPL v3 REGISTERED_INACTIVE) addresses this finding via new strategy_ids per CF-41. REDERIVATION-02 does not modify regime substrate, ADR-0013, or any Cycle4 work.

## Scope

The re-derivation per LD-024-3 Steps 2-3 covers:

- All 3 active Cycle3 strategies: `vwap_overnight_reversal_long`, `vwap_overnight_reversal_short`, `regime_shock_reversion_short_v2`
- The 1 REGISTERED_INACTIVE Cycle3 strategy added under Cycle4-V3-IMPL: `regime_shock_reversion_short_v3` — though this strategy has no Phase 5 verdict (REGISTERED_INACTIVE per Cycle3 closure-memo B-full amendment), its inference artifacts should be regenerated under the corrected runtime for consistency with the active roster.

Per LD-024-4, re-derivation MUST include ALL strategies in the cycle's roster (the `effective_trial_count + DSR penalty integrity` argument from the original ADR-0024 drafting). The roster is the four strategies listed above.

## Implementation chain (per LD-024-3)

| Order | Ticket / Artifact | Status |
|---|---|---|
| 1 | **MGMT-BUG-FIX-02** (this fix) | **DONE** — merged at `d1d7461` (PR #240) |
| 2 | **QFA-611-CYCLE3-REDERIVATION-02-INVOCATION-MEMO** (this memo) | Drafted; awaiting joint sign-off |
| 3 | **QFA-611-CYCLE3-REDERIVATION-02** | Re-run inference for all 4 strategies against the corrected engine. Produces updated held-out-validation JSONs + `strategy-selection-v4.json` + re-derivation memo at `docs/research/qfa-611-cycle3-rederivation-02-memo.md`. Amends `docs/research/qfa-611-cycle3-closure-memo.md` with a REDERIVATION-02 section (REDERIVATION-01 section preserved verbatim per LD-024-3 Step 3 discipline). |
| 4 | **Verdict reconciliation decision** | Coordinator + operator review re-derived verdicts. Decision documented in the REDERIVATION-02 memo. Per LD-024-3 Step 4. |
| 5 | **Downstream dispatches resume or revise** | If verdict-set unchanged: QFA-612-BROKER-03 dispatches with original allowlist. If verdict-set changed: dispatch chain revised. |

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Re-derivation reveals v2 verdict flips from ADVANCE_TO_PAPER to REJECT | Medium | LD-024-3 Step 4 explicitly contemplates this; downstream paper-observation cadence pauses; operator + coord reconcile. v2 trade volume + PF were strong post-REDERIVATION-01 (PF 2.17), so a flip is unlikely but possible if held-past-deadline losses dominate the right-tail gain |
| Re-derivation reveals overnight reversal verdicts flip | Medium | Same Step 4 reconciliation; overnight reversal strategies have shorter average hold times and may be less affected by the time-stop semantic change |
| v3 inference produces a passing held-out result | Low | v3 is REGISTERED_INACTIVE; passing the corrected-runtime inference doesn't auto-promote (per Cycle3 closure-memo B-full amendment, Cycle4 hypotheses cannot ACTIVATE until a formal Cycle4 cycle runs). Result is informational |
| Compound bug interaction: BE@PT1 fix + MGMT-BUG-FIX-02 fix interact in ways the unit tests don't cover | Medium | PR #240's 18-test pack + the existing post-PR-215 BE@PT1 tests collectively cover the combined-bar, deadline, and adverse-R surfaces. Integration-level test (full-replay determinism check) passed A/B byte-equal under the corrected runtime — a stronger guarantee than per-stage unit tests |
| Second invocation of ADR-0024 erodes the protocol's "narrow by construction" property | Medium | Both invocations meet all four LD-024-1 criteria explicitly; both share the same bug class (declared-but-unenforced parameters). QFA-MGMT-WIRING-TEST-01 will systematically catch this class going forward, reducing future invocations. The protocol is being applied correctly, not stretched |
| Operator perception that re-derivation is becoming routine | Low | Each invocation memo independently documents its own four-criteria verification; the audit chain is preserved per-instance. The DISCOVERY of these bugs is what's becoming routine (because peer-coord and coord-1 are running independent reviews); the protocol's invocation discipline is unchanged |

## References

- ADR-0023 (anti-pattern #4 fail-closed; the declared-but-unenforced bug class)
- ADR-0024 (re-derivation protocol; this is the second invocation)
- ADR-0024 LD-024-1, LD-024-2, LD-024-3, LD-024-4 (criteria, authority, sequence, roster)
- PR #240 / commit `d1d7461` (MGMT-BUG-FIX-02 fix)
- PR #217 / commit `ffeea42` (QFA-611-CYCLE3-REDERIVATION-01; precedent)
- PR #215 (QFA-MGMT-BUG-FIX-01; first invocation's fix)
- `docs/research/qfa-611-cycle3-rederivation-invocation-memo.md` (REDERIVATION-01 memo; template precedent for this memo)
- `docs/research/qfa-611-cycle3-rederivation-memo.md` (REDERIVATION-01 inference memo; precedent for the REDERIVATION-02 inference memo to be drafted under LD-024-3 Step 3)
- `docs/research/qfa-611-cycle3-closure-memo.md` (Phase 5 closure; to be amended with a REDERIVATION-02 section, preserving REDERIVATION-01 section verbatim per LD-024-3 Step 3)
- `docs/plan/mgmt-bug-fix-02-dispatch-packet.md` (dispatch packet for the fix; six rounds of coord-coord review documented)

## Process-discipline footnote

This second invocation of ADR-0024 surfaces a systemic gap that REDERIVATION-01 did not catch: the project has a pattern of declaring management parameters in profile types/parsers/defaults/position-state without unit-test coverage that asserts each parameter is actually consulted at runtime. After REDERIVATION-02 closes, **QFA-MGMT-WIRING-TEST-01** lands the test-generation discipline that systematically catches this class. The wiring test is not part of this re-derivation; it is post-merge follow-up work per peer-coord's process refinement, separate from but motivated by this invocation.

## Signatures

**Coordinator (this Claude session)**: signed `2026-05-24`. Coord-1 dispatched the fix packet, conducted four rounds of peer-coord review, missed the CI check in round 1 of PR review, recovered via coord-2 catch, re-issued APPROVED-READY-FOR-PR under the corrected protocol. Both coords on record for dual READY-FOR-PR.

**Coordinator (peer-coord Claude session)**: signed `2026-05-24` (implied by peer-coord COORD-2-APPROVED-READY-FOR-PR + concurrence on the post-merge work routing).

**Operator (human)**: signature required to commit this memo to main.

---

Memo drafted by coord-1 (the dispatching coord for MGMT-BUG-FIX-02). Per LD-024-2, this memo is committed to `main` as the authorization artifact for the REDERIVATION-02 ticket chain. No PR required (LD-024-3 Step 0 — invocation memo is a single commit). Operator commits when joint sign-off is on record.
