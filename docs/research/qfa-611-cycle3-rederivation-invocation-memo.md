# QFA-611-CYCLE3 re-derivation invocation memo

**Authority**: ADR-0024 LD-024-2 (joint coordinator + operator
authorization required to invoke the post-verdict infrastructure-bug
re-derivation protocol).

**Date**: 2026-05-22

**Cycle being re-derived**: Cycle3 (Phase 5 closure at commit `e985b10`).

**Decision**: **INVOKE — Path A (fix-and-rederive)**.

## Bug summary

A correctness defect in shared management-engine infrastructure: the
position-manager FSM evaluates `stop_hit` before `targets` on the same
bar. When a single bar's [low, high] range spans both the configured
stop level and the PT1 target level, the stop branch fires first.
`evaluateStopHit` calls `closePosition`, which cancels all `pending`
targets including PT1. PT1 status becomes `'cancelled'`, never
`'filled'`. The downstream `isBreakEvenTriggerMet` check requires
`status === 'filled'` and therefore never arms break-even on these
combined-bar cases.

File-level citations:

- `apps/strategy_runtime/src/management/position-manager/index.ts:95-139`
  — FSM evaluation order (fail_safe → stop_hit → targets → time_stop →
  break_even arm → trailing).
- `apps/strategy_runtime/src/management/stops.ts:149` — stop-hit uses
  `market.high_price`.
- `apps/strategy_runtime/src/management/targets.ts:127` — target-hit
  uses `market.low_price`.
- `apps/strategy_runtime/src/management/stops.ts:32` —
  `evaluateStopHit` calls `closePosition`.
- `apps/strategy_runtime/src/management/stops.ts:133-137` —
  `closePosition` maps all `pending` targets to `cancelled`.
- `apps/strategy_runtime/src/management/stops.ts:156` —
  `isBreakEvenTriggerMet` predicate `position.targets.some(t =>
  t.label==='pt1' && t.status==='filled')` always false after
  cancellation.
- `apps/strategy_runtime/src/management/management-profiles.ts:42` —
  declared intent: `trigger: 'after_pt1', offset_ticks: 1`.
- `apps/strategy_runtime/tests/unit/position-manager.test.ts` — missing
  coverage for the combined-bar case (PT1 fill and stop hit tested only
  as separate ticks).

## Four-criteria verification per ADR-0024 LD-024-1

### Criterion 1 — Shared infrastructure

**PASS.** The defect lives in
`apps/strategy_runtime/src/management/position-manager/` and
`apps/strategy_runtime/src/management/stops.ts`. These files operate
across every strategy in the project. NOT strategy-specific code.
NOT a YAML. NOT a parameter-lock artifact.

### Criterion 2 — Material effect on verdict-determining metrics

**PASS.** Counterfactual PnL impact on Cycle3 held-out validation:

| Segment | Baseline net | BE@PT1 (1-tick slip) net |
|---|---|---|
| Apr 1-8 (worst window) | −$43.50 (PF 0.98) | +$524.00 (PF 1.42) |
| Rest of corpus | +$2,096.00 (PF 1.75) | +$3,305.50 (PF 3.11) |
| **Cycle3 total** | **+$1,996.50 (PF 1.40)** | **+$3,829.50 (PF 2.17)** |

For `regime_shock_reversion_short_v2`:
- Profit factor shifts from 1.40 to 2.17 (relative shift +55%,
  exceeds the 10% materiality threshold).
- Net PnL shifts +91% relative to baseline.
- Both REJECTed Cycle3 strategies (`vwap_overnight_reversal_short`,
  `vwap_overnight_reversal_long`) were close on multiple thresholds
  and could plausibly flip verdict under fixed-engine semantics.

The defect crosses the materiality bar in LD-024-1 criterion #2 (≥ 10%
metric shift, threshold flip, or verdict change) for at least the
ADVANCEd strategy with high confidence, and potentially for the
REJECTed strategies (to be determined by re-derivation).

### Criterion 3 — Discovered post-verdict

**PASS.** The Phase 5 closure verdict was issued at commit `e985b10` on
2026-05-19 against the buggy management engine. The defect was
discovered through operator-driven analytical work on 2026-05-22 — three
days post-closure. No prior ADR, code comment, test docstring, or
research memo documented the combined-bar tie-break behavior. The bug
was not known and not accepted as a design choice at verdict time.

### Criterion 4 — Correctness-bug, not design-choice

**PASS.** The defect's behavior contradicts the declared intent of the
`BASE_BREAK_EVEN` profile at `management-profiles.ts:42` (`trigger:
'after_pt1', offset_ticks: 1`). The profile's literal declaration is
that break-even arming triggers after PT1 — that is the documented
design. The combined-bar behavior in which PT1 is silently cancelled by
a same-bar stop hit produces behavior that violates the declared
intent. This is a correctness bug, not a suboptimal-but-deliberate
design choice.

## Path selection

Three paths were considered per ADR-0024 LD-024-3 + the prior
coordinator-operator discussion:

- **Path A (fix-and-rederive)**: Land the bug fix as shared
  infrastructure. Re-run Cycle3 inference layer against the fixed
  engine for all 3 strategies. Re-derive the Phase 5 closure verdict.
  Methodologically cleanest; cost is 3-5 days wall-clock.

- **Path B (defer-and-document)**: Document the bug as known issue.
  Proceed with QFA-612-BROKER-03 paper trading against the buggy engine
  (matching verdict context). Land the fix after paper observation
  completes. Methodologically defensible (verdict context preserved
  through paper observation) but knowingly runs broken code.

