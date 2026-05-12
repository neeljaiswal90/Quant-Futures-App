# ADR-0022: Regime-conditional entry/exit gating clarification

## Status

Accepted

## Context

QFA-611 Cycle1 closed (PR #179, merged 2026-05-11 at 84df378) with
`phase_6_dispatch_authorized=false` and `execution_fragility=true`. Cycle2
expands the 4-strategy roster with `regime_mean_reversion_long` and
`regime_mean_reversion_short` (collectively the "Strategy 3 family") and
conditionally `liquidity_sweep_reversal` (Strategy 2, now eligible from the
Cycle1 fragility flag). Strategy 3 is the first strategy whose entry/exit
logic explicitly varies by `regime_label`.

This ADR codifies what regime-conditional behavior is allowed at the
strategy level so that future regime-gated strategies do not silently
re-invent methodology.

The literature anchoring this decision conditions on **relative**
volatility states (e.g., above-median VIX, above-average implied variance)
rather than raw fixed thresholds. Della Corte, Kosowski, Liu, and Wang
document overnight-to-intraday reversal across equity-index futures tied to
liquidity provision; Jones, Pyun, and Wang find short-horizon index
reversal becomes more negative when implied variance is high; Grant, Wolf,
and Yu document intraday reversal after large opening moves in U.S.
stock-index futures; Monoyios and Sarno show stock-index futures mean
reversion is nonlinear and strengthens with deviation magnitude; the
NY Fed e-mini work shows reversal amplifies when end-of-day order imbalance
coincides with heightened uncertainty; Akbas et al. show directional
reversal asymmetries vary across contexts.

Allowing each strategy to recode its own volatility taxonomy would
silently enlarge the hypothesis set, exactly the problem Harvey, Liu, and
Zhu warn about in asset-pricing research and exactly the search inflation
Bailey and Lopez de Prado adjust for via the Deflated Sharpe Ratio.
ADR-0013/0014/0015 already locked a single canonical regime substrate.
ADR-0022 makes that substrate the authoritative input to any regime-gated
strategy.

## Locked decisions

### LD-022-1: Regime-conditional gating is allowed

A strategy generator MAY consume `snapshot.context.regime_label` (from
ADR-0013's substrate) and produce different gate decisions across regime
values. The set of eligible setup types per regime is part of the strategy
specification, locked at parameter-lock-hash time, and consumed by the
QFA-611 verdict driver as part of the strategy fingerprint.

### LD-022-2: High-regime gate requires a 2D condition

For any strategy that gates on `regime_label == "high"`, the gate MUST
also condition on a signed price context (a `signed_shock` value, see
LD-022-7 for measurement). High-regime + reversion setups MUST NOT fire
uniformly across the sign of the shock; the direction of the asymmetry is
setup-specific (see LD-022-5) and locked at strategy parameter time, not
in this ADR.

```
regime_label == "high" AND signed_shock crosses the configured reversion threshold
  -> mean-reversion family setup eligible (per the strategy's signed
     threshold direction)

regime_label == "high" AND signed_shock crosses in the opposite direction
  -> mean-reversion family setup NOT eligible
     (route to continuation family if one exists; else no setup)
```

### LD-022-3: Low-regime allows low-conviction reversion under a stricter shock hurdle

In `regime_label == "low"`, a mean-reversion strategy MAY emit a reversion
candidate, but MUST satisfy BOTH:

1. **Stricter signed_shock hurdle**: the magnitude threshold required in
   low-regime MUST be larger (in absolute σ-normalized terms) than the
   high-regime threshold. Monoyios and Sarno's nonlinear deviation result
   and Della Corte's VIX-state evidence both support that low-vol
   reversion is detectable only on larger deviations.
2. **Lower confidence**: `candidate.confidence` MUST be set lower than
   the equivalent high-regime candidate for the same signed_shock
   magnitude.

Per LD-022-6, the lower confidence MUST NOT alter `candidate.size`,
`risk_points`, or any other risk-budget-consuming field.

### LD-022-4: Mid and transition_pending are non-trading states

`regime_label` in `{"mid", "transition_pending"}` MUST produce no
candidate for new entries (gate_state may be "blocked" or "waiting").
Open positions opened in a different regime are NOT eagerly closed on
regime change; they exit per the strategy's locked stop/target/time-stop
logic (see LD-022-9).

`regime_label == "unknown"` (missing or malformed) MUST produce
`gate_state="blocked"` with `reason="missing_regime_label"`. See LD-022-8
for the full fail-closed policy.

### LD-022-5: Threshold asymmetry is allowed; direction is setup-specific

The negative and positive `signed_shock` thresholds MAY be asymmetric in
magnitude. The direction and magnitude of the asymmetry is locked per
strategy at parameter-lock time, NOT in this ADR. The literature shows
directional asymmetries are setup-specific:

- E-mini overnight-drift reversal (NY Fed) is stronger after negative
  end-of-day demand shocks due to dealer risk-bearing collapse during
  selloffs.
- Stock-index futures opening overreaction (Grant/Wolf/Yu) is more
  pronounced after large positive opening moves.
- Equity overnight/daytime reversal patterns (Akbas et al.) show
  directional asymmetry varying across context.

ADR-0022 commits to "asymmetric thresholds permitted"; ADR-0022 does NOT
commit to any universal sign ordering.

### LD-022-6: Regime-conditional sizing is forbidden

Across all regime-label and signed_shock cells where a setup is eligible:

- `candidate.risk_points` MUST be derived from the same σ-normalized
  rule.
- `candidate.targets[].quantity_fraction` MUST be identical.
- The eventual integer contract count from the position-sizing layer
  MUST resolve identically given the same risk state, equity, contract
  specifications, and stop distance.
- `candidate.confidence` and `candidate.reasons` MAY differ across cells
  (they document edge expectation and trace, not risk budget).
- `candidate.candidate_id` and other identifiers naturally differ.

**Required test (15-cell minimum matrix):** any regime-gated strategy
MUST include a parameterized sizing-uniformity test covering at least 3
regimes by at least 5 signed_shock values. The test asserts that when a
candidate is emitted, the risk-budget-bound fields are identical to a
baseline computed in any other cell with the same underlying market and
risk state. CI enforces.

### LD-022-7: signed_shock is measured against a volume-weighted fair-value anchor (Strategy 3 family scope)

For the `regime_mean_reversion_long` / `regime_mean_reversion_short`
family, `signed_shock` MUST be a σ-normalized deviation of current price
from a volume-weighted fair-value reference. The specific reference (e.g.,
session VWAP, opening-window VWAP, prior-day-close-anchored VWAP), the
window length, and the σ measurement are strategy parameters locked at
parameter-lock-hash time.

**Scope clarification:** LD-022-7 binds the Strategy 3 family. Future
regime-gated strategies in other families MAY use a different fair-value
reference, but only via explicit ADR amendment. A free-form per-strategy
composite anchor is NOT permitted under ADR-0022; the constraint is
"volume-weighted fair-value anchor" or an ADR-authorized alternative.

The Della Corte et al. result that the equity-index futures reversal
strategy remains economically and statistically similar across 15-, 45-,
and 60-minute volume-weighted windows is the empirical anchor for this
choice.

### LD-022-8: Fail-closed feature-availability policy

For any strategy depending on regime/VIX/opening-range features:

```
snapshot.context.regime_label missing or "unknown":
  -> gate_state = "blocked"
  -> reason = "missing_regime_label"
  -> no candidate emitted

snapshot.context.vix_value missing OR snapshot.context.vix_fresh == false:
  -> IF vix_value is diagnostic-only for this strategy (default for
     Strategy 3 family):
       proceed; append "vix_stale_diagnostic_only" to candidate.reasons
  -> IF vix_value is a primary gate (allowed ONLY with explicit ADR
     amendment authorizing raw-VIX-as-primary):
       gate_state = "blocked"; reason = "vix_unavailable"

snapshot.context.opening_range_{high,low} missing:
  -> IF the strategy variant requires opening_range:
       gate_state = "blocked"; reason = "opening_range_unavailable"
  -> ELSE:
       proceed; opening_range is optional context for this variant
```

NO fallback to "trade anyway based on price alone" is permitted for a
regime-gated strategy. Adding such a fallback requires explicit ADR
amendment. Per CF-39, silent degradation from regime-gated to
non-regime-gated behavior is the explicit anti-pattern.

`vix_fresh` is defined source-dependently:

- Daily VIX data (current source, `config/research/vix-vxn-daily-*.json`):
  fresh if the VIX data's trading date matches the session date.
- Intra-session VIX (if a future cycle adds a real-time feed): fresh if
  the latest tick is within 60 seconds of the current bar. CBOE
  disseminates spot VIX every 15 seconds during RTH and GTH and overnight,
  so a 60-second window is conservative relative to the dissemination
  cadence.

### LD-022-9: Position management on regime transition

When `regime_label` changes while a regime-gated strategy's position is
open, the position MUST hold to its natural exit (stop, target, or
time-stop) per the strategy's locked management profile. Eager liquidation
on regime flip is NOT permitted under ADR-0022. Adding eager-exit behavior
is a management hypothesis that requires its own management-profile lock
and its own trial count, not an ADR-0022 amendment.

## What ADR-0022 does NOT do

- Does NOT introduce new ACTIVE_STRATEGY_IDS (Cycle2 roster expansion
  lands in QFA-7xx-S3 and conditionally QFA-7xx-S2).
- Does NOT modify ADR-0013/0014/0015 regime substrate.
- Does NOT modify ADR-0016 alpha thresholds.
- Does NOT change QFA-611 driver verdict logic.
- Does NOT pin Strategy 3's specific σ thresholds, VWAP window length, or
  fair-value reference (those are strategy parameters locked at
  QFA-7xx-S3 parameter-lock-hash time).
- Does NOT authorize raw VIX numeric thresholds as primary gates.
- Does NOT bind future non-Strategy-3-family regime-gated strategies to
  the Strategy 3 fair-value-anchor rule.

## Consequences

- QFA-7xx-S3 (Strategy 3 implementation) MUST conform to LD-022-1 through
  LD-022-9. The required 15-cell sizing-uniformity test (LD-022-6) is
  part of QFA-7xx-S3's acceptance.
- QFA-611-Cycle2's `effective_trial_count` rises from 4 to 6 (existing 4
  plus 2 directional Strategy 3 IDs) when Cycle2 dispatches. DSR penalty
  recomputes accordingly.
- Any future regime-gated strategy MUST cite ADR-0022 and either conform
  to its rules or extend it via amendment.
- A future ADR-0023 (or later) is the path for: raw-VIX-as-primary-gate
  authorization; per-strategy alternative fair-value anchors;
  eager-exit-on-regime-flip management; time-of-day as a third gate
  dimension; or any other extension of regime-conditional behavior.

## Research references

- Della Corte, P., Kosowski, R., Liu, J., and Wang, C. "Overnight-to-Intraday
  Reversal in Futures Markets."
- Jones, C., Pyun, S., and Wang, T. "High-Implied-Variance Reversal in U.S.
  Stock-Index Futures."
- Grant, J., Wolf, A., and Yu, S. "Intraday Reversal after Large Opening
  Moves in Stock-Index Futures."
- Monoyios, M., and Sarno, L. "Mean Reversion in Stock-Index Futures
  Markets: A Nonlinear Analysis."
- Akbas, F., Boehmer, E., Jiang, C., and Koch, P. "Overnight-Day Return
  Asymmetries."
- Bogousslavsky, V., and Collin-Dufresne, P. "Liquidity, Volume, and
  Order-Imbalance Volatility" (NY Fed working paper on e-mini overnight
  drift).
- Cont, R., Kukanov, A., and Stoikov, S. "The Price Impact of Order Book
  Events."
- Bailey, D., and Lopez de Prado, M. "The Deflated Sharpe Ratio:
  Correcting for Selection Bias, Backtest Overfitting, and Non-Normality."
- Harvey, C., Liu, Y., and Zhu, H. "...and the Cross-Section of Expected
  Returns."
- CBOE Global Markets. "VIX Index Methodology" (15-second dissemination
  cadence during RTH and GTH; overnight dissemination).

## Voting record

All 9 locked decisions (LD-022-1 through LD-022-9) accepted on coordinator
review following the literature audit summarized in the Context section.
Three amendments applied during the audit:

1. LD-022-7 scope narrowed to Strategy 3 family only (anchor binding does
   not pre-empt future regime-gated strategies in other families).
2. LD-022-5 rationale rewritten to drop universal-negative-shock-dominance
   framing; asymmetry direction is setup-specific per literature.
3. LD-022-3 tightened to require BOTH a stricter signed_shock magnitude
   hurdle AND lower confidence in low regime (not just lower confidence
   at the same hurdle).
