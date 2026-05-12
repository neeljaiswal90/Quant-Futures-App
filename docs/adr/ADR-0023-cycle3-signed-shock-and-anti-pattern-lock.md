# ADR-0023: Cycle3 SignedShockMeasurement canonical field shape + anti-pattern lock

## Status

Accepted

## Context

Phase 5 Cycle2 closed with `phase_6_dispatch_authorized=false`, one
economically credible near-miss (`regime_mean_reversion_short`, PF 1.288),
pre-committed retirement of the `liquidity_sweep_reversal` family, and
continued failure of the original continuation family. The closure memo
(commit `7dd6142`) recorded three open Cycle3 decisions; the post-Cycle2
coordinator review resolved them: GO on Cycle3, TEST the overnight-to-intraday
reversal family as the highest-priority new hypothesis, and REMOVE dormant plus
retired strategies from `ACTIVE_STRATEGY_IDS`.

Cycle3 introduces multiple new families that consume a signed-shock signal
against different anchor references: session VWAP, prior-day close, etc.
Without a canonical typed field shape, downstream consumers cannot distinguish
"price-vs-VWAP signed deviation" from "price-vs-prior-close signed deviation";
the artifacts become semantically ambiguous. ADR-0022 LD-022-7 introduced
VWAP-anchored `signed_shock` for the Strategy 3 family but did not pin a
project-wide canonical shape. ADR-0023 closes that gap.

Separately, the project has repeatedly found that informal anti-pattern
discipline is insufficient under empirical pressure: QFA-402 saw a post-hoc
threshold-relaxation attempt, rescinded by ADR-0011; CF-30 anti-tuning required
CF-41/CF-44 reaffirmation after Cycle2's near-miss; the deferred Strategy 1
opening-drive was tempted back into scope multiple times before being formally
excluded. ADR-0023 elevates the cumulative anti-pattern list to ADR-level
methodology so future cycles cannot silently re-introduce known failure modes.

## Locked decisions

### LD-023-1: Canonical SignedShockMeasurement field shape

Any strategy emitting a signed-shock measurement consumes and produces the
following typed shape:

```typescript
export interface SignedShockMeasurement {
  readonly value: number | null;
  readonly anchor_type: 'vwap' | 'prior_close';
  readonly anchor_value: number | null;
  readonly sigma_basis: 'atr_14' | 'sigma_pts';
  readonly sigma_basis_value: number | null;
}
```

Invariants:

```text
if value != null:
  anchor_value != null
  sigma_basis_value != null

if anchor_value == null or sigma_basis_value == null:
  value == null
  consuming strategy MUST fail closed
```

The specific VWAP computation variant, such as session-cumulative or
opening-window, is implementation detail locked at strategy parameter time, not
enum-level distinction. The `anchor_type` enum stays minimal; future ADRs may
extend it if a strategy explicitly needs anchor-type-level distinction for
sizing, per LD-023-5 below.

### LD-023-2: CF-41 reaffirmation for Cycle3

Any new strategy hypothesis in Cycle3, or any future cycle, uses a new
`strategy_id`. No edits to existing locked YAMLs after a QFA-611 verdict
commits the strategy's verdict to main. This applies to:

- The 4 Cycle1 strategies: `trend_pullback_{long,short}`,
  `breakout_retest_long`, `breakdown_retest_short`
- The 4 Cycle2 strategies: `regime_mean_reversion_{long,short}`,
  `liquidity_sweep_reversal_{long,short}`

Successor hypotheses, such as `regime_shock_reversion_short_v2` in Cycle3, are
NEW `strategy_id`s with NEW parameter-lock manifest entries. The original
verdicts stand as historical record.

### LD-023-3: Dormant/retired strategy removal authorization

Strategies that have been:

- Dormant, meaning zero trades, across 2+ consecutive QFA-611 cycles on the
  same evidence corpus, OR