- **Path C (fix-and-proceed)**: Land the bug fix. Skip re-derivation.
  Proceed with BROKER-03 against the fixed engine. Methodologically
  weakest — conflates bug fix + strategy validation into a single
  paper-observation window, destroying the ability to isolate cause.

**Path A selected** for the following reasons:

1. The bug affects shared infrastructure; future strategies and future
   cycles will benefit from a corrected baseline.
2. The Cycle3 verdict is in question by the operator's own analysis;
   re-deriving against the fix gives clean attribution.
3. Re-derivation is a one-shot cost; running broken code is recurring.
4. This invocation sets the precedent for how the project handles
   post-verdict infrastructure-bug discoveries. Path A is the right
   precedent.

## Apr 1-8 regime-pinning finding (not a re-derivation trigger)

A separate analytical finding identified that during Apr 1-8 2026 the
regime classifier sustained `high` classification through what was
substantively a directional trend (100% high regime, vs 77% in the rest
of the corpus). MFE/MAE ratio collapsed from 1.57 → 0.98, indicating
the reversion edge degraded. April 7 alone produced 89 trades with
$189.50 intraday drawdown (the single worst session in the validation
corpus).

Per ADR-0024 LD-024-1 criterion #4, this is a **strategy-level edge
limit, not an infrastructure bug**:

- It reflects the regime classifier's behavior on sustained directional
  moves — a property of the strategy's hypothesis (mean-reversion
  within a regime classification window), not a defect in shared
  infrastructure.
- The regime classifier code in `apps/strategy_runtime/src/regime/`
  operates as designed; there is no declared-intent violation.

This finding is documented separately as a **Cycle4 research candidate**.
Mitigation paths (regime-persistence cooldown, second-factor vol/trend
gate) would each be new strategy_ids per CF-41 and would dispatch as
fresh hypothesis families in a future cycle. The finding is NOT
in-scope for the current re-derivation invocation.

## Implementation chain (LD-024-3 four-step protocol)

The re-derivation executes in four strictly-sequential steps:

| Step | Ticket / Artifact | Status |
|---|---|---|
| 0 (precondition) | ADR-0024 commit at `2870e23` (on `origin/main`) | ✓ complete |
| 0 (precondition) | This invocation memo at commit pending | in progress |
| 1 | **QFA-MGMT-BUG-FIX-01** — implements pt1_touched flag + targets-before-stop on combined-bar; adds combined-bar unit tests | not yet dispatched |
| 2 | **QFA-611-CYCLE3-REDERIVATION-01** — re-runs inference for all 3 Cycle3 strategies against fixed engine; updates held-out-validation JSONs + strategy-selection-v3.json + re-derivation memo | not yet dispatched |
| 3 | Cycle3 closure memo amendment (preserving original content verbatim above the amendment) | not yet drafted |
| 4 | Verdict reconciliation decision (coordinator + operator) | not yet held |
| 5 (downstream) | QFA-612-BROKER-03 dispatch resumes (verdict unchanged) or scope revises (verdict changed) | paused pending steps 1-4 |

## Signing parties

This invocation memo is the joint authorization artifact per ADR-0024
LD-024-2. Both parties have reviewed:

- The bug's file-level citations and the four-criteria verification.
- The counterfactual PnL impact and its implications for the Cycle3
  verdict.
- The three-path consideration (A / B / C) and the rationale for
  selecting Path A.
- The implementation chain and its expected wall-clock cost.
- The explicit exclusion of the Apr 1-8 regime-pinning finding from
  this invocation's scope.

**Operator**: Neel Jaiswal (`neeljaiswal90@gmail.com`).
**Coordinator**: Claude (this session, 2026-05-22).

The invocation is **authorized** and the implementation chain (steps
1-5 above) is **active** as of this commit.

## Cross-references

- **ADR-0024** (post-verdict infrastructure-bug re-derivation protocol)
  — commit `2870e23`
- **ADR-0016** (alpha decision criteria) — thresholds re-applied during
  re-derivation, not modified
- **ADR-0023** (Cycle3 SignedShockMeasurement + anti-pattern lock) —
  preserved through re-derivation
- **`docs/research/qfa-611-cycle3-closure-memo.md`** — Phase 5 closure;
  to be amended per LD-024-3 Step 3
- **`docs/research/qfa-611-cycle3-strategy-selection.md`** — Cycle3
  strategy selection record
- **`artifacts/strategy-selection/strategy-selection-v3.json`** —
  verdict file at sha256
  `C313CC4CB518B47485D1D32C7F03FB22F1CD90F38F8D573DB745308860441D76`;
  to be regenerated per LD-024-3 Step 2
- **`artifacts/held-out-validation/cycle3/regime_shock_reversion_short_v2-feb-mar-apr-2026.json`**
  — to be regenerated per LD-024-3 Step 2
- **`artifacts/held-out-validation/cycle3/vwap_overnight_reversal_short-feb-mar-apr-2026.json`**
  — to be regenerated per LD-024-3 Step 2
- **`artifacts/held-out-validation/cycle3/vwap_overnight_reversal_long-feb-mar-apr-2026.json`**
  — to be regenerated per LD-024-3 Step 2
- CF-30, CF-41, CF-44, CF-45 — preserved; re-derivation does not relax
  any anti-tuning carry-forward
- CF-52 — paper observation window; downstream BROKER-03 dispatch
  proceeds against re-derived verdict only after step 4
