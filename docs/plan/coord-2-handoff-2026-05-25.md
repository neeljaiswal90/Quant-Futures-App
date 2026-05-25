# Peer-Coordinator (Coord-2) Handoff — 2026-05-25

This document transfers the **peer-coordinator (coord-2) review role** from the retiring Claude session to the incoming Codex peer-coord. The dispatching coordinator (coord-1, current Claude session) remains in place. This handoff covers only what coord-2 needs to operate; it does NOT replace the dispatching-coord-side handoff at `docs/plan/coordinator-handoff-2026-05-24.md`.

This document is self-contained. Do not assume any session memory from prior conversations or any context from the prior peer-coord. Everything you need is here.

---

## 1. What you're inheriting — role definition

You are **coord-2** (peer reviewer) in a two-coord protocol. Coord-1 (current Claude session) is the dispatching coordinator who drafts packets, writes ADRs, opens PRs, and coordinates workers. Your role is **independent verification + bidirectional surfacing**.

Specifically:

| Stage | Coord-1 action | Coord-2 (your) action |
|---|---|---|
| Packet drafting | Drafts dispatch packet | Reviews for scope, semantic precision, escalation triggers; surfaces blockers BEFORE dispatch |
| ADR drafting | Drafts ADR | Reviews structural soundness + content-level diff verification |
| Worker dispatch | Pastes packet to worker session | (informational; no action) |
| Worker PENDING-REVIEW | Reviews worker's Step 7 report + diff | Independent review of same Step 7 report + diff; cross-confirms or surfaces blockers |
| PR open authorization | Both coords must approve via STATE markers | Both coords must approve via STATE markers |
| Post-PR review | Verifies CI green + diff matches packet | Independent CI verification + content review |
| Merge | Operator merges after dual-coord READY-FOR-PR + operator countersign | (informational; no action) |

**Bidirectional review pattern:** if you find a different concern than coord-1, surface it on the PR (or in the dialog if pre-PR), not via cross-coord side-channel. The value of dual review comes from independent surfacing.

You may also **draft your own dispatch packets** for tickets on your track (see §7 — MOC chain is currently the peer-coord track). When you dispatch, coord-1 becomes your reviewer; the protocol is symmetric.

---

## 2. Current project state snapshot (as of 2026-05-25)

### Active strategies — SIGNIFICANTLY CHANGED FROM ORIGINAL HANDOFF

