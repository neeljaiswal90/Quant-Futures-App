# ADR-0024: Post-verdict infrastructure-bug re-derivation protocol

## Status

Accepted

## Context

At 2026-05-22, post-Phase-5 analytical work surfaced a correctness bug in
shared management-engine infrastructure: the FSM in
`apps/strategy_runtime/src/management/position-manager/index.ts:95-139`
evaluates stages in the order `fail_safe → stop_hit → targets → time_stop
→ break_even arm → trailing`. On bars where both the stop level and PT1
target level are within the bar's [low, high] range — i.e. a bar that
spanned the full PT1-to-stop range — `evaluateStopHit` fires first and
calls `closePosition`, which maps all `pending` targets to `cancelled`
(stops.ts:133-137). PT1 status becomes `'cancelled'`, never `'filled'`.
The downstream `isBreakEvenTriggerMet` check at `stops.ts:156` requires
`status === 'filled'` and therefore never arms break-even on these
combined-bar cases.

The bug is undocumented in any ADR. The `BASE_BREAK_EVEN` profile
(`management-profiles.ts:42`) declares `trigger: 'after_pt1', offset_ticks:
1` — the explicit intent is to protect on PT1 touch. Unit tests at
`tests/unit/position-manager.test.ts` cover PT1 fill and stop hit as
separate ticks; the combined-bar tie-break is not covered.

Counterfactual impact on Cycle3 held-out validation:

| Segment | Baseline net | BE@PT1 (1-tick slip) net |
|---|---|---|
| Apr 1-8 (worst window) | −$43.50 (PF 0.98) | +$524.00 (PF 1.42) |
| Rest of corpus | +$2,096.00 (PF 1.75) | +$3,305.50 (PF 3.11) |
| **Cycle3 total** | **+$1,996.50 (PF 1.40)** | **+$3,829.50 (PF 2.17)** |

The Phase 5 ADVANCE_TO_PAPER verdict for
`regime_shock_reversion_short_v2` (commit `e985b10`, JSON sha256
`C313CC4CB518B47485D1D32C7F03FB22F1CD90F38F8D573DB745308860441D76`) was
issued against the buggy management engine. The strategy passed all 9
ADR-0016 Stage 1 thresholds with the bug active. With the bug fixed, the
metrics shift materially: profit factor rises from 1.40 to 2.17. The
shift is large enough that it could change verdicts for the two REJECTed
Cycle3 strategies (`vwap_overnight_reversal_short`,
`vwap_overnight_reversal_long`) — both were close on Sharpe / PF /
PSR_zero but failed on threshold conjunctions where BE arming would
plausibly tip the balance.

The project's existing ADR + carry-forward framework does not address
this situation directly:

- ADR-0016 (alpha decision criteria) sets thresholds + verdicts; it does
  not specify what happens when a bug in shared infrastructure is
  discovered post-verdict.
- ADR-0023 (Cycle3 anti-pattern lock + SignedShockMeasurement) locks the
  strategy code at parameter-lock-hash granularity; it does not
  contemplate engine-side bugs.
- CF-30 / CF-41 / CF-44 (anti-tuning carry-forwards) prevent parameter
  tuning on locked YAMLs and require new strategy_ids for new
  hypotheses; they do not address shared-infrastructure bug fixes.
- CF-45 (ADR threshold revisions require external methodological
  justification) sets the bar for threshold changes; it does not cover
  engine corrections.

ADR-0024 fills this policy gap. It establishes when and how the project
responds to post-verdict bugs in shared infrastructure, and what the
documentation + audit trail look like.

## Locked decisions

### LD-024-1: Definition of "verdict-context bug"

A **verdict-context bug** is a defect that meets all four criteria:

1. **Shared infrastructure**: lives in code that operates across multiple
   strategies — runtime / management / execution / observability /
   validation infrastructure. NOT strategy-specific code in
   `apps/strategy_runtime/src/strategies/`. NOT a single strategy's YAML.
   NOT a parameter-lock-hash artifact.
2. **Material effect on verdict-determining metrics**: the bug's
   correction materially shifts one or more of the ADR-0016 Stage 1
   metrics for one or more strategies that received Phase-N verdicts.
   "Material" is operationally defined as: any metric shifts by ≥ 10%
   relative to its prior value, OR any threshold pass/fail flips, OR any
   verdict changes (ADVANCE_TO_PAPER ↔ REJECT ↔ RESEARCH_FURTHER).
