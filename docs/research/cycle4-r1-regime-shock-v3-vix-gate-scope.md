# CYCLE4-R1: `regime_shock_reversion_short_v3` VIX-gate scoping memo

## Status

`RESEARCH_TIER_DEFERRED`. This memo SCOPES a new strategy_id
hypothesis. It is **not** an implementation, **not** a parameter
proposal for `regime_shock_reversion_short_v2`, and **not** an
amendment to ADR-0016 or ADR-0023. Per CF-41, any implementation
requires a new `strategy_id` (`regime_shock_reversion_short_v3`) with
a new parameter-lock manifest entry.

The implementation work proper (~3 days of TS/YAML/test/fixture work)
is a separate worker dispatch that consumes this memo as evidence.

## Authority

- Backlog: `docs/plan/new_app_v1_ticket_backlog_v6.csv` row `CYCLE4-R1`
  (`P3, 3.0d, new_cycle4_research_carryforward`).
- Substrate: post-fix Cycle3 held-out artifact at fingerprint
  `ede3b8d5...` (commit `ffeea42`).
- VIX/VXN source: `artifacts/regime/regime-labels.json` (per-session
  labels with `primary_percentile`) joined to trade dates.
- Cross-references: ADR-0023 LD-023-2 (new strategy_id required;
  cannot tune v2 in place), CF-41 (anti-tuning posture for locked
  YAMLs), LD-023-4 anti-pattern #4 (fail-closed on missing features
  — relevant to gate implementation).
- Carry-forward authority: ADR-0024 invocation memo §"Apr 1-8
  regime-pinning finding" deferred this work to a future cycle
  research candidate.

## Hypothesis

`regime_shock_reversion_short_v2` over-fires in two distinct regime
conditions, producing trades that consume capital and management
overhead with near-zero net edge. Adding entry-gate predicates that
suppress firing under those conditions would:

1. **Reduce trade frequency** by ~37% in the held-out corpus.
2. **Lift PF** from 1.418 to ~1.676 (verified on post-fix substrate).
3. **Preserve** the strategy's edge tiers (calm and extreme VIX).

The new strategy ID is `regime_shock_reversion_short_v3`.

## Substrate evidence

### Per-VIX-percentile bucket on post-fix corpus

VIX percentile is computed daily against a rolling window per
`artifacts/regime/regime-labels.json` schema. Joining the post-fix
trade artifact (571 trades, 17 test sessions) to per-session VIX
percentiles:

| Bucket | Sessions | Trades | Trades/sess | Win% | PF | Net |
|---|---:|---:|---:|---:|---:|---:|
| calm (0–33%) | 4 | 140 | 35.0 | 52.1% | **1.560** | **+$408** |
| mid (33–67%) | 0 | 0 | — | — | — | — |
| **elevated (67–85%)** | **4** | **209** | **52.2** | **47.8%** | **0.934** | **−$103** |
| extreme (85–100%) | 9 | 222 | 24.7 | 52.3% | **1.715** | **+$1,567** |

Observations:
- **The "elevated" bucket is the over-fire zone.** 52 trades/session
  vs ~25-35 elsewhere; PF 0.934 means it loses slightly per dollar
  risked; the 209 trades net only -$103.
- **The "extreme" bucket is the best tier**, not the worst. PF 1.715,
  highest avg PnL per trade. The strategy thrives in extreme VIX.
- **The "calm" bucket is also profitable** at PF 1.560, lower
  frequency but positive edge.
- **No trades in the "mid" bucket** in the test window — partial
  evidence the regime classifier doesn't fire here (consistent with
  the strategy's regime conditioning: it only trades `high` and
  `low` regimes).

### Counterfactual: skip the elevated bucket entirely

| Metric | Baseline | After elevated-bucket skip |
|---|---:|---:|
| Trades | 571 | 362 |
| Win% | 50.6% | 51.7% |
| PF | 1.418 | **1.676** |
| Net | $1,872 | $1,975 |
| Δ trades | — | **−209** |
| Δ net | — | **+$103** |