The `docs/plan/coordinator-handoff-2026-05-24.md` doc shows 3 ACTIVE strategies (all Phase 5 ADVANCE_TO_PAPER). **That state is now obsolete.** QFA-611-CYCLE3-REDERIVATION-02 (PR #244 ADR-0027 chain) discovered all 3 strategies fail under the corrected management runtime:

| strategy_id | Pre-REDERIVATION-02 verdict | Post-REDERIVATION-02 verdict | Track B status |
|---|---|---|---|
| `regime_shock_reversion_short_v2` | ADVANCE_TO_PAPER | **REJECT** | both coords ACCEPT |
| `vwap_overnight_reversal_long` | (already REJECT post-REDERIVATION-01) | REJECT (UNCHANGED) | both coords ACCEPT |
| `vwap_overnight_reversal_short` | (already REJECT post-REDERIVATION-01) | REJECT (UNCHANGED) | both coords ACCEPT |

**`ACTIVE_STRATEGY_IDS` in [apps/strategy_runtime/src/contracts/strategy-ids.ts](apps/strategy_runtime/src/contracts/strategy-ids.ts) is now out-of-sync with verdict reality.** It still lists all 3 strategies as active. STRATEGY-IDS-RECONCILE-01 (see §8) is the planned cleanup.

**QFA-612-BROKER-03 paper observation is NOT authorized.** No surviving ADVANCE_TO_PAPER candidate. The broker integration substrate work remains relevant for future Cycle4 dispatches but no current strategy to execute.

### Registered-inactive strategies (Cycle4 hypothesis chain)

- `regime_shock_reversion_short_v3` — VIX-gate variant (Cycle4 hypothesis; REGISTERED_INACTIVE per Cycle3 closure-memo B-full amendment)
- (Future) v4-delay / v4-persist — hold-time entry gate hypotheses; depend on CYCLE4-S2 stateful producer (merged at `ea3a2ea`)
- (Future) v5_strict_deadline / v5_be_at_deadline / v5_trail_at_deadline — management-axis variants; authorized by ADR-0027 (merged at `0ba6a48`)

None of these are ACTIVE. Promotion requires formal Cycle4 cycle, not the B-full hypothesis chain.

### Main HEAD lineage (most recent)

```
0ba6a48 ADR-0027: deadline-extension management semantics (#244)
ddf6ceb MOC-LO-COUNTERFACTUAL: long-only buy-only recompute on R3 data (#243)  ← MOC chain (former peer-coord track)
6de6911 PROCESS-02: amend engineer-dispatch-prompt.md (CI-gate + monorepo test sweep) (#242)
41beaaf QFA-611-CYCLE3-REDERIVATION-02: invocation memo (ADR-0024 LD-024-2) (#241)
d1d7461 MGMT-BUG-FIX-02: enforce fail-safe and time-stop parameters at runtime (#240)
ea3a2ea CYCLE4-S2: add signed_shock arm state to StrategyFeatureSnapshotContext (#236)
eaf0b48 MOC-R5: build conditioning analysis (#235)
c3073fd docs: errata to CYCLE4-R2 memo — v4-delay schema requirement (#234)
b6b184d MOC-R4: build hit-curve + expectancy heatmaps (#233)
```

You will see additional commits past `0ba6a48` if any landed during your handoff transition. Always `git fetch origin main` + `git log origin/main --oneline -10` on first session.

---

## 3. Coord-coord protocol you're inheriting

### PROCESS-02 (canonical in `docs/plan/engineer-dispatch-prompt.md` since merge `6de6911`)

Locked discipline:

| Discipline | Why |
|---|---|
| Worker runs FULL monorepo `npx vitest run` (no path filter) before reporting PENDING-REVIEW | PR #240 worker ran only `apps/strategy_runtime/tests/` and missed three backtester regressions; CI caught them |
| Worker runs `npx tsc -b tsconfig.json` (NOT `--noEmit`) | PR #232 (CYCLE4-V3-IMPL) CI-failed on cross-workspace type error that `--noEmit` doesn't catch |
| **Coordinator MUST verify `gh pr checks <PR#>` is SUCCESS before issuing READY-FOR-PR** | PR #240 first review round (coord-1) missed CI status; coord-2 (former peer-coord) caught via independent verification, surfacing three backtester regressions hidden by the worker's local report |
| Dual-coord independent review | Catches different concerns; surface on PR not side-channel |

### PROCESS-02-A1 (pending; not yet merged — peer-coord-2 should pick this up if time permits)

The former peer-coord observed: docs-only PRs (ADRs, research memos, dispatch packets) opened directly as ready-for-review technically skip the strict "open as draft → CI green → un-draft → merge" pattern. PR #244 (ADR-0027) was a clean example — defensible but procedurally non-canonical. PROCESS-02-A1 would extend PROCESS-02 to explicitly cover docs-only PRs with the draft-first pattern.

**Status:** small micro-PR; can sibling with QFA-MGMT-WIRING-TEST-01 (see §6). NOT urgent; awaiting routing.

### STATE markers (use these in your responses)

Standard state lines you'll emit or see:

- `STATE: STANDING-BY` — no active coord work; awaiting trigger
- `STATE: READING` — gathering context (rare for coord-2; mostly worker)
- `STATE: REVIEWING` — actively reviewing a worker PENDING-REVIEW report or PR diff
- `STATE: COORD-2-APPROVED-FOR-DRAFT-PR` — your sign-off on worker reaching PENDING-REVIEW; PR open authorized
- `STATE: COORD-2-APPROVED-FOR-SIGN-OFF` — your final sign-off on an ADR or invocation memo
- `STATE: CHANGES-REQUESTED` — substantive blockers identified; revisions needed before sign-off
- `STATE: COORD-2-CONCUR-STRUCTURAL-PENDING-CONTENT-REVIEW` — partial concur; content review still owed (used when ADR is in worktree only, not yet on branch)
- `STATE: ESCALATING` — STOP condition met; awaiting operator decision

Coord-1 uses parallel `COORD-1-*` variants. Operator uses `STATE: MERGED`, `STATE: APPROVED`, etc.

### The "trust but verify" pattern

When coord-1 reports something (e.g., "all checks pass"), independently verify what you can. The PR #240 first-round CI miss was coord-1's. Independent verification is the protocol's load-bearing value. You are NOT a rubber stamp.

---

## 4. In-flight work right now (your immediate triage)

Three items are active. None are blocked on you specifically — but you should review them on first session to confirm coord-1's framing and decide if you have concerns.

### 4.1 REDERIVATION-02 Track B (worker holds for push authorization)

**Status:** Worker reported `STATE: PENDING-REVIEW` on the corrected 3-strategy Cycle3 roster re-run. Both coords approved at PENDING-REVIEW for draft-PR-open. **Worker is holding for operator authorization to push and open the draft PR.**

**Files in scope:**
- `artifacts/held-out-validation/cycle3/regime_shock_reversion_short_v2-feb-mar-apr-2026.json`
- `artifacts/held-out-validation/cycle3/vwap_overnight_reversal_long-feb-mar-apr-2026.json`
- `artifacts/held-out-validation/cycle3/vwap_overnight_reversal_short-feb-mar-apr-2026.json`
- `artifacts/strategy-selection/strategy-selection-v4.json`
- `docs/research/qfa-611-cycle3-rederivation-02-memo.md` (created)
- `docs/research/qfa-611-cycle3-closure-memo.md` (amended — REDERIVATION-02 section appended)

**Verdict:** all 3 → REJECT (per §2 above). Coord-1 substantive recommendation: ACCEPT verdicts. Former coord-2 concur on record.

**Your action when worker pushes + opens draft PR:** independent CI verification + diff-level review per PROCESS-02. Your specific re-verifications (use these as your checklist):
1. CI is SUCCESS via `gh pr checks <PR#>`
2. v3 NOT committed (should be in `scratch/diagnostic/` only, off-tree)
3. `effective_trial_count = 3` in strategy-selection-v4.json
4. `final_chain_hash` CHANGED, `final_phase2_hash` + `final_phase4_hash` PINNED
5. Closure memo amendment is PURELY APPENDED (REDERIVATION-01 section preserved verbatim per ADR-0024 LD-024-3 Step 3)
6. No `.tmp` files committed
7. Strategy fingerprints: artifact-internal `strategy_fingerprint_sha256` field CHANGED (because artifact content changed); decision-level fingerprints (from `apps/backtester/src/strategy-fingerprint/strategy-fingerprint.ts`) PINNED. These are TWO DIFFERENT hash surfaces; field-name collision is real but not contradictory.

**Operator items pending:**
1. Authorize worker to push (worker holds)
2. Operator countersign on ACCEPT verdict reconciliation per ADR-0024 LD-024-3 Step 4 (joint per LD-024-2)
3. Operator merge after dual-coord READY-FOR-PR (post-push)

### 4.2 QFA-MGMT-WIRING-TEST-01 (packet drafted; awaiting peer-coord scope review)

**Status:** Coord-1 drafted dispatch packet at `docs/plan/qfa-mgmt-wiring-test-01-dispatch-packet.md`. **Awaiting peer-coord-2 (your) scope review BEFORE coord-1 pastes to worker session.**

**Purpose:** systematic test discipline that asserts every declared management profile parameter is actually consulted at runtime. Two consecutive ADR-0024 invocations in three weeks (PR #215 BE@PT1 silent no-op, PR #240 fail-safe/time-stop quartet unenforced) are the same bug class. This ticket installs a manifest-based wiring test that catches the class at the test-discovery layer before any future declared-but-unenforced parameter can ship.

**Design approach:** manifest-based assertion (rejected reflective TS AST introspection as fragile). Manifest entries `{ field_path → consulting_evaluator(s) }`; test pack iterates; per-field consultation tests construct two scenarios differing only in field value and assert FSM behavior differs.

**Locked decisions LD-WT-1 through LD-WT-6** in the packet. Key invariants:
- LD-WT-3: reserved-for-pending-implementation marker for ADR-0027's `at_deadline_extension` (declared but not yet implemented)
- LD-WT-6: if wiring test reveals a third instance of the bug class, STOP and escalate; new ADR-0024 invocation (REDERIVATION-03), NOT silent fix

**Your action:**
1. Read `docs/plan/qfa-mgmt-wiring-test-01-dispatch-packet.md` end-to-end
2. Verify scope (especially LD-WT-3 reserved-field handling for ADR-0027's `at_deadline_extension`)
3. Concur on the pre-populated manifest entries (23 entries listed; covers PR #215 + PR #240 + ADR-0027 reserved field)
4. Flag any escalation triggers worth adding
5. Issue `STATE: COORD-2-APPROVED-FOR-WORKER-DISPATCH` or `STATE: CHANGES-REQUESTED` per your review

**Downstream:** wiring-test PR merge UNBLOCKS MGMT-DEADLINE-EXTENSION-01 dispatch (per dual-coord priority recommendation that the wiring discipline land before adding three new management dispatch branches via ADR-0027).

### 4.3 STRATEGY-IDS-RECONCILE-01 (pending discovery)

**Status:** awaiting ~30-min discovery before dispatch. Question: does the codebase tolerate `ACTIVE_STRATEGY_IDS = []`?

**Background:** post-ACCEPT on REDERIVATION-02 verdicts, all 3 currently-active strategies demote to REGISTERED_INACTIVE. If various runner scripts assume at least one active strategy, an empty array could break.

**Discovery scope:** grep `ACTIVE_STRATEGY_IDS` usage across `apps/strategy_runtime/src/` and `apps/backtester/src/` and `scripts/`. Identify any consumer that would break on empty set. Decide between (a) keep one strategy in ACTIVE as deprecated placeholder, (b) update consumers to tolerate empty, or (c) skip cleanup until Cycle4 produces a replacement.

**Either coord can do the discovery.** Operator should route. If you have spare cycles between active reviews, this is a useful pickup.

---

## 5. ADR landscape and bindings (what you must respect in reviews)

The original handoff at §4 enumerates 7 ADRs. Two new ones are critical post-handoff:

| ADR | Subject | Why it matters to coord-2 |
|---|---|---|
| ADR-0023 | Cycle3 SignedShockMeasurement + anti-pattern lock | **Anti-pattern #4 (fail-closed on missing features) is load-bearing.** Both REDERIVATION invocations were anti-pattern #4 violations (declared but not consulted). Any review where you see "this could silently default" should trigger STOP. |
| ADR-0024 | Post-verdict bug re-derivation protocol | **Two invocations in three weeks.** LD-024-1 four-criteria definition is the gate. LD-024-2 joint sign-off is the authority. LD-024-3 Step 4 verdict reconciliation is operator + dual-coord. You'll see this protocol live during REDERIVATION-02 Track B close. |
| **ADR-0027** | **Deadline-extension management semantics (NEW, merged at `0ba6a48`)** | Authorizes 3 new management dispatch modes (`'move_to_be'`, `'activate_trail'`, `'unconditional_exit'`) on a new `time_stop.at_deadline_extension` enum. Default `'enforce_floor'` preserves current runtime. 10 LDs locked. Implementation chain: MGMT-DEADLINE-EXTENSION-01 → STRAT-V5-DEADLINE-VARIANTS-01 → CYCLE4-V5-INFERENCE-NN. ALL gated on QFA-MGMT-WIRING-TEST-01 landing first. |

### Carry-forwards you cannot let slip in any review

| CF | Rule | Coord-2 relevance |
|---|---|---|
| CF-30 | No parameter tune on locked YAML without new ADR | If you see any PR that touches `config/strategies/*.yaml` for non-comment changes, STOP and escalate |
| CF-41 | New hypothesis = new strategy_id | If you see a "let's just adjust v2 slightly" framing, this is the CF |
| CF-44 | No near-miss tuning | Especially relevant after REDERIVATION-02: do NOT let any v5 variant get tuned to recover v2's verdict. New strategy_ids only. |
| CF-45 | Threshold revisions require external methodological justification | ADR-0016 thresholds are NOT to be modified |
| CF-52 | Paper observation floor ≥45-60 sessions | Doesn't apply right now (no surviving ADVANCE candidate); will re-apply when Cycle4 produces one |

### LD-023 anti-pattern #4 (load-bearing)

Strategies and runtime evaluators MUST fail-closed on missing context fields. If you see code that silently defaults, this is the anti-pattern. Both REDERIVATION invocations were instances. The QFA-MGMT-WIRING-TEST-01 ticket (§4.2) is the systemic discipline to catch this class at the test layer.

---

## 6. Decision history you should know (recent multi-round dialogues)

### MGMT-BUG-FIX-02 → REDERIVATION-02 → ADR-0027 chain

This is the load-bearing chain of the past 48 hours. Summary:

1. **2026-05-24 — Strategy research brief #3** surfaced that the fail-safe and time-stop runtime evaluators don't enforce four declared profile parameters (`max_adverse_r`, `max_spread_ticks`, `pre_pt1_min_unrealized_r`, `post_pt1_min_unrealized_r`).
2. **Coord-1 verified the finding** independently against `origin/main` (parameters declared in types, parsed by config-parser, defaulted in BASE_*, validated, carried onto position state — but never read by runtime).
3. **MGMT-BUG-FIX-02 (PR #240)** — coord-1 drafted dispatch packet; **former peer-coord ran 4 rounds of review** identifying:
   - Round 1: silent-skip bid/ask policy (operator's spec called for mode-dependent; coord-1 drifted)
   - Round 2: missing `enabled` gate (configurable behaviors must respect `position.fail_safe.enabled`)
   - Round 3: 4 blockers (held-reason naming §0/§7 conflict, runner.test.ts scope gap, grep audit missing, profile vs position source-of-truth)
   - Round 4: 2 minor (trigger lines + Step 7 numbering cleanup)
4. **PR #240 first review:** coord-1 reviewed diff content + worker local test report, **missed CI status check**. Former peer-coord caught via independent CI verification — 3 backtester regressions. Continuation fix landed; CI green; merge at `d1d7461`.
5. **REDERIVATION-02 invocation memo (PR #241 at `41beaaf`)** — joint coord+operator authorization per ADR-0024 LD-024-2.
6. **REDERIVATION-02 Track B:** corrected 3-strategy roster (v3 over-scoped in my original packet was a coord-1 packet defect; former peer-coord and operator agreed to correct via continuation packet). Worker re-ran inference; all 3 strategies REJECT.
7. **ADR-0027 (PR #244 at `0ba6a48`)** — operator proposed three options to address v2's weakness; coord-1 designed a single `at_deadline_extension` enum to cover all three. Former peer-coord did structural review then content review (10-item checklist). Round-2 added 10 amendments including the canonical mode table, dispatch pseudocode, no-widening invariants, BE state mutation, trail initialization, parser validation, hash-drift mitigation, and 18 D-prefix test pack. Single-line REDERIVATION-02 invocation cite added per former peer-coord route A. CI green; dual coord approved; operator merged.

The lesson encoded across this chain: **the bug was masking a real strategy weakness; the fix reveals reality; verdicts reflect actual behavior under declared management semantics; CF-30/CF-41 prohibit tuning to recover.**

### PROCESS-02 (PR #242 at `6de6911`)

Created by coord-1 in response to former peer-coord's discipline observation post the PR #240 CI miss. Two amendments to `docs/plan/engineer-dispatch-prompt.md`:
- §3 Step 6: mandatory full monorepo `npx vitest run` (no path filter); `tsc -b` over `--noEmit`
- §3 Step 8: mandatory coord-side `gh pr checks` verification before READY-FOR-PR

Now canonical for all worker dispatches. Both coords inherit this discipline; you're expected to apply it.

### CYCLE4-S2 (PR #236 at `ea3a2ea`)

Schema-only addition of `signed_shock arm state` to `StrategyFeatureSnapshotContext`. Adds the threshold-cross timestamp + consecutive-bar counter primitives needed for v4-delay / v4-persist hypotheses. Coord-1 had drafted a larger Option-B feature-memory manifest design (`docs/research/snapshot-state-and-memory-audit.md` — coord-1 worktree, untracked); PR #236 is a narrower-but-sufficient cut that delivers exactly what v4 needs. ADR-0025 broader manifest was deferred to P0c "revisit when a second distinct memory primitive forces generalization."

---

## 7. Your specific track items (MOC chain inherited from former peer-coord)

The former peer-coord was on the MOC research chain in parallel to the management track. **You inherit this track unless operator routes otherwise.**

### MOC chain status

| Item | Status |
|---|---|
| MOC-R1 (event-day manifest) | merged |
| MOC-R2 (per-event price-path extractor) | merged |
| MOC-R3 (trigger-conditional simulator) | merged |
| MOC-R4 (hit-curve + expectancy heatmaps) | merged |
| MOC-R5 (conditioning analysis) | merged at `eaf0b48` |
| **MOC-LO-COUNTERFACTUAL** (long-only buy-only recompute on R3 data) | **merged at `ddf6ceb`** (former peer-coord's last landed item) |
| MOC-R6 / MOC-R7 | per the original handoff §11, the Plan A research stack extends to R7; R6/R7 have not been discussed in detail. Former peer-coord noted MOC-LO-COUNTERFACTUAL "remains ready on my side; independent of [the management] thread." |

### MOC research plans

Two research plans (operator-side, target-state repo-tracked):
- Plan A: descriptive research scope
- Plan B: full strategy build scope

The current MOC chain is Plan A. If you continue the MOC track, MOC-R6 + R7 are the natural next items. Operator should specify whether to continue MOC research, switch your focus entirely to the management track (coord-1's primary track), or pause MOC pending a different priority.

### IMPORTANT: MOC chain is NOT contaminated by the management bug

Coord-1 originally over-asserted that MOC findings might need a footnote post-REDERIVATION-02. Former peer-coord corrected this: MOC R1-R5 (and any R6+) operate on raw market data + Plan A's synthetic OCO bracket simulator, NOT on v2's management FSM. **MOC research findings are valid regardless of the REDERIVATION-02 verdict outcome.** This was a coord-1 framing error, corrected in `docs/research/strategy-brief-3-coordinator-review.md` (coord-1 worktree, untracked).

---

## 8. Dispatch chain forward (priority order)

Coord-1 maintains the canonical queue. Your role is to scope-review packets and dual-approve at PENDING-REVIEW / READY-FOR-PR. Current priorities:

| Order | Item | Class | Gate |
|---|---|---|---|
| 1 | REDERIVATION-02 Track B PR | worker-already-PENDING-REVIEW | operator authorizes worker push |
| 2 | QFA-MGMT-WIRING-TEST-01 | new worker dispatch | **your scope review pending** (§4.2) |
| 3 | STRATEGY-IDS-RECONCILE-01 | needs ~30-min discovery first | either coord; operator routes |
| 4 | MGMT-DEADLINE-EXTENSION-01 | schema PR per ADR-0027 LD chain | UNBLOCKS after QFA-MGMT-WIRING-TEST-01 merges |
| 5 | STRAT-V5-DEADLINE-VARIANTS-01 | new REGISTERED_INACTIVE v5 variants per operator-strategic count decision | gated on #4 |
| 6 | CYCLE4-V5-INFERENCE-NN | informational inference runs | gated on #5 |
| 7 | PROCESS-02-A1 | docs-only-PR draft-first clarification | can sibling with #2; small micro-PR |
| 8 | Handoff doc amendment | reflects 0 ACTIVE + Cycle4 priority + REDERIVATION-02 chain | gated on Track B merge |
| 9 | QFA-DOC-FSM-LEDGER-MAPPING-01 | docs ticket; FSM-stage-reason → ledger-enum mapping formalization | deferred; either coord on signal |
| 10 | MOC-R6 / R7 (your track) | research items | operator routes; your tempo |

### v5 variant count decision (operator-pending)

ADR-0027 authorizes up to three v5 variants. Coord-1 recommended TWO (`v5_strict_deadline` + `v5_trail_at_deadline` with BE-floor) on the grounds that `v5_trail_at_deadline` with BE-floor weakly dominates `v5_be_at_deadline` for held trades. Operator may include all three if they want analytical decomposition. Operator decision feeds STRAT-V5-DEADLINE-VARIANTS-01 scope.

---

## 9. Architectural notes & gotchas (must-know)

### Two-fingerprint surface (decision-level vs artifact-internal)

The codebase has TWO different hash fields named `strategy_fingerprint_sha256` (or similar):

1. **Decision-level strategy fingerprint** at `apps/backtester/src/strategy-fingerprint/strategy-fingerprint.ts` — hashes canonicalized strategy DECISIONS (candidate generation). PINNED across management runtime changes (decisions are orthogonal to management).
2. **Artifact-internal `strategy_fingerprint_sha256` field** inside held-out-validation JSONs — sha256 of the per-strategy artifact CONTENT (includes trade outcomes). CHANGES when trade outputs shift.

**Field-name collision is real but not contradictory.** Coord-1's MGMT-BUG-FIX-02 PR #240 review framed this incorrectly at first ("strategy fingerprints WILL change"); worker correctly surfaced the discrepancy; coord-1 retracted. You should expect this confusion to recur; just check WHICH surface is being discussed.

### Hash-drift mitigation pattern (ADR-0027 LD precedent)

When a schema change adds a new defaulted field, the field may serialize into existing strategies' artifact snapshots, changing their content hashes even when behavior is unchanged. Three coord-decided options (canonical in ADR-0027 Risk Register):
- (a) omit default fields from serialization
- (b) migrate snapshots with explicit schema-version note
- (c) narrow byte-equal gate to behavior, not serialization

Worker MUST STOP and surface the diff if this happens; coords decide. Do NOT silently update existing-strategy hashes.

### The bug-as-hidden-risk-cap framing (substantive read on REDERIVATION-02)

The pre-fix runtime's unconditional 25-min time-stop was acting as a HIDDEN -0.10R-ish risk cap that the declared `pre_pt1_min_unrealized_r = -0.25` profile field intended NOT to enforce (the profile says: hold past deadline unless below -0.25R). Removing the bug exposes v2's actual held-past-deadline asymmetry (-1R losses vs +1.2R wins at sub-41% hit rate on the held bucket). The bug was BENEFICIAL to v2's apparent performance. The fix reveals reality.

Detailed analysis is in `docs/research/strategy-brief-3-coordinator-review.md` (coord-1 worktree, untracked) and in `docs/research/qfa-611-cycle3-rederivation-02-memo.md` (worker output, pending Track B PR).

### `stopTighter` no-widening invariant (ADR-0027 LD-027-3, LD-027-4)

Any management primitive that moves a stop MUST use side-aware tightening, NOT raw assignment:
```ts
function stopTighter(currentStop, candidateStop, side): number {
  return side === 'long'
    ? Math.max(currentStop, candidateStop)  // long: higher stop is tighter
    : Math.min(currentStop, candidateStop); // short: lower stop is tighter
}
```

The deadline BE action MUST NOT widen an existing stop (e.g., from a prior trail). If you review any PR that modifies stop placement and doesn't use stopTighter, this is a CF.

### FSM ordering (post-fix, per PR #215 + PR #240)

```
fail_safe → markPt1Touched → stop_hit → targets → time_stop → break_even → trailing
```

This order is locked. The original handoff §5 mis-described the FSM order (had `targets → stop` instead of `stop → targets`); coord-1 noted this for amendment. If you see any PR proposing to change FSM order, this needs a new ADR.

### Generalized Kelly (not classic binary Kelly)

Per `docs/research/sizing-r1-post-fix-kelly-tiered-rederivation.md`:
- Classic binary Kelly: 14.92% (ignores variance — NOT the correct reference)
- Generalized log-utility Kelly: **7.89%** (accounts for variance — the correct sizing reference)

Use generalized Kelly. The classic 14.92% number should NOT appear in any dispatched deliverable. Reference: handoff §5.

---

## 10. Verification checklist (first session actions)

Run these in order on your first session:

```bash
# 1. Confirm main HEAD lineage matches §2
git fetch origin main
git log origin/main --oneline -10

# 2. Verify ACTIVE_STRATEGY_IDS state (still inconsistent with verdict reality)
git show origin/main:apps/strategy_runtime/src/contracts/strategy-ids.ts | head -30

# 3. Confirm ADR-0027 on main
git show origin/main:docs/adr/ADR-0027-deadline-extension-management-semantics.md | head -50

# 4. Confirm PROCESS-02 amendments are in canonical dispatch prompt
git show origin/main:docs/plan/engineer-dispatch-prompt.md | grep -A2 "FULL monorepo\|gh pr checks"

# 5. Check open PRs
gh pr list --repo neeljaiswal90/Quant-Futures-App --state open

# 6. Read the live dispatch packet for the work that needs your scope review
git show origin/main:docs/plan/qfa-mgmt-wiring-test-01-dispatch-packet.md
# NOTE: this packet may not be on main yet (coord-1 worktree, untracked).
# If `git show` fails, the packet is in coord-1's worktree; coord-1 will surface
# it when you signal ready for it.

# 7. CI-equivalent compile check (run locally to ground yourself)
npx tsc -b tsconfig.json

# 8. Sanity-run the existing test suite (full monorepo per PROCESS-02)
npx vitest run
```

**Expected results:**
- Step 1: main HEAD at `0ba6a48` or later
- Step 2: 3 strategies still in ACTIVE (out-of-sync with reality; STRATEGY-IDS-RECONCILE-01 will fix)
- Step 3: ADR-0027 visible
- Step 4: PROCESS-02 amendments visible (monorepo vitest + `gh pr checks` language)
- Step 5: REDERIVATION-02 Track B PR may be open (worker pushed after you start); QFA-MGMT-WIRING-TEST-01 may not be on PR yet (awaiting your scope review)
- Step 7: TypeScript compile passes (no syntax errors on main)
- Step 8: Full vitest passes (1909 tests expected per PR #240 baseline)

---

## 11. Authority and sign-off model

| Authority class | Required signers |
|---|---|
| **Worker dispatch packet** | Standard: coord-1 drafts + peer-coord-2 reviews + operator authorizes |
| **Standard ADR sign-off** | Standard: coord-1 drafts + peer-coord-2 reviews content + operator countersigns |
| **ADR-0024 invocation memo** | Joint per LD-024-2: operator + dual-coord (no unilateral) |
| **LD-024-3 Step 4 verdict reconciliation** | Joint: operator + dual-coord on metric tables + verdict deltas |
| **Worker PR open authorization** | Both coords must approve at PENDING-REVIEW; operator approval implicit via packet authorization |
| **Worker PR un-draft / merge** | Both coords approve at READY-FOR-PR + CI SUCCESS verified + operator merges |
| **MOC research dispatch** | Standard coord (your track currently) |

You operate at the "standard coord" tier for dispatches on your track. Joint sign-off is reserved for the ADR-0024 / LD-024-3 protocol — you'll see this on REDERIVATION-02 Track B Step 4 verdict reconciliation.

---

## 12. Key source file index (what you'll cite in reviews)

| File | Why it matters |
|---|---|
| `apps/strategy_runtime/src/contracts/strategy-ids.ts` | `ACTIVE_STRATEGY_IDS`, `REGISTERED_INACTIVE_STRATEGY_IDS`, `StrategyId` type. Currently out-of-sync with verdict reality. |
| `apps/strategy_runtime/src/strategies/types.ts` | `StrategyFeatureSnapshotContext` (now includes `signed_shock arm state` from CYCLE4-S2), `StrategyRegistryEntry` |
| `apps/strategy_runtime/src/management/types.ts` | Management profile types; the `requireBoolean` / `requireFiniteNumber` validators at lines 428-446 are the "declared" side that the wiring-test ticket asserts is "consulted" |
| `apps/strategy_runtime/src/management/target-position.ts` | `TargetPosition`, `TargetPositionFailSafeState`, `TargetPositionTimeStopState`, etc. — the position-snapshot side carrying profile values into runtime |
| `apps/strategy_runtime/src/management/management-profiles.ts` | `BASE_FAIL_SAFE`, `BASE_TIME_STOP`, etc. — profile defaults |
| `apps/strategy_runtime/src/management/management-config.ts` | YAML parser for management profiles; LD-WT-3 needs this for `at_deadline_extension` enum parsing post-MGMT-DEADLINE-EXTENSION-01 |
| `apps/strategy_runtime/src/management/position-manager/index.ts` | FSM orchestrator; FSM order locked here |
| `apps/strategy_runtime/src/management/position-manager/fail-safe.ts` | `firstFailSafeReason` — extended in PR #240 with `max_adverse_r` + `max_spread_ticks` checks |
| `apps/strategy_runtime/src/management/position-manager/time-stops.ts` | `evaluateTimeStop` — extended in PR #240 with conditional deadline exit; will be extended in MGMT-DEADLINE-EXTENSION-01 with the 4-mode dispatch |
| `apps/strategy_runtime/src/management/position-manager/stops.ts` | Stop-hit logic; `closePosition` helper that cancels pending targets |
| `apps/strategy_runtime/src/management/position-manager/targets.ts` | Target-hit + `markPt1Touched` (PR #215) |
| `apps/strategy_runtime/tests/unit/position-manager.test.ts` | The 14 + 18 D-prefix tests from MGMT-BUG-FIX-02 + the QFA-MGMT-WIRING-TEST-01 wiring tests will land here or in a sibling file |
| `apps/strategy_runtime/tests/unit/runner.test.ts` | Updated in PR #240 continuation fix; reference for how runner-level fixtures handle authority/bid/ask |
| `apps/backtester/src/strategy-fingerprint/strategy-fingerprint.ts` | Decision-level fingerprint computation (one of the two hash surfaces) |
| `apps/backtester/src/repro-hash/hash-chain.ts` | `final_chain_hash` computation |
| `apps/backtester/src/walk-forward/types.ts` | Walk-forward window types |
| `apps/backtester/src/validation-gate/trial-accounting.ts` | `effective_trial_count` computation (binds to ADR-0024 LD-024-4 roster completeness) |
| `scripts/backtester/check-determinism.mts` | A/B byte-equal regression gate |
| `docs/plan/engineer-dispatch-prompt.md` | Canonical worker dispatch prompt (now includes PROCESS-02 amendments) |
| `docs/plan/coordinator-handoff-2026-05-24.md` | Original (dispatching-coord) handoff doc; substantially obsolete in §2 (ACTIVE strategies) but otherwise canonical |
| `docs/adr/ADR-0023-cycle3-signed-shock-and-anti-pattern-lock.md` | Anti-pattern #4 source |
| `docs/adr/ADR-0024-post-verdict-bug-rederivation.md` | Re-derivation protocol; two invocations on record |
| `docs/adr/ADR-0027-deadline-extension-management-semantics.md` | Just merged; future implementation chain |
| `docs/research/qfa-611-cycle3-rederivation-invocation-memo.md` | REDERIVATION-01 invocation precedent |
| `docs/research/qfa-611-cycle3-rederivation-02-invocation-memo.md` | REDERIVATION-02 invocation (PR #241) |
| `docs/research/qfa-611-cycle3-rederivation-02-memo.md` | REDERIVATION-02 inference memo (Track B; pending PR) |
| `docs/research/qfa-611-cycle3-closure-memo.md` | Cycle3 closure memo; will have REDERIVATION-02 section appended via Track B PR |
| `docs/research/cycle4-r1-regime-shock-v3-vix-gate-scope.md` | v3 VIX-gate research |
| `docs/research/cycle4-r2-hold-time-entry-gate.md` | v4-delay / v4-persist research (PR #234 errata) |
| `docs/research/sizing-r1-post-fix-kelly-tiered-rederivation.md` | Generalized Kelly 7.89% reference |

---

## 13. Coord-1 worktree state (informational; not your action)

The dispatching coord (coord-1) has an unsynced worktree at `D:\Quant-futures-app\.claude\worktrees\frosty-cartwright-f8ca18` with several untracked coord-side audit/research docs from the past 48 hours of work:

- `docs/research/strategy-brief-3-coordinator-review.md` — analysis driving REDERIVATION-02
- `docs/research/markov-variants-buildability-deep-dive.md` — Markov chain strategy variants analysis
- `docs/research/snapshot-state-and-memory-audit.md` — ADR-0025 deferred design
- `docs/research/strategy-stack-build-audit.md` — initial strategy stack audit
- `docs/research/strategy-stack-mathematical-validity-audit.md` — math validity per strategy
- `docs/research/strategy-viability-against-2026-05-22-rth-probe.md` — Rithmic data viability
- `docs/plan/mgmt-bug-fix-02-dispatch-packet.md` — historical packet artifact
- `docs/plan/qfa-611-cycle3-rederivation-02-continuation-packet.md` — Track B continuation packet
- `docs/plan/qfa-611-cycle3-rederivation-02-dispatch-packet.md` — first-run packet
- `docs/plan/qfa-mgmt-wiring-test-01-dispatch-packet.md` — current packet awaiting your scope review

These are coord-1 artifacts; operator decides routing (land as historical artifacts vs stay parked). Not your action unless operator routes them.

---

## 14. Immediate first action

After verification checklist (§10):

1. **Read this entire doc end-to-end.** Self-contained by design.
2. **Read `docs/plan/coordinator-handoff-2026-05-24.md`** (the dispatching-coord handoff) for foundational context that this doc references but doesn't duplicate.
3. **Read coord-1's QFA-MGMT-WIRING-TEST-01 dispatch packet** (currently in coord-1 worktree, not on main — coord-1 will surface when you signal ready).
4. **Signal `STATE: STANDING-BY` with explicit acknowledgment** of:
   - You understand the bidirectional review protocol
   - You will apply PROCESS-02 (CI gate + monorepo vitest)
   - You acknowledge the all-REJECT verdict reality (no ACTIVE strategies in pipeline)
   - You acknowledge the MOC chain inheritance (or operator-redirects)
5. Wait for coord-1 to surface the QFA-MGMT-WIRING-TEST-01 packet for your scope review (§4.2).

The transition should be quiet. The protocol is designed to handle coord-swaps without breaking in-flight work. If you find anything ambiguous in this handoff doc, surface it before reviewing any packet.

---

**End of coord-2 handoff.**

If something is missing from this doc that you needed, that gap is coord-1's fault. Surface it.