- REJECTED for cause-asymmetry / cause-specific-failure-mode, OR
- Pre-committed retired per their own YAML clause

are eligible for removal from `ACTIVE_STRATEGY_IDS` at the next cycle dispatch.
The generator code stays registered, in a `CANDIDATE_STRATEGY_IDS` or
`REGISTERED_INACTIVE_STRATEGY_IDS` constant, for code/test/audit lineage. The
YAML and lock-manifest entries stay byte-locked. Removal is a one-line change
to the active list; no parameter or code modification.

A removed strategy may be revived in a future cycle ONLY via a new
`strategy_id` with a new parameter-lock manifest, per LD-023-2.

For Cycle3 specifically, the following are removed from `ACTIVE_STRATEGY_IDS`:

- `breakout_retest_long`, `breakdown_retest_short` (dormant)
- `liquidity_sweep_reversal_long`, `liquidity_sweep_reversal_short` (retired)
- `trend_pullback_long`, `trend_pullback_short` (Cycle1+Cycle2 REJECT)
- `regime_mean_reversion_long`, `regime_mean_reversion_short` (Cycle2 verdicts
  locked; near-miss anchor preserved via documentation, not re-test)

### LD-023-4: Binding anti-pattern list

The following are forbidden in Cycle3 and beyond unless explicitly
re-authorized by a future ADR:

1. Raw VIX numerical threshold strategies, meaning gating on `vix_value < N` or
   `vix_value > N` instead of `regime_label`. The QFA-212 regime substrate
   (ADR-0013/0014/0015) is the canonical state classifier; raw VIX is
   diagnostic only per ADR-0022 LD-022-1.

2. New continuation-cluster duplicates. The existing `breakout_retest_*` and
   `trend_pullback_*` families exhausted the continuation hypothesis space on
   the Feb-Mar-Apr 2026 corpus. Adding "opening-range breakout", "EMA pullback
   v2", "breakout-retest with relaxed gates", "trend continuation with stronger
   filter", etc. is forbidden.

3. Fixed-tick liquidity sweep geometry. The Cycle2 `liquidity_sweep_reversal`
   family used fixed-tick sweep geometry and was retired per pre-committed
   clause. Any future sweep-reversal hypothesis must use a meaningfully
   different geometry, such as MBO-confirmed sweep with depth-imbalance gating,
   not L2-approximated sweep with price-only confirmation.

4. Silent fallback to price-only logic when regime/signed-shock fields are
   missing. Per ADR-0022 LD-022-8 and CF-39, a regime-gated or
   signed-shock-gated strategy MUST fail closed when its required features are
   unavailable. Adding "if `regime_label` is unknown, use price-only entry"
   fallbacks is forbidden.

5. Same `strategy_id` with changed parameters after a verdict. Per CF-30,
   CF-41, CF-44, and LD-023-2. The `strategy_id` is bound to its parameter-lock
   manifest entry; changing the manifest after a verdict is the anti-tuning
   trap.

Re-introducing any of these requires an explicit ADR amendment documenting the
external methodological justification.

### LD-023-5: Anchor-invariance test requirement

For any strategy emitting candidates that consume `SignedShockMeasurement`
across multiple anchor types, such as a strategy that may use a `'vwap'` anchor
in some configurations and a `'prior_close'` anchor in others, the
sizing-uniformity test required by ADR-0022 LD-022-6 is EXTENDED to also assert
anchor invariance.

For identical underlying market state, identical risk state, identical
`sigma_basis`, and equal `signed_shock.value` magnitude,
`candidate.risk_points` and `candidate.targets[].quantity_fraction` MUST be
identical regardless of `anchor_type`. The `candidate.reasons[]` array MAY
differ, since it documents the specific anchor used. `candidate.confidence` MAY
differ, since it documents edge expectation, not risk budget.

Implementation: the parameterized test matrix from LD-022-6, such as 15-cell
or 12-cell, gains an additional dimension for `anchor_type` when applicable,
expanding to at least `2 * (LD-022-6 cell count)` cells.