**Filtering removes 37% of trades while improving net P&L by $103
and lifting PF by +0.258.** This is the canonical evidence for the
gate's value.

### What the bucket boundaries should be

The 67/85 percentile split was chosen post-hoc to align with terciles
+ an extreme cut. Worth flagging to the amendment-cycle implementer:
sensitivity-testing the boundaries (e.g., 60/80, 70/90, quartiles)
should be part of v3 design. The boundaries should be parameter-lock
manifested values, not magic numbers in code.

## Gate specification (proposed for v3 implementation)

### Predicate: `firstRegimeShockReversionShortV3VixGateRejection`

```typescript
// Pseudocode; actual implementation goes in
// apps/strategy_runtime/src/strategies/regime_shock_reversion_short_v3.ts
// alongside the existing rejection chain.

function firstRegimeShockReversionShortV3VixGateRejection(
  snapshot: StrategyFeatureSnapshot,
  parameters: RegimeShockReversionShortV3StrategyParameters,
  reasons: string[],
): string | undefined {
  const vixPct = snapshot.context.vix_prior_close_percentile;

  // Fail-closed per LD-023-4 anti-pattern #4
  if (vixPct === null) {
    return 'regime_shock_reversion_short_v3:vix_percentile_unavailable';
  }

  reasons.push(`vix_pct:${round4(vixPct)}`);

  if (
    vixPct >= parameters.vix_pct_overfire_lower_bound
    && vixPct < parameters.vix_pct_overfire_upper_bound
  ) {
    return 'regime_shock_reversion_short_v3:vix_in_overfire_band';
  }

  return undefined;
}
```

The gate runs in addition to (not replacing) the existing v2 rejection
chain: session checks, regime checks, signed-shock threshold checks.

### Parameter-lock YAML additions

```yaml
# config/strategies/regime_shock_reversion_short_v3.yaml

version: 1
strategy_id: regime_shock_reversion_short_v3
parameters:
  # All parameters inherited from regime_shock_reversion_short_v2
  vwap_reference: session_vwap
  opening_window_minutes: 30
  high_shock_threshold_neg: 2.20
  high_shock_threshold_pos: 2.00
  low_shock_threshold_neg: 2.90
  low_shock_threshold_pos: 2.70
  stop_sigma_multiple: 0.8
  target_1_rr: 1.2
  target_2_rr: 2.0
  confidence_score_high: 0.72
  confidence_score_low: 0.58
  minimum_target_rr: 1.0

  # NEW (v3-specific):
  vix_pct_overfire_lower_bound: 0.67  # inclusive
  vix_pct_overfire_upper_bound: 0.85  # exclusive
```

The v3 parameters MUST be locked to a new `parameter_lock_hash`;
identical-to-v2 parameter values get a different hash because the
`strategy_id` and v3-specific fields are part of the canonicalized
JSON.

### Snapshot context field requirement

The gate consumes `snapshot.context.vix_prior_close_percentile`.
That field already exists in `regime-labels.json` per session
(field: `primary_percentile`). Plumbing it into the snapshot context
requires:

1. Add `vix_prior_close_percentile: number | null` to the
   `StrategyFeatureSnapshotContext` interface.
2. Populate it from the session's regime label during snapshot
   construction.