3. **Discovered post-verdict**: the bug was not known when the verdict
   was issued. The protocol does not retroactively apply to bugs that
   were known and accepted as design choices at verdict time.
4. **Correctness-bug, not design-choice**: the bug's behavior contradicts
   declared intent (documented in code comments, ADRs, profile
   declarations, or test docstrings). Behavior that is suboptimal but
   deliberate is NOT a verdict-context bug; it is a candidate for a
   design-revision ADR in a future cycle.

The BE@PT1 silent no-op meets all four criteria: it is in shared
management infrastructure (#1); the counterfactual shows 50%+ PnL impact
(#2); it was unknown at Phase 5 closure (#3); the `trigger: 'after_pt1'`
profile declaration documents the intent that the buggy behavior violates
(#4).

Bugs that do NOT meet the definition (e.g., logging issues, validation
warnings that don't affect metrics, strategy-specific code defects)
follow other paths: regular bug-fix tickets, or CF-41 new-strategy-id
work for strategy-specific corrections.

### LD-024-2: Authority to invoke the re-derivation protocol

Invocation requires **joint coordinator + operator agreement**. Neither
unilaterally.

The agreement is documented in a re-derivation invocation memo at
`docs/research/qfa-611-cycleN-rederivation-invocation-memo.md`
(where N is the cycle being re-derived). The memo identifies:

- The specific bug (with file:line citation if applicable).
- The four-criteria verification per LD-024-1.
- The decision: invoke (Path A), defer with documentation (Path B), or
  proceed without re-derivation while accepting context gap (Path C).
- The signing operator + coordinator (this project: the human operator
  and the Claude coordinator session).

The memo is committed to `main` as the authorization artifact before any
implementation work begins.

### LD-024-3: Response protocol (four-step sequence)

When the re-derivation protocol is invoked, the response is strictly
sequential:

**Step 1 — Fix the bug**. Land an infrastructure-fix ticket (suggested
name: `QFA-MGMT-BUG-FIX-01` for the precipitating instance; numbering
continues from there for future instances). The fix:
- Targets the shared infrastructure only. Does NOT modify strategy YAMLs,
  parameter-lock hashes, regime substrate, or any strategy-specific code.
- Adds unit-test coverage for the previously-uncovered failure mode.
- References ADR-0024 + LD-024-N in its commit message and PR
  description.

**Step 2 — Re-derive the verdict**. Re-run the affected cycle's inference
layer against the fixed engine for ALL strategies in the cycle's roster
(not just the ADVANCEd strategy). This is essential because the bug
affects shared infrastructure: previously-REJECTed strategies may now
pass, and previously-ADVANCEd strategies may now reject. The
re-derivation ticket (suggested name:
`QFA-611-CYCLEN-REDERIVATION-NN`) produces:

- Updated held-out-validation JSON for every strategy in the roster.
- Updated `strategy-selection-vN.json` with new verdict hash.
- A re-derivation memo at
  `docs/research/qfa-611-cycleN-rederivation-memo.md` documenting the
  delta from prior verdicts, with explicit before/after threshold tables.

**Step 3 — Reconcile the closure**. Amend the original Phase-N closure
memo (`docs/research/qfa-611-cycleN-closure-memo.md`) with a clearly-marked
"Re-derivation amendment" section that cross-references the new
verdict file and the re-derivation memo. The original closure memo
content is preserved verbatim above the amendment for audit lineage.

**Step 4 — Verdict reconciliation decision**. Coordinator + operator
review the re-derived verdicts and decide whether downstream dispatches
(broker integration, paper trading, etc.) proceed with the original
verdict context or the new verdict context. The reconciliation decision
is documented in the re-derivation memo. Three outcomes are possible:

- **Verdict unchanged**: original strategy still ADVANCEs under fixed
  engine. Downstream work proceeds with the same strategy_id + parameter
  lock; the re-derivation memo notes the verdict is preserved.
- **Verdict-set changed but original ADVANCE preserved**: original
  strategy still ADVANCEs; one or more previously-REJECTed strategies
  may now also pass. Decision: do we widen the active roster, defer the
  newly-passing strategies to future cycles, or treat them as
  research-further candidates?
- **Verdict-set changed AND original ADVANCE displaced**: previously
  ADVANCEd strategy now fails under fixed engine. Material policy
  decision. Downstream dispatches (broker work, paper trading) halt
  until the new verdict set is processed per ADR-0016. The re-derivation
  memo documents this as the outcome.

### LD-024-4: What re-derivation does NOT do

Re-derivation is bounded. It does NOT:

- Modify any strategy's YAML (`config/strategies/*.yaml`). Parameter
  locks remain at their original hashes.
- Modify any strategy's TypeScript code in
  `apps/strategy_runtime/src/strategies/`.
- Modify the regime substrate, MBO action taxonomy, capability mask,
  or any frozen ADR-0013 / ADR-0014 / ADR-0015 surface.
- Modify the ADR-0016 thresholds (Sharpe, DSR, PSR, PF, trade count,
  drawdown, hurdle, regime trades, sensitivity audit).
- Modify the ADR-0023 SignedShockMeasurement canonical fields or the
  anti-pattern lock.
- Generate new strategy_ids. If a fix reveals that a strategy's edge was
  partly engine-bug-dependent, the strategy_id stays the same; the
  re-derivation simply produces a new verdict number for the same
  strategy_id.
- Permit selective re-running of only the "interesting" strategies. The
  full cycle roster is re-derived together to preserve the
  effective_trial_count + DSR penalty integrity (ADR-0023 + Bailey/López
  de Prado per-cycle independent-selection-round principle).
- Re-open the cycle for new hypotheses. CF-41 still applies: new
  hypotheses require new strategy_ids in future cycles.

### LD-024-5: When the protocol does NOT apply

The re-derivation protocol does NOT apply to:

- **Cosmetic bugs**: logging output, console formatting, journal-field
  ordering, error-message phrasing. These do not affect verdict metrics.
- **Validation bugs**: schema-validator false positives/negatives that
  don't change runtime behavior beyond the validator's output.
- **Test-only bugs**: defects in test fixtures or test harnesses that
  don't affect production code paths.
- **Strategy-specific bugs**: defects in
  `apps/strategy_runtime/src/strategies/<strategy_id>.ts` files. These
  fall under CF-41 (new hypothesis = new strategy_id). The buggy version
  goes to REGISTERED_INACTIVE; a new strategy_id is required for any
  correction.
- **Future-cycle-only bugs**: bugs in code that did not exist at the
  time of the cycle's verdict (e.g., a bug introduced in QFA-635 cannot
  affect the Phase 5 Cycle3 verdict because QFA-635 post-dated it).
- **Operator-acknowledged design choices**: behavior that was known at
  verdict time, even if suboptimal. These become candidates for future
  cycle hypotheses, not re-derivation.

When in doubt, default to "does not apply" — re-derivation is a
heavyweight protocol that should be invoked only when the four LD-024-1
criteria are clearly met.

### LD-024-6: Default response timing — coordinator decides per-instance

When a verdict-context bug is discovered after paper trading has begun
(but before live promotion), the response timing is **decided by the
coordinator per-instance**. Three options:

- **Immediate halt**: pause paper trading immediately, fix, re-derive,
  resume against the fixed engine. Cost: paper observation window is
  reset (the days against the buggy engine are not counted toward CF-52).
- **Document + defer**: paper trading continues against the buggy
  engine, matching verdict context. The fix lands after paper
  observation completes. Operator-acknowledged that paper PnL reflects
  the buggy engine, not the corrected one.
- **Hybrid**: fix lands during paper observation; re-derivation
  documents the engine-change as a paper-window discontinuity. CF-52's
  ≥45-day clock either resets or splits into pre-fix + post-fix
  sub-windows per coordinator decision.

The trade-offs depend on:
- Severity of the bug (how much PnL or correctness impact).
- Time-to-fix (hours, days, weeks).
- Time-into-paper-observation (early vs late).
- Operational context (live-promotion proximity).

ADR-0024 does NOT pre-commit to one path. Per-instance coordinator
judgment captures the operational reality.

### LD-024-7: Backward applicability — current and future only

ADR-0024 applies to:

- The current BE@PT1 instance (the precipitating event for this ADR).
- Any future instance of a verdict-context bug discovered after this ADR
  is committed.

ADR-0024 does NOT apply retroactively to:

- Any Phase 5 closure decisions made prior to 2026-05-22 (the ADR
  commit date).
- Any past verdict that has not been challenged by a documented
  verdict-context bug finding.
- Cycle1 or Cycle2 strategies that are in REGISTERED_INACTIVE status;
  those verdicts are sealed.

This bounds the ADR's scope. Past verdicts that may have been affected
by yet-undiscovered bugs are not subject to re-derivation under this
ADR — unless a bug is later discovered and meets the LD-024-1 criteria,
in which case the protocol applies to the new discovery.

## What ADR-0024 does NOT do

- Does NOT relax CF-30 (anti-tuning on locked YAMLs).
- Does NOT relax CF-41 (new hypothesis = new strategy_id).
- Does NOT relax CF-44 (no near-miss tuning).
- Does NOT modify CF-45 (threshold revisions require external
  justification).
- Does NOT modify ADR-0016 thresholds.
- Does NOT modify ADR-0023 anti-pattern lock or SignedShockMeasurement
  fields.
- Does NOT modify ADR-0018 / ADR-0018-A1 broker chain.
- Does NOT modify ADR-0020 latency SLA policy.
- Does NOT introduce a parameter-tuning loophole. The protocol is
  bounded to shared infrastructure fixes that materially affect
  verdicts; it cannot be used to relitigate strategy-specific
  outcomes.
- Does NOT authorize unilateral coordinator or operator action; joint
  agreement is required per LD-024-2.

## Consequences

ADR-0024 dispatches the following implementation chain to address the
precipitating BE@PT1 instance:

| Order | Ticket / Artifact | Scope |
|---|---|---|
| 1 | **QFA-611-CYCLE3-REDERIVATION-INVOCATION-MEMO** | Coordinator + operator joint invocation memo per LD-024-2. Documents the four-criteria verification + Path A selection. Single commit to main; no PR needed (just a research artifact). |
| 2 | **QFA-MGMT-BUG-FIX-01** | Implements the BE@PT1 fix per operator's Option 1 (pt1_touched flag + targets-before-stop on combined-bar). Shared infrastructure; non-strategy-specific. Per LD-024-3 Step 1. |
| 3 | **QFA-611-CYCLE3-REDERIVATION-01** | Re-runs inference layer for all 3 Cycle3 strategies against the fixed engine. Produces updated held-out-validation JSONs + `strategy-selection-v3.json` + re-derivation memo at `docs/research/qfa-611-cycle3-rederivation-memo.md`. Amends `docs/research/qfa-611-cycle3-closure-memo.md` with the re-derivation section. Per LD-024-3 Steps 2-3. |
| 4 | **Verdict reconciliation decision** | Coordinator + operator review re-derived verdicts. Decision documented in the re-derivation memo. Per LD-024-3 Step 4. |
| 5 | **Downstream dispatches resume or revise** | If verdict-set unchanged: QFA-612-BROKER-03 dispatches with original allowlist + LUCIDFLEX scope. If verdict-set changed: dispatch chain revised. |

The Apr 1-8 regime-pinning finding (regime classifier sustained `high`
classification through directional trends, producing MFE/MAE collapse to
0.98) is documented separately as a **research finding for Cycle4 hypothesis
generation**, NOT as a verdict-context bug. The regime classifier's behavior
on sustained trends is a strategy-level edge limit, not an
infrastructure bug. Mitigation (regime-persistence cooldown or
second-factor vol/trend gate) would be a new strategy_id in a future
cycle per CF-41.

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Re-derivation reveals previously-REJECTed strategy now passes | Medium | LD-024-3 Step 4 explicitly contemplates this; coordinator decides whether to widen active roster, defer, or treat as research-further |
| Re-derivation reveals previously-ADVANCEd strategy now fails | High | LD-024-3 Step 4 halts downstream dispatches in this case; the new verdict set is processed per ADR-0016 before any broker work proceeds |
| Protocol becomes a precedent for re-litigating strategy outcomes | High | LD-024-1 four-criteria definition + LD-024-4 explicit non-scope + LD-024-5 explicit non-applicability collectively prevent this. The protocol is narrow by construction |
| Future operator invokes protocol unilaterally without coordinator agreement | Medium | LD-024-2 requires joint agreement documented in invocation memo; commit-to-main lineage is the audit trail |
| Multiple post-verdict bug discoveries cascade across cycles | Medium | Each invocation is its own memo + ticket chain; the protocol is per-instance, not bulk |
| BE@PT1 fix interacts with other engine behaviors not anticipated | Medium | LD-024-3 Step 1 requires unit-test coverage for the previously-uncovered failure mode; QFA-MGMT-BUG-FIX-01's PR review surfaces any unintended interactions |
| Apr 1-8 regime pinning incorrectly classified as bug rather than research finding | Low | Explicit Consequences-section documentation that this is a Cycle4 hypothesis candidate, not a re-derivation trigger |
| Coordinator + operator agree to invoke when criteria are weak | Low | LD-024-1 four criteria are explicit and falsifiable; protocol invocation memo documents the verification |

## References

- ADR-0013 / ADR-0014 / ADR-0015 (regime substrate; preserved through
  re-derivation)
- ADR-0016 (alpha decision criteria; thresholds re-applied during
  re-derivation, not modified)
- ADR-0018 / ADR-0018-A1 (broker integration; QFA-612-BROKER-03
  dispatch paused pending re-derivation)
- ADR-0020 (latency SLA + SLO policy; unaffected)
- ADR-0023 (Cycle3 SignedShockMeasurement + anti-pattern lock;
  preserved through re-derivation)
- `docs/research/qfa-611-cycle3-closure-memo.md` (Phase 5 closure;
  to be amended per LD-024-3 Step 3)
- `docs/research/qfa-611-cycle3-strategy-selection.md` (Cycle3 strategy
  selection)
- `artifacts/strategy-selection/strategy-selection-v3.json` (verdict
  file; to be regenerated per LD-024-3 Step 2)
- `artifacts/held-out-validation/cycle3/*.json` (per-strategy validation
  artifacts; to be regenerated per LD-024-3 Step 2)
- `apps/strategy_runtime/src/management/position-manager/index.ts`
  (FSM evaluation order)
- `apps/strategy_runtime/src/management/stops.ts` (stop evaluation +
  closePosition cancellation of pending targets)
- `apps/strategy_runtime/src/management/targets.ts` (target evaluation)
- `apps/strategy_runtime/src/management/management-profiles.ts`
  (BASE_BREAK_EVEN profile declaration: `trigger: 'after_pt1',
  offset_ticks: 1`)
- `apps/strategy_runtime/tests/unit/position-manager.test.ts`
  (existing tests; combined-bar case to be added per QFA-MGMT-BUG-FIX-01)
- CF-30 / CF-41 / CF-44 (anti-tuning carry-forwards; bounded by this
  ADR but not modified)
- CF-45 (ADR threshold revisions require external methodological
  justification; analogous principle applies to verdict re-derivations)
- CF-52 (paper-observation window; LD-024-6 timing decision interacts
  with this)

## Voting record

Single coordinator decision following structured analytical work:

1. **Trigger**: operator-driven analysis (2026-05-22) identified the
   BE@PT1 bug + Apr 1-8 regime-pinning finding via combination of
   independent code-trace + held-out-validation session distribution
   analysis.
2. **Three paths considered**: (A) Fix-and-rederive, (B)
   Defer-and-document, (C) Fix-and-proceed-without-rederivation.
3. **Path A selected** for methodological cleanness despite the
   wall-clock cost. Rationale documented in this ADR's Context section.
4. **Seven locked decisions LD-024-1 through LD-024-7** establish the
   protocol's scope, authority, sequence, non-scope, non-applicability,
   timing, and applicability boundaries.
5. **Three open coordinator decisions confirmed** prior to drafting:
   - Authority: coordinator + operator joint (LD-024-2).
   - Timing: coordinator decides per-instance (LD-024-6).
   - Backward applicability: current + future only (LD-024-7).

Coordinator additions to the initial proposal:

- Material-effect operational definition (LD-024-1, criterion #2):
  ≥ 10% metric shift, threshold flip, or verdict change.
- Re-derivation must include ALL strategies in the cycle's roster, not
  just the ADVANCEd strategy (LD-024-4). Otherwise the
  effective_trial_count + DSR penalty integrity collapses.
- Original closure memo preserved verbatim above the re-derivation
  amendment (LD-024-3 Step 3). Audit lineage matters.
- Apr 1-8 finding explicitly NOT a re-derivation trigger;
  documented as Cycle4 research candidate (Consequences section).

## Amendments

(None at acceptance. Future amendments listed here as ADR-0024-A1,
A2, etc., if the protocol itself needs refinement. Specific protocol
invocations are documented per LD-024-2 in invocation memos under
`docs/research/`, not as ADR amendments.)
