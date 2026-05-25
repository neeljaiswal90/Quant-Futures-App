# ADR-0027: Deadline-extension management semantics

**Status:** PROPOSED (drafted 2026-05-24; awaiting operator + dual-coord sign-off)

**Authority:** standard ADR sign-off (operator + coord-1 + coord-2). Not joint-per-LD-024-2 because this is a schema/governance ADR, not a re-derivation invocation.

**Precipitating context:** Cycle4 hypothesis chain extension. After QFA-611-CYCLE3-REDERIVATION-02 surfaced the all-REJECT outcome for the original Cycle3 roster under the corrected management runtime (PR #240 / commit `d1d7461`), substantive analysis identified that v2's pre-fix apparent performance (PF 2.17) depended on the buggy unconditional time-stop functioning as a hidden risk cap. The corrected runtime exposes a real strategy weakness: held-past-deadline shock-reversion trades exhibit a -1R adverse / +1.2R favorable asymmetry that the strategy's actual reversion hit-rate cannot compensate for. Three new Cycle4 hypotheses (`v5_*`) propose different management responses to this finding. All three require a new profile primitive: an action to take at deadline beyond the current "exit-if-below-floor" semantics. This ADR locks that primitive.

---

## Context

The corrected `evaluateTimeStop` runtime (per MGMT-BUG-FIX-02 / PR #240) implements the conditional deadline exit: at deadline, exit if `unrealizedR < threshold`, else hold past deadline. This matches the declared semantics of `pre_pt1_min_unrealized_r` and `post_pt1_min_unrealized_r` fields and resolved the ADR-0023 anti-pattern #4 (declared-but-unenforced) bug class. REDERIVATION-02 confirmed all 3 Cycle3 active strategies REJECT under this corrected runtime.

Three substantively different hypotheses about how to manage the held-past-deadline bucket have been identified for Cycle4 research:

1. **Strict deadline:** at deadline, exit unconditionally regardless of `uR`. Hypothesis: shock-reversion is time-bounded; failed-reversion-by-deadline = invalid signal.
2. **Move stop to BE:** at deadline, if `uR ≥ 0`, move the active stop to the entry price; trade continues with break-even protection. Hypothesis: signal is valid but downside on held trades should be capped at 0R.
3. **Activate trailing stop:** at deadline, if `uR ≥ 0`, activate a trailing stop using the existing `trailing_stop.distance_ticks` and `trailing_stop.mode` config, with BE-floor enforced (effective stop = whichever of trail_stop or BE_stop is tighter). Hypothesis: signal is valid but management was too static — dynamic trail captures intermediate favorable moves while still capping downside at 0R.

Each hypothesis MAY become a separate REGISTERED_INACTIVE Cycle4 strategy (candidate names: `regime_shock_reversion_short_v5_strict_deadline`, `_v5_be_at_deadline`, `_v5_trail_at_deadline`). All three (or some subset, per operator-strategic decision) need a NEW profile field to declaratively select the deadline behavior, distinct from the existing `pre/post_pt1_min_unrealized_r` thresholds.

This ADR locks the schema for that new field. The ADR does NOT decide which v5 variants get built (that is operator-strategic), does NOT promote any v5 variant beyond REGISTERED_INACTIVE (that requires formal Cycle4 cycle), and does NOT modify any existing strategy's profile (CF-30 / ADR-0024 binds).

---

## Locked Decisions

### LD-027-1: New profile field `time_stop.at_deadline_extension`

A new field on `TargetPositionTimeStopState` and `ManagementProfile.time_stop`:

```ts
at_deadline_extension:
  | 'enforce_floor'        // default — current behavior post-MGMT-BUG-FIX-02
  | 'move_to_be'           // Option 1 — static BE stop at deadline
  | 'activate_trail'       // Option 3 — dynamic trail with BE-floor at deadline
  | 'unconditional_exit';  // Option 2 — strict deadline exit
```

Schema citations (post-MGMT-BUG-FIX-02, post-`d1d7461`):
- Type: extend `TargetPositionTimeStopState` at `target-position.ts:62-69`
- Parser: extend `management-config.ts:373-381` to read and validate the new field as an enum
- Defaults: extend `BASE_TIME_STOP` at `management-profiles.ts:49-55` to set `at_deadline_extension: 'enforce_floor'`
- Runtime: extend `evaluateTimeStop` at `time-stops.ts` to **dispatch on the enum AT the deadline branch**. Only the `'enforce_floor'` branch uses the existing floor-check logic; the other three modes own the deadline branch entirely (see LD-027-7 canonical mode table and the pseudocode below).

**Reference dispatch pseudocode** (worker implements verbatim modulo style):

```ts
export function evaluateTimeStop(
  position: TargetPosition,
  market: PositionManagerMarketInput,
): PositionManagerStepResult {
  // Existing pre-deadline short-circuit (unchanged).
  if (
    position.lifecycle_state === 'closed' ||
    position.remaining_quantity <= 0 ||
    !position.time_stop.enabled ||
    position.time_stop.deadline_ts_ns === undefined ||
    market.event_ts_ns < position.time_stop.deadline_ts_ns
  ) {
    return { position, actions: [], reasons: [] };
  }

  // === Deadline reached. Dispatch on at_deadline_extension. ===
  const mode = position.time_stop.at_deadline_extension; // defaulted 'enforce_floor' by parser
  const pt1Touched = position.pt1_touched === true;
  const unrealizedPoints =
    position.side === 'long'
      ? market.mark_price - position.entry_price
      : position.entry_price - market.mark_price;
  const unrealizedR =
    position.risk_points > 0 ? unrealizedPoints / position.risk_points : 0;

  switch (mode) {
    case 'enforce_floor': {
      const threshold = pt1Touched
        ? position.time_stop.post_pt1_min_unrealized_r
        : position.time_stop.pre_pt1_min_unrealized_r;
      if (typeof threshold === 'number' && Number.isFinite(threshold) && unrealizedR >= threshold) {
        // HOLD past deadline (existing corrected-runtime behavior)
        return {
          position,
          actions: [],
          reasons: [pt1Touched
            ? 'time_stop:held_past_deadline_post_pt1'
            : 'time_stop:held_past_deadline_pre_pt1'],
        };
      }
      return exitOnDeadline(position, market);
    }

    case 'move_to_be': {
      if (unrealizedR < 0) return exitOnDeadline(position, market);
      // Extend: tighten stop to BE per LD-027-3 no-widening invariant
      return moveStopToBreakEvenAtDeadline(position, market);
    }

    case 'activate_trail': {
      if (unrealizedR < 0) return exitOnDeadline(position, market);
      // Extend: activate trail per LD-027-4 (initialization, BE-floor, no-widening)
      return activateTrailAtDeadline(position, market);
    }

    case 'unconditional_exit': {
      return exitOnDeadline(position, market);
    }
  }
}
```

The `exitOnDeadline`, `moveStopToBreakEvenAtDeadline`, and `activateTrailAtDeadline` helpers are defined per LD-027-3, LD-027-4, and the existing `closePosition` logic. **No silent fall-through paths.** Unknown enum values are rejected at config-parse time per LD-027-8.

### LD-027-2: Default value preserves current behavior

`at_deadline_extension` defaults to `'enforce_floor'`. This value reproduces the current corrected runtime semantics exactly:

- If `uR < pre_pt1_min_unrealized_r` (pre-PT1) or `uR < post_pt1_min_unrealized_r` (post-PT1) → exit with `time_stop:deadline_reached`
- Else → hold past deadline with `time_stop:held_past_deadline_{pre,post}_pt1` reason

Existing strategies (v2, vwap_overnight_reversal_*, v3, v4) all use `BASE_TIME_STOP` and therefore inherit `'enforce_floor'`. **No existing strategy's runtime behavior changes from this ADR.** Strategy fingerprints, phase2/phase4 hashes, and `final_chain_hash` must remain pinned post-implementation (byte-equal regression gate is the schema-PR success criterion).

### LD-027-3: `'move_to_be'` semantics — with no-widening invariant + BE state mutation

At deadline, dispatch per LD-027-7 mode table. For the extend branch (`uR >= 0`):

**Stop mutation — side-aware tighten, NOT raw assignment.** The deadline BE action MUST NOT widen an existing stop. If `position.active_stop_price` is already tighter than `position.entry_price` (e.g., from a prior trail), the stop price is unchanged.

```ts
// Side-aware tighten ("tighter" = closer to current price; protective)
function stopTighter(currentStop: number, candidateStop: number, side: 'long' | 'short'): number {
  return side === 'long'
    ? Math.max(currentStop, candidateStop)  // for long: higher stop is tighter
    : Math.min(currentStop, candidateStop); // for short: lower stop is tighter
}

// moveStopToBreakEvenAtDeadline helper:
const newStop = stopTighter(position.active_stop_price, position.entry_price, position.side);
// newStop equals position.active_stop_price (no-op) if existing stop is already tighter than entry.
```

**BE state mutation invariant.** After the deadline BE action arms BE, the position MUST be indistinguishable from a position whose BE was armed by the normal break-even FSM stage, except for the reason string / trigger provenance. The implementation must set the existing break-even moved/armed flag (`position.break_even.moved = true` per the current schema at [target-position.ts:42-49](apps/strategy_runtime/src/management/target-position.ts:42)) to prevent the downstream `break_even` FSM stage from double-arming or re-emitting telemetry.

**Action type and reason:**
- `action_type: 'BREAKEVEN_ARMED'` (existing action type per `ManagementActionType`; reuse, do not introduce a new type)
- `reason: 'time_stop:moved_stop_to_be_at_deadline'` (new reason string; distinct from the existing `break_even:after_pt1` reason so telemetry can distinguish provenance)

If the runtime currently lacks `BREAKEVEN_ARMED` as a valid `ManagementActionType` value, the MGMT-DEADLINE-EXTENSION-01 implementation packet must add it explicitly with worker discovery + escalation — do NOT leave action-type provenance to worker inference.

**Idempotency and PT1 interaction:**
- If `position.break_even.moved === true` already at deadline (e.g., PT1 fired earlier and BE was already armed), the deadline BE action is a no-op (no stop change, no action emission, no reason emission). The trade continues to subsequent FSM stages.
- The stop-tighten invariant ensures that even if the existing BE-armed stop is already tighter (e.g., the trail moved it), the deadline action does not widen.

### LD-027-4: `'activate_trail'` semantics — initialization, BE-floor, no-widening, parser validation

At deadline, dispatch per LD-027-7 mode table. For the extend branch (`uR >= 0`):

**Trail state initialization invariant.** The deadline trail activation MUST seed the same trailing state that post-PT1 trail activation would seed if activated at the same market event. The trailing-stop FSM stage on subsequent ticks then operates on this state per existing logic.

Concretely:

```ts
// activateTrailAtDeadline helper, side-aware:
function trailAnchorPrice(market: PositionManagerMarketInput): number {
  return market.mark_price; // anchor at current price at deadline
}

function rawTrailStop(side: 'long' | 'short', anchor: number, distanceTicks: number, tickSize: number): number {
  const offset = distanceTicks * tickSize;
  return side === 'long' ? anchor - offset : anchor + offset;
}

// Combined with BE-floor + no-widening:
const anchor = trailAnchorPrice(market);
const raw = rawTrailStop(position.side, anchor, position.trailing_stop.distance_ticks, position.instrument.tick_size);
const beFloor = position.entry_price;
const candidateStop = stopTighter(raw, beFloor, position.side);                   // BE-floor binds when raw is wider
const newActiveStop = stopTighter(position.active_stop_price, candidateStop, position.side); // no-widening invariant against current stop
```

Where `stopTighter` is defined in LD-027-3.

**BE-floor enforcement is implicit** — every effective stop computation uses `stopTighter(...,beFloor,...)`. The BE-floor is not configurable separately; proposals to disable it require ADR amendment, not parameter change.

**No-widening invariant against current stop** — the trail activation MUST NOT widen the existing `active_stop_price`. If the existing stop is already tighter than both the raw trail stop AND the BE-floor (e.g., a prior trail activation by a different mechanism), the existing stop is preserved.

**Trail state field mutations:**
- `position.trailing_stop.active = true`
- `position.active_stop_price = newActiveStop` (per the computation above)
- Trail anchor / best-favorable-price-since-activation fields are seeded per the existing trailing-stop schema (worker discovers exact field names during implementation; if the schema lacks fields needed for stateful trail tracking, MGMT-DEADLINE-EXTENSION-01 must extend the trailing-stop schema before completing — discover + escalate)

**Action type and reason:**
- `action_type: 'ACTIVATE_TRAIL'` (existing action type per `ManagementActionType`; reuse if present; otherwise add explicitly in the implementation packet per the same discipline as LD-027-3)
- `reason: 'time_stop:activated_trail_at_deadline'` (new reason string; distinct from existing post-PT1 trail activation reasons)

**Schema reuse and naming clarification:**
- The existing `trailing_stop.distance_ticks` and `trailing_stop.mode` fields are reused. No new trail-config fields.
- The existing `trailing_stop.activation` field (currently typed as `'after_pt1'`) is NOT extended. The at-deadline trigger lives entirely in the `time_stop.at_deadline_extension = 'activate_trail'` branch.
- **Naming clarification:** when `trailing_stop.mode = 'post_pt1_ticks'` and `at_deadline_extension = 'activate_trail'`, the mode name `'post_pt1_ticks'` becomes semantically misleading (the trail is activated at deadline, which may be pre-PT1). The mode name is preserved for backward compatibility but should be interpreted as "tick-distance trailing logic" regardless of activation provenance. A future ADR-0027-A2 may rename the mode if naming friction becomes operational pain.

**Parser validation requirement (mandatory):** if `time_stop.at_deadline_extension = 'activate_trail'`, the config parser MUST validate that:
- `trailing_stop.enabled === true`
- `trailing_stop.distance_ticks > 0`
- `trailing_stop.mode` is a recognized value (currently `'post_pt1_ticks'`)

Invalid combinations MUST fail at config-load time with an explicit error. The runtime MUST NOT silently downgrade `'activate_trail'` to `'enforce_floor'`, `'move_to_be'`, or no-op. This matches the ADR-0023 anti-pattern #4 fail-closed discipline.

**Idempotency and PT1 interaction:**
- If `position.trailing_stop.active === true` already at deadline (e.g., PT1 fired earlier and the existing post-PT1 trail activation set it), the deadline trail action is a no-op (no field mutations, no action emission, no reason emission, no widening). The trade continues to subsequent FSM stages.
- If PT1 fires later (post-deadline trail activation), the existing post-PT1 trail activation logic must detect `position.trailing_stop.active === true` and no-op (existing logic must be verified — if it currently re-arms, MGMT-DEADLINE-EXTENSION-01 must add the idempotency guard).

### LD-027-5: `'unconditional_exit'` semantics — ignore floor thresholds

At deadline:

- Exit with `time_stop:deadline_reached` (existing reason string preserved for downstream telemetry compatibility)
- The `pre_pt1_min_unrealized_r` and `post_pt1_min_unrealized_r` thresholds are IGNORED for this dispatch path; they remain on the schema for compatibility but have no runtime effect

This is the only dispatch path that intentionally diverges from threshold-based behavior. The intent is the time-bounded-signal hypothesis: failed reversion by deadline = invalid signal, exit regardless of intermediate `uR`.

### LD-027-6: FSM ordering preserved

The existing FSM evaluation order is preserved (per MGMT-BUG-FIX-02 + PR #215):

```
fail_safe → markPt1Touched → stop_hit → targets → time_stop → break_even → trailing
```

The at-deadline action lives entirely in the `time_stop` stage. Subsequent stages (`break_even`, `trailing`) operate on the modified position state per their existing logic. For `'move_to_be'`: the break_even stage may further refine the BE stop if its own trigger conditions are met (no double-arming because `position.break_even.moved` flag guards). For `'activate_trail'`: the trailing stage takes over normal trail tracking on subsequent ticks once `trailing_stop.active = true` is set.

### LD-027-7: Per-mode deadline decision semantics (canonical table)

The PRIOR draft of LD-027-7 contained a contradiction (claimed "thresholds remain the floor reference" while also saying "ignore configured floor"). This rewrite resolves the contradiction with a canonical mode table. **This table is the load-bearing semantics for `evaluateTimeStop`'s deadline branch.**

| Mode | Deadline condition | Action | Uses `pre/post_pt1_min_unrealized_r`? |
|---|---|---|---|
| `'enforce_floor'` | `uR < selectedThreshold` (where `selectedThreshold = pt1_touched ? post_pt1_min_unrealized_r : pre_pt1_min_unrealized_r`) | Exit with `time_stop:deadline_reached` | **YES** (full configured-floor semantics, identical to current corrected runtime) |
| `'enforce_floor'` | `uR >= selectedThreshold` | Hold past deadline (emit `time_stop:held_past_deadline_{pre,post}_pt1` per pt1_touched) | YES |
| `'move_to_be'` | `uR < 0` | Exit with `time_stop:deadline_reached` | **NO** (configured thresholds ignored; fixed-zero floor) |
| `'move_to_be'` | `uR >= 0` | Tighten stop to BE per LD-027-3 (no-widening); set break-even armed/moved state | NO |
| `'activate_trail'` | `uR < 0` | Exit with `time_stop:deadline_reached` | **NO** (configured thresholds ignored; fixed-zero floor) |
| `'activate_trail'` | `uR >= 0` | Activate trailing state per LD-027-4 (initialization, BE-floor, no-widening) | NO |
| `'unconditional_exit'` | any `uR` | Exit with `time_stop:deadline_reached` | **NO** (configured thresholds ignored; `uR` ignored) |

**Equality boundary lock:** `uR = 0` extends (holds / arms BE / activates trail) for `'move_to_be'` and `'activate_trail'`. The exit predicate is strict `uR < 0`, not `uR <= 0`.

**Rationale for the design split:**
- `'enforce_floor'` is the only mode that respects the configured `pre/post_pt1_min_unrealized_r` thresholds. This is the default and matches the corrected post-MGMT-BUG-FIX-02 runtime exactly.
- `'move_to_be'` and `'activate_trail'` use a fixed `uR < 0` gate because their hypothesis is "extend if winning, cap downside if losing." Configurable floors for the extend decision are explicitly out of scope per the KISS principle; a future ADR-0027-A1 may add `at_deadline_extension_floor` if research demands.
- `'unconditional_exit'` ignores both the threshold AND `uR` because its hypothesis is "time-bounded signal; failed-reversion = invalid signal."

**Material implication:** with the current `BASE_TIME_STOP.pre_pt1_min_unrealized_r = -0.25`, a trade at `uR = -0.10` would HOLD under `'enforce_floor'` but EXIT under `'move_to_be'` and `'activate_trail'`. This is the intended design difference. Strategies cannot blend modes; they pick one.

### LD-027-8: Parser strictness — fail-closed on unknown enum value

If a profile YAML declares `at_deadline_extension: 'unknown_value'`, the parser MUST reject at config-load time with an explicit error. The runtime MUST NOT silently default to `'enforce_floor'`. This matches the ADR-0023 anti-pattern #4 discipline.

If a profile YAML omits the field entirely (legacy profiles): the parser SHOULD default to `'enforce_floor'` per LD-027-2.

### LD-027-9: Existing strategies are NOT modified

This ADR does NOT authorize:

- Adding `at_deadline_extension: '<non-default>'` to any of v2 / vwap_overnight_reversal_long/short / v3 / v4 YAML configs. Doing so would change runtime behavior on a locked YAML, requiring ADR-0024 invocation per the post-verdict re-derivation protocol.
- Tuning the existing `pre/post_pt1_min_unrealized_r` values on any existing strategy YAML. CF-30 binds.
- Re-deriving any past Cycle3 verdict under a non-default `at_deadline_extension`. ADR-0024 LD-024-1 criterion 4 (correctness-bug, not design-choice) does not apply to design changes.

This ADR ONLY authorizes:

- Adding the schema field with default `'enforce_floor'`.
- Implementing the four dispatch branches in `evaluateTimeStop`.
- Allowing NEW strategy_ids (via Cycle4 hypothesis chain under B-full scope) to declare a non-default `at_deadline_extension` value in their YAML.

### LD-027-10: Promotion path for v5 variants

Strategy_ids that use `at_deadline_extension != 'enforce_floor'` (e.g., the proposed `v5_strict_deadline`, `v5_be_at_deadline`, `v5_trail_at_deadline`):

- Land as REGISTERED_INACTIVE per Cycle3 closure-memo B-full amendment scope.
- Run through inference under the corrected runtime for informational comparison.
- CANNOT promote to ACTIVE without a formal Cycle4 cycle (separate ADR-0016-driven verdict process).

Informational inference outputs MAY be used to inform Cycle4 hypothesis prioritization but MUST NOT be treated as verdict-bearing artifacts. The strategy-selection JSON for an informational inference run should be named distinctly (e.g., `strategy-selection-cycle4-research-NN.json`) and stored alongside, not in place of, the Cycle3 closure verdict artifacts.

---

## What this ADR does NOT do

- Does NOT modify any existing strategy YAML, runtime behavior, or verdict.
- Does NOT promote any v5 variant to ACTIVE (that requires formal Cycle4).
- Does NOT relax CF-30 (anti-tuning on locked YAMLs).
- Does NOT relax CF-41 (new hypothesis = new strategy_id).
- Does NOT relax CF-44 (no near-miss tuning).
- Does NOT amend ADR-0023 anti-pattern lock (fail-closed discipline preserved; LD-027-8 explicitly enforces).
- Does NOT amend ADR-0016 alpha decision criteria.
- Does NOT amend ADR-0024 re-derivation protocol (existing strategies stay on their existing profiles; no re-derivation triggered).
- Does NOT decide how many v5 variants get built (operator-strategic decision; this ADR only locks the schema that any v5 variant would consume).
- Does NOT add configurable floors for the `'move_to_be'` / `'activate_trail'` extend decision (KISS per LD-027-7; future ADR-0027-A1 may add if needed).

---

## Consequences

This ADR dispatches the following implementation chain. Each item is a separate PR with its own coord-coord review and CI-must-be-SUCCESS gate per PROCESS-02.

| Order | Ticket / Artifact | Scope |
|---|---|---|
| 1 | **MGMT-DEADLINE-EXTENSION-01** | Schema PR: extend `TargetPositionTimeStopState` + `ManagementProfile.time_stop` to add `at_deadline_extension` enum (4 values). Default to `'enforce_floor'`. Wire all four dispatch branches in `evaluateTimeStop` per LD-027-1 reference pseudocode. **Byte-equal regression gate** targets BEHAVIOR equality, not strict serialization equality — see Risk Register hash-drift mitigation. Required test pack enumerated below. |
| 2 | **STRAT-V5-DEADLINE-VARIANTS-01** | Register one or more new REGISTERED_INACTIVE strategy_ids using non-default `at_deadline_extension` values. Specific variants (`v5_strict_deadline`, `v5_be_at_deadline`, `v5_trail_at_deadline`) are operator-strategic; this ADR allows any of the three. Each variant: YAML lock + strategy generator (mirror v2 logic) + synthetic fixture + registration in `strategy-ids.ts`. |
| 3 | **CYCLE4-V5-INFERENCE-NN** | Run inference under corrected runtime for the v5 variants registered in #2. Produce informational `strategy-selection-cycle4-research-NN.json`. Report metric tables for operator + dual-coord review. **NOT a Phase-5 verdict run; cannot promote.** |

### MGMT-DEADLINE-EXTENSION-01 required test pack

The schema PR MUST add the following unit tests to `apps/strategy_runtime/tests/unit/position-manager.test.ts` (or the equivalent test surface). These supersede any test suggestions from prior packets and are the load-bearing acceptance criteria for the schema PR:

| # | Test | Expected |
|---|---|---|
| D1 | Existing strategy YAML with `at_deadline_extension` field OMITTED entirely | Behavior IDENTICAL to `'enforce_floor'` (per LD-027-2 default + LD-027-8 legacy-profile handling) |
| D2 | YAML declares `at_deadline_extension: 'unknown_value'` | Config-load REJECTED with explicit error (per LD-027-8) |
| D3 | `'enforce_floor'`, pre-PT1, `uR = -0.10`, threshold `-0.25` | HOLD past deadline (existing corrected-runtime behavior) |
| D4 | `'move_to_be'`, pre-PT1, `uR = -0.10`, threshold `-0.25` | EXIT at deadline (LD-027-7 ignores configured floor; fixed `uR < 0` gate) — different from D3 |
| D5 | `'move_to_be'`, `uR = 0.00` exactly | EXTEND (tighten to BE, no exit); confirms equality boundary per LD-027-7 |
| D6 | `'move_to_be'` with `active_stop_price` ALREADY TIGHTER than entry (e.g., long with stop above entry from a prior trail) | NO WIDENING; existing stop preserved (LD-027-3 stopTighter invariant) |
| D7 | `'move_to_be'` extend path, then subsequent break_even FSM stage runs | NO double-arming; `position.break_even.moved === true` already set by deadline action; break_even stage no-ops (LD-027-3 BE state mutation invariant) |
| D8 | `'activate_trail'` with `trailing_stop.enabled = false` in YAML | Config-load REJECTED (LD-027-4 parser validation) |
| D9 | `'activate_trail'` with `trailing_stop.distance_ticks <= 0` | Config-load REJECTED (LD-027-4 parser validation) |
| D10 | `'activate_trail'`, `uR = 0.00` exactly | EXTEND (activate trail with BE-floor, no exit); confirms equality boundary |
| D11 | `'activate_trail'`, raw trail stop computed from anchor is wider than entry (e.g., long with small `uR_deadline` and large `distance_ticks` that would put raw trail stop below entry) | BE-floor BINDS; effective stop is at entry, not below (LD-027-4 BE-floor) |
| D12 | `'activate_trail'` with `active_stop_price` ALREADY TIGHTER than both BE and raw trail (e.g., long with prior tight stop) | NO WIDENING; existing stop preserved (LD-027-4 no-widening invariant) |
| D13 | PT1 fires BEFORE deadline (existing post-PT1 trail activates); deadline arrives with `at_deadline_extension = 'activate_trail'` | Deadline trail action is NO-OP; `position.trailing_stop.active === true` already; no duplicate activation, no widening (LD-027-4 idempotency) |
| D14 | Deadline activates trail (pre-PT1); PT1 fires LATER | Existing post-PT1 trail activation no-ops; trail state remains coherent (LD-027-4 idempotency, verify-or-add) |
| D15 | `'unconditional_exit'`, `uR = +0.50` (favorable) | EXIT at deadline regardless of favorable position (LD-027-7 ignores `uR`) |
| D16 | `'unconditional_exit'`, `uR = -0.50`, threshold `-0.25` | EXIT at deadline (existing pre/post thresholds ignored) |
| D17 | `'move_to_be'` short-side symmetry test (mirror of D5/D6 for short) | EXTEND, no widening; symmetric stopTighter behavior |
| D18 | `'activate_trail'` short-side symmetry test (mirror of D10/D11/D12 for short) | EXTEND, BE-floor binds correctly for short, no widening |

The MGMT-BUG-FIX-02 packet (PR #240) already established the corrected `'enforce_floor'` behavior and FSM ordering; ADR-0027 EXPLICITLY BUILDS ON THAT and does NOT reopen those tests. The 18 D-prefix tests here are NEW coverage for the new dispatch branches; the existing T1-T14 pack from MGMT-BUG-FIX-02 stays unchanged.

---

## Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| Existing strategy runtime changes unexpectedly | High | LD-027-2 mandates `'enforce_floor'` default + byte-equal regression gate on the schema PR. If existing strategy fingerprints change, the PR is rejected. |
| `'activate_trail'` BE-floor interaction with existing post-PT1 trail produces unexpected behavior | Medium | Implementation test pack must cover: (a) deadline activates trail; (b) PT1 fires later, existing trail activation no-ops because trail is already active; (c) trail with deadline activation vs trail with PT1 activation produce identical post-activation behavior given identical inputs |
| Operator approves a v5 variant for ACTIVE without formal Cycle4 cycle | Medium | LD-027-10 + CF-30 + ADR-0024 binding; B-full scope explicitly forbids promotion of Cycle4 hypotheses without formal cycle |
| `'move_to_be'` and `'activate_trail'` ignore configured pre/post_pt1 thresholds, surprising operators tuning new variants | Low | LD-027-7 documents the design choice explicitly; v5 variant YAMLs document the threshold-ignored behavior in their parameter-lock comments |
| Future research needs configurable floors for extend decision | Low | LD-027-7 explicitly notes ADR-0027-A1 amendment path; KISS now, amend later if data demands |
| Parser silently defaults on missing field for legacy profiles | Low (intentional) | LD-027-8 makes this explicit; legacy profiles default to `'enforce_floor'` (current behavior); not a silent failure |
| Multiple v5 variants confuse the project's strategy-id namespace | Low | naming convention `regime_shock_reversion_short_v5_<action_suffix>` makes the management-axis distinction explicit |
| `'activate_trail'` underperforms `'move_to_be'` on premature-noise trail exits | Medium | The trail can fire on noise before a later PT1 fill that BE-only would have captured. Path: deadline at uR=+0.10 → favorable to +0.60 → trail locks +0.30 → retraces to +0.30, trail exits → price later reaches PT1 at +1.20 (BE-only would still hold). Mitigation: v5_trail_at_deadline inference must report a held-bucket decomposition: immediate BE-floor exits, trail exits before PT1, trail exits after favorable excursion, PT1-after-deadline fills, strict-deadline opportunity cost. `'activate_trail'` is designed to dominate `'move_to_be'` under favorable-excursion paths where the trail does not preempt a later PT1 capture; it is an empirical hypothesis, not a pathwise theorem |
| Hash drift caused solely by default-field serialization on existing strategies | Medium | The schema PR's byte-equal regression gate targets BEHAVIOR equality, not strict SERIALIZATION equality. If existing-strategy hashes change solely because the new defaulted field is materialized in serialized profile / position / config snapshots, the worker MUST STOP and surface the diff. Coordinators decide between (a) omit default fields from serialization, (b) migrate snapshots with explicit schema-version note, or (c) narrow the byte-equal gate to trade-event / PnL behavior. Do NOT silently update existing-strategy hashes in the schema PR |

---

## References

- ADR-0016 (alpha decision criteria; unaffected by this ADR — thresholds re-applied to v5 inference outputs in any formal Cycle4 cycle)
- ADR-0022 (regime-conditional entry/exit gating; similar schema-extension shape; precedent for adding new profile fields)
- ADR-0023 (SignedShockMeasurement + anti-pattern #4 lock; LD-027-8 enforces anti-pattern #4 for the new enum)
- ADR-0024 (post-verdict bug re-derivation protocol; LD-027-9 explicitly preserves CF-30 / re-derivation discipline)
- PR #240 / commit `d1d7461` (MGMT-BUG-FIX-02; corrected runtime that this ADR's schema extension consumes)
- PR #241 / commit `41beaaf` (REDERIVATION-02 joint invocation memo per ADR-0024 LD-024-2; precipitating authority artifact for this ADR's Cycle4 v5 hypothesis scope)
- PR #236 / commit `ea3a2ea` (CYCLE4-S2 signed_shock arm state; precedent for schema additions that preserve existing-strategy fingerprints)
- `docs/research/qfa-611-cycle3-rederivation-02-memo.md` (REDERIVATION-02 substantive findings; precipitating context for this ADR — TBD until Track B closes)
- `docs/research/strategy-stack-mathematical-validity-audit.md` (analytical context: brief 2's hypothesis framework that includes management-axis vs signal-axis variants)
- `docs/research/cycle4-r2-hold-time-entry-gate.md` (parallel Cycle4 research thread; signal-axis variant that may interact with management-axis v5 variants in future research)
- `docs/plan/coordinator-handoff-2026-05-24.md` (broader Cycle4 chain context)

---

## Voting Record

**Operator (human):** signature pending.

**Coord-1 (dispatching coord for MGMT-BUG-FIX-02 and the original REDERIVATION-02 packet):** drafted this ADR 2026-05-24. Concur with all 10 locked decisions as written.

**Coord-2 (peer-coord):** signature pending. Independent review of the schema design, runtime semantics, and CF-binding language requested.

---

## Amendments

(None at proposal. Future amendments listed here as ADR-0027-A1, A2, etc. Notable candidates already identified:

- ADR-0027-A1: add configurable floor for `'move_to_be'` / `'activate_trail'` extend decision (per LD-027-7 deferred work).
- ADR-0027-A2: add additional `at_deadline_extension` enum values if future research surfaces new management hypotheses worth locking (e.g., `'partial_exit_and_trail'`, `'move_stop_to_pt1_runner_level'`).)