3. Update the `null` semantics: missing → strategy MUST fail closed
   (per LD-023-4 anti-pattern #4).
4. Schema fingerprint changes; cycle-boundary discipline applies.

This is a schema-level addition. Per the QFA-7xx-A schema discipline
pattern (PR #182 cited in `docs/plan/engineer-dispatch-prompt.md` §3
Step 2), the schema PR is independent of the strategy PR — and it
must pass a byte-identical regression gate on all then-active
strategies. v2 doesn't consume the new field, so its outputs must
remain byte-equal after the field is added.

### Sustained-high regime gate — DEFER

A more sophisticated gate could combine VIX percentile with regime
persistence: "skip when regime has been continuously `high` for ≥ N
sessions, indicating a directional pin rather than a mean-reversion
opportunity." This was explored in the SIZING-R1 substrate analysis.

However, the simple "consecutive high days" heuristic catches the
entire post-fix test window (since the regime classifier almost never
fires `mid`/`low` mid-corpus). The right operational definition would
need:
- A "regime stability" feature (variance of regime label over past N
  sessions, or count of regime transitions in past N sessions)
- Sensitivity testing of the persistence threshold
- Forward-paper validation

This is a SEPARATE hypothesis from the VIX-percentile gate and should
not be conflated into v3. **v3 = VIX-percentile gate only.** A
hypothetical v5 could combine VIX-percentile + persistence gates if
both prove out; or persistence-gating could be its own v4-persist
hypothesis (orthogonal to the CYCLE4-R2 time-delay v4 candidate).

## What the v3 implementation dispatch needs to do

This memo deliberately does NOT write the code. It specifies the
hypothesis and the gate predicate; the implementation worker takes it
from there. The implementation chain follows the existing pattern:

### Files to create (worker-dispatch scope)

1. **`config/strategies/regime_shock_reversion_short_v3.yaml`** — new
   parameter-lock YAML (per spec above).
2. **`apps/strategy_runtime/src/strategies/regime_shock_reversion_short_v3.ts`**
   — new strategy generator. Inherits/mirrors v2 logic; adds the
   VIX-gate predicate to the rejection chain.
3. **`apps/strategy_runtime/src/config/strategy-config.ts`** —
   register v3 in `StrategyConfigById`, default config,
   `STRATEGY_CONFIG_FILE_NAMES`, ranking priority, validator.
4. **`apps/strategy_runtime/src/strategies/registry.ts`** — register
   v3 generator + synthetic fixture.
5. **`apps/strategy_runtime/src/management/management-profiles.ts`**
   — v3 management profile (can be identical to v2's profile; the
   gate is entry-side, not management-side).
6. **`apps/strategy_runtime/src/management/types.ts`** — register v3
   in `ManagementProfileId`.
7. **`config/strategies/snapshots/regime_shock_reversion_short_v3.json`**
   — consumed-YAML snapshot test.
8. **`apps/strategy_runtime/tests/unit/regime-shock-reversion-v3.test.ts`**
   — gating unit tests; mirror v2's tests + add VIX-gate-specific
   cases (in-band rejection, out-of-band acceptance,
   missing-percentile fail-closed).
9. **`apps/strategy_runtime/tests/unit/strategies/regime-shock-reversion-v3-sizing-uniformity.test.ts`**
   — sizing uniformity test (mirror v2 per ADR-0022 LD-022-6 +
   ADR-0023 LD-023-5 anchor invariance).
10. **`artifacts/strategy-selection/qfa611-cycle4-parameter-locks.json`**
    — new parameter-lock manifest entry (or extend the existing if
    Cycle4 is active; otherwise this is a Cycle4 seed artifact).

### Schema PR prerequisite

If `vix_prior_close_percentile` isn't already on
`StrategyFeatureSnapshotContext`, the schema PR lands FIRST as a
separate ticket (let's call it `CYCLE4-S1` for now). Pattern matches
QFA-7xx-A PR #182:

1. Byte-identical regression fixture for v2 + REJECTed Cycle3
   strategies (must pass with the new field added but unused).
2. Add the field to the schema, populate from regime labels.
3. v2's outputs must be byte-equal before and after the schema
   addition.

Schema PR scope is small (< 50 lines TS + per-strategy regression
fixtures) but must observe CF-28 determinism + the no-lookahead
discipline (the field is per-session prior-close, so causally clean
by construction).

### Held-out validation regeneration

After v3 lands, the Cycle4 (or Cycle3-amended) held-out validation
artifact must be regenerated. This is **not** a re-derivation of
Cycle3 (ADR-0024 was already invoked once); it's a NEW validation
of v3 as a fresh strategy_id. The artifact lives at
`artifacts/held-out-validation/cycle4/regime_shock_reversion_short_v3-*.json`
or similar (Cycle4 path TBD).

The v3 verdict is determined against ADR-0016 Stage 1 thresholds AS
WRITTEN — no threshold revision. CF-41 anti-tuning posture: v3 must
clear the same bar v2 did, not a relaxed bar.

## Expected v3 verdict (in-sample on the held-out corpus)

Applying the gate counterfactually to the post-fix v2 trade
distribution (note: this is an APPROXIMATION; the v3 worker dispatch
will produce the canonical verdict):

| Metric | v2 (post-fix) | v3 estimate | ADR-0016 threshold | Pass? |
|---|---:|---:|---:|---|
| Trades | 571 | 362 | ≥ 300 | pass |
| Win rate | 50.61% | ~51.7% | — | (no threshold) |
| PF | 1.418 | ~1.676 | ≥ 1.35 | pass |
| Sharpe | 5.054 | (likely higher) | ≥ 1.0 | pass |
| DSR | 3.78 | (likely higher) | ≥ 0 | pass |
| Max DD | 0.78% | (similar or lower) | ≤ 8% | pass |
| Hurdle ann. return | 15.22% | (likely close) | ≥ 12% | pass (close call) |

**Estimated verdict: ADVANCE_TO_PAPER**, with the caveat that
in-sample approximations are unreliable. The worker dispatch produces
the canonical verdict.

The "hurdle ann. return" line is the close call — annualized return
on a smaller trade count may compress slightly. If v3 fails this
threshold, the verdict could flip to REJECT — which is the
ADR-0023 LD-023-2 anti-near-miss-tuning trap that we MUST be
prepared to accept honestly.

## Anti-pattern discipline (LD-023-4)

The VIX-percentile gate is NOT a forbidden anti-pattern. Specifically:

- **#1 — Raw VIX numerical threshold**: forbidden. v3 uses VIX
  *percentile* (rolling-window relative), not raw value. Percentile
  is a regime-substrate-aligned feature per ADR-0013/0014/0015.
- **#2 — Continuation-cluster duplicate**: not applicable. v3 is in
  the mean-reversion family, not continuation.
- **#3 — Fixed-tick liquidity sweep geometry**: not applicable.
- **#4 — Silent fallback to price-only logic**: v3 explicitly fails
  closed when `vix_prior_close_percentile` is null. Compliant.
- **#5 — Same strategy_id with changed parameters after a verdict**:
  v3 is a NEW strategy_id, not an edit to v2. Compliant per LD-023-2.

The new gate is, mechanistically, an EXTENSION of the existing
regime-conditional gating in ADR-0022 — different anchor (VIX
percentile vs the regime label), same fail-closed discipline.

## Forward validation requirements (the CF-52 reality)

The in-sample counterfactual lift (PF 1.418 → 1.676) is suggestive
but not sufficient. Per CF-52 and the broader paper-observation
discipline, v3 must:

1. **Pass the standard held-out validation** against ADR-0016
   thresholds (worker dispatch will compute).
2. **Be exposed to a forward paper window** of ≥45 days minimum (CF-52
   floor; ideally ≥6 months for sizing-decision confidence per the
   SIZING-R1 deferred questions).
3. **Demonstrate the gate's empirical predictive value** — the
   in-sample 67-85% bucket was the over-fire zone; forward data could
   show different bucket boundaries are operative.
4. **Not be paired with sizing changes simultaneously.** A v3
   dispatch with default-size and a SIZING-R1-derived sizing
   amendment are SEPARATE policy decisions; conflating them would
   destroy attribution.

## Deferred questions

1. **Bucket boundary sensitivity.** Is 67-85% optimal, or would
   65-83% / 70-90% perform better? Sensitivity audit per ADR-0016
   discipline.
2. **Persistence-based gate combined with VIX-bucket.** If v3 holds
   on its own, does a v5 with combined VIX-bucket + regime-persistence
   add additional edge?
3. **Cross-strategy gate sharing.** If the elevated-VIX over-fire is
   a market-property (not a strategy-property), would the gate be
   useful on other entry-gated strategies (e.g., the rejected
   `vwap_overnight_reversal_*`)?
4. **Stability across volatility regimes.** The current corpus is
   Feb-Apr 2026 — a sustained-volatility window. Does the gate hold
   in a low-vol regime where the elevated bucket may have different
   characteristics?
5. **Real-world execution.** The gate is causally clean (uses
   prior-close VIX percentile, no look-ahead). Forward paper will
   reveal any operational issues (data latency, regime label
   computation lag at session open, etc.).

## What this memo supports and does not support

**Supports:**

1. Filing `regime_shock_reversion_short_v3` as the next Cycle4
   amendment-cycle dispatch.
2. The gate spec as a STARTING POINT for the v3 worker. Boundaries,
   parameter names, and predicate wording are subject to the
   amendment dispatch's own technical judgment.
3. The expected verdict (ADVANCE_TO_PAPER) AS A BASELINE
   EXPECTATION, not a commitment.
4. The schema-PR prerequisite identification (`CYCLE4-S1` for
   `vix_prior_close_percentile` field addition).

**Does NOT support:**

1. Any change to `regime_shock_reversion_short_v2`. Per CF-41 / LD-
   023-2, v2 is locked.
2. Any ADR threshold revision. ADR-0016 thresholds remain as-is.
3. Combining the VIX-gate with a sizing change. SIZING-R1 evidence
   pack is independent of CYCLE4-R1.
4. A specific bucket boundary commitment without sensitivity
   testing.

## Caveats and bounds

- All bucket numbers from a single 17-session test window. n=4 per
  bucket is statistically anemic — bucket-level CIs are very wide.
- The 67/85 boundaries were chosen post-hoc by the coordinator
  session. Worker dispatch should re-test boundary choice as part of
  v3 design.
- The counterfactual treats "skip elevated bucket" as removing
  those trades from the sequence. Real v3 implementation would
  produce a DIFFERENT trade sequence — different micro-structure
  drift during the skipped windows, possibly different signal
  arming on subsequent days.
- Per ADR-0024 LD-024-4, no parameter lock, strategy code, or
  regime substrate was modified by this research.
- Single-strategy scope.

## Cross-references

- `artifacts/held-out-validation/cycle3/regime_shock_reversion_short_v2-feb-mar-apr-2026.json`
  (post-fix substrate, fingerprint `ede3b8d5...`)
- `artifacts/regime/regime-labels.json` (VIX percentile source per
  session)
- `docs/research/sizing-r1-post-fix-kelly-tiered-rederivation.md`
  (sizing-side research; independent of this gate)
- `docs/research/cycle4-r2-hold-time-entry-gate.md` (parallel
  hypothesis; orthogonal to this VIX gate)
- `docs/research/qfa-611-cycle3-rederivation-memo.md` (verdict-side
  re-derivation)
- `docs/research/qfa-611-cycle3-rederivation-invocation-memo.md`
  (deferred this work as Cycle4 candidate)
- ADR-0013 / ADR-0014 / ADR-0015 (regime substrate; preserved
  through this research)
- ADR-0016 (alpha decision criteria; thresholds applied AS-IS to v3)
- ADR-0022 (regime-conditional entry gating; precedent for entry-
  condition discipline)
- ADR-0023 (anti-pattern lock; v3 must comply with all five LD-023-4
  anti-patterns)
- ADR-0024 (re-derivation protocol; bounded the substrate used here)
- PR #182 (QFA-7xx-A schema discipline; pattern for the schema PR
  prerequisite)
- CF-30 / CF-41 / CF-44 / CF-45 / CF-52 (carry-forwards bounding any
  v3 amendment)
- CYCLE4-R2 (hold-time gate hypothesis; orthogonal to this)
- CYCLE4-S1 (proposed schema PR for `vix_prior_close_percentile`
  field — to be filed separately as a Cycle4 prerequisite)