A strategy that locks to a single `anchor_type` at parameter time is exempt
from the anchor-invariance dimension, since it can never emit candidates with a
different anchor.

## What ADR-0023 does NOT do

- Does NOT modify ADR-0013/0014/0015 regime substrate.
- Does NOT modify ADR-0016 alpha thresholds.
- Does NOT modify ADR-0022 regime-conditional gating. LD-022-7 remains
  authoritative for the existing `regime_mean_reversion` family.
- Does NOT introduce new `ACTIVE_STRATEGY_IDS`. Cycle3 roster changes land via
  QFA-CYCLE3-ROSTER-PRUNE per the Cycle3 governing plan.
- Does NOT pin Cycle3 strategy-specific anchor choices. Those are
  parameter-lock-time decisions per individual strategy YAMLs.
- Does NOT extend the `anchor_type` enum beyond `'vwap'` and `'prior_close'`.
  Future enum extensions require an ADR amendment.
- Does NOT override the LD-022-7 Strategy 3 family scoping rule. That rule
  remains: `regime_mean_reversion_*` uses VWAP-anchored `signed_shock` per
  ADR-0022. LD-023-1 generalizes the field shape to apply to ANY
  signed-shock-emitting strategy; ADR-0022's anchor-family-binding remains
  scoped to Strategy 3 only.

## Consequences

- QFA-7xx-A2 (Cycle3 schema extension) adds the `SignedShockMeasurement`
  TypeScript type per LD-023-1 and wires it into the snapshot constructor as
  needed by Cycle3 consumers.
- QFA-7xx-S1 (`vwap_overnight_reversal_{long,short}`) consumes
  `SignedShockMeasurement` with `anchor_type='vwap'` per its parameter YAML.
- QFA-7xx-S3-v2 (`regime_shock_reversion_short_v2`) consumes
  `SignedShockMeasurement` with `anchor_type='vwap'` OR
  `anchor_type='prior_close'` per its parameter YAML, with coordinator decision
  at parameter-lock time.
- QFA-CYCLE3-ROSTER-PRUNE removes 8 strategies from `ACTIVE_STRATEGY_IDS`;
  Cycle3 dispatches with `ACTIVE_STRATEGY_IDS = 3`, the new families.
- `effective_trial_count` for QFA-611-Cycle3 = 3, per CF-29
  count-agnostic methodology and the per-cycle independent-selection-round
  principle.
- The anti-pattern list (LD-023-4) is binding methodology; any future cycle
  dispatch that proposes a forbidden pattern requires an ADR amendment.
- The anchor-invariance test (LD-023-5) extends ADR-0022 LD-022-6
  sizing-uniformity test to multi-anchor strategies.

## Carry-forward additions

- CF-46 (Cycle3 governing plan): Hypothesis-redesign priority order; binding
  anti-pattern list. This ADR codifies CF-46's anti-pattern list as LD-023-4.
- CF-47 (Cycle3 governing plan): Multi-anchor signal definitions use canonical
  typed field shape. This ADR codifies CF-47 as LD-023-1.
- CF-48 (Cycle3 governing plan): Dormant + retired strategies removed at next
  cycle dispatch. This ADR codifies CF-48 as LD-023-3.
- CF-49 (NEW): Anchor-invariance is a required test dimension for any strategy
  emitting candidates across multiple anchor types. Codified as LD-023-5.

## Voting record

All 5 locked decisions (LD-023-1 through LD-023-5) accepted on coordinator
review with §7a/§7b/§7c/§7d sub-decisions locked from the post-Cycle2 plan. The
roster scope, 8 strategies to INACTIVE for Cycle3, not just 4 dormant/retired,
was confirmed during ADR-0023 drafting as the "clean hypothesis cycle"
interpretation requires extending CF-48 to also cover Cycle1+Cycle2 strategies
whose verdicts are locked.
