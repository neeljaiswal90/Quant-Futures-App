# ADR-0015: QFA-420 cross-regime queue-fidelity stratification methodology

## Status

Accepted

## Context

Phase 4 substrate established (PRs #156-#159):

- ADR-0013 / 0014: regime substrate methodology (VIX primary,
  rolling-60 percentiles, hysteresis, within-window MNQ-RV secondary)
- QFA-119d: Tier A archive extended to include April 2026 sessions
- QFA-212 v2: 43 high / 3 mid / 11 low calibration-eligible sessions
  with 56.25% archive-native VIX-vs-MNQ-RV agreement

QFA-420 cross-regime queue-fidelity stratification consumes the
QFA-212 v2 substrate to test whether queue-fidelity behavior (per
ADR-0011 / 0012 locked policy) is regime-uniform or regime-conditioned.
Outcome controls QFA-510 dispatch and any future QFA-402-h3-followup
reactivation.

The walkthrough that produced this ADR rejected three earlier draft
decisions on statistical grounds:

- A 25,000 ppm load-bearing threshold for the high-vs-low contrast
  was rejected as too aggressive given the cross-session standard
  deviation implied by observed passing-window dispersion (~56k ppm
  across the three locked QFA-402-housekeeping-3 smoke windows).
  50,000 ppm is the operationally calibrated raw margin (half of
  ADR-0011's +/-100,000 ppm tolerance and below the weakest
  post-ADR-0012 pass margin of ~89.6k ppm).
- A confidence-interval-contains-zero rule was rejected as a test of
  practical equivalence; that is non-rejection of zero, not evidence
  of equivalence. The two one-sided tests (TOST) interval-hypothesis
  framework is correct for the equivalence claim and is adopted in
  LD-420-6.
- A 5-session moving-block bootstrap on the mid regime was rejected
  as mathematically degenerate. With n_mid = 3, the number of
  overlapping base blocks is 3 - 5 + 1 = -1; even at block length 3,
  only one base block exists. Mid regime is therefore descriptive-
  only in v1.

## Decision

LD-420-1: Stratification grain.

Primary validated claim is high-vs-low queue-fidelity contrast only
(n=43 vs n=11; both above ADR-0013 LD-212-6 practical 4-6 target).

Three-way stratification (high / mid / low) is emitted in artifacts,
but mid-regime claims are descriptive-only, not validated.

All claims are framed as conditional-on-regime associations, not as
causal statements about regime "causing" fidelity differences.

LD-420-2: Effect-size threshold (SESOI).

Smallest effect size of interest, raw scale:

```text
high-vs-low primary axis:        +/- 50,000 ppm
mid-involving contrasts:         100,000 ppm screening only
                                 (not load-bearing)
```

50,000 ppm is half of ADR-0011 tolerance (+/-100,000 ppm) and below
the weakest post-ADR-0012 pass margin. 25,000 ppm rejected as too
aggressive given sigma implied by observed passing-window dispersion.

LD-420-3: Probe policy reuse.

ADR-0012 locked values preserved unchanged:

```text
fill_horizon_ns:        15_000_000_000   (15s)
depletion_lookback_ns:  60_000_000_000   (60s)
mode:                   mbp_trades_proxy
threshold:              800_000 ppm
tolerance:              +/-100_000 ppm
```

QFA-420 does NOT re-sweep probe policy.

LD-420-4: 21+ visible-queue-ahead bucket handling.

Diagnostic-only in v1. No cross-stratification of 21+ x regime in
formal inference.

Per regime, report:

- pooled probe-weighted within-tolerance share for 21+ probes
- total comparable 21+ probe count for the regime

Diagnostic warning trigger: a regime's pooled 21+ share is at least
500,000 ppm below the regime's pooled overall share AND the regime
has at least 100 comparable 21+ probes. Warning only; not an
inferential claim.

No 21+ x regime conclusions drawn from v1 evidence. ADR-0012
QFA-402-h3-followup conditional remains as written.

LD-420-5: Methodology specification.

Primary estimand:
Equal-weight mean of per-session within_tolerance_share_ppm within
each regime. The claim is about typical session behavior conditional
on regime, not aggregate probe behavior.

Secondary sensitivity estimand:
Comparable-probe-weighted pooled regime share. If equal-weight and
probe-weighted summaries move in opposite directions, treat as
weighting fragility and keep downstream claims conservative.

Formal inference (high-vs-low only):

- moving-block bootstrap on regime-specific time-ordered session
  series
- block lengths: 5 primary; 3 and 7 sensitivity panel
- 10,000 bootstrap replications per block length
- fixed RNG seed (deterministic across runs)
- 90% CI for primary decision (TOST framework, see LD-420-6)
- 95% CI reported alongside as descriptive
- block-length stability flag: if A/B/D verdict differs across
  l in {3, 5, 7}, default verdict to D (inconclusive)

Mid regime (no bootstrap CI):

- report raw session-level shares for the 3 mid sessions
- report simple mean, median, min, max
- report leave-one-out pair means (3 LOO pairs)
- explicitly NOT subjected to bootstrap inference
- mid_regime_inference: "descriptive_only"

21+ queue-ahead diagnostic:

- pooled probe-weighted share per regime
- total comparable probe count per regime
- LD-420-4 trigger evaluation

LD-420-6: Verdict semantics — TOST / interval-hypothesis framework.

Primary axis (high-vs-low only):

```text
Outcome A — Practical equivalence
  Definition: 90% CI for delta(high - low) lies entirely within
              [-50_000, +50_000] ppm, AND verdict stable across
              block lengths l in {3, 5, 7}.
  Implication: queue fidelity is regime-equivalent at the +/-50k
               ppm SESOI granularity.
  Next: QFA-510 HMM/regime integration UNBLOCKED.

Outcome B — Material difference
  Definition: 90% CI for delta(high - low) lies entirely above
              +50_000 ppm OR entirely below -50_000 ppm, AND
              verdict stable across block lengths l in {3, 5, 7}.
  Implication: queue fidelity is regime-conditioned at the SESOI
               scale.
  Next: QFA-510 NOT directly unblocked. Coordinator walkthrough
        required to decide among:
          (a) regime-conditioned threshold (would require new ADR)
          (b) QFA-105 model regime-aware refinement
          (c) Phase 5 regime-stratified-claim posture
          (d) deeper investigation before QFA-510 dispatch

Outcome D — Inconclusive
  Definition: 90% CI for delta(high - low) overlaps both equivalence
              bounds (i.e., neither entirely inside nor entirely
              outside [-50_000, +50_000]), OR block-length verdict
              instability (A/B differ across l in {3, 5, 7}), OR
              comparable-probe count below ADR-0013 LD-212-6 floors
              in either regime.
  Implication: substrate cannot resolve the primary contrast at
               SESOI granularity.
  Next: Coordinator decision among:
          - accept current substrate as too small for any v1 claim
          - reactivate ADR-0014 LD-212-9 archive extension
          - widen SESOI to a higher granularity (would require
            new ADR; not a v1 option)
```

Mid-regime overlay (NOT a primary outcome; flag attached to A or D):

```text
mid_anomaly_flag = true when descriptive mid statistics show
                   extreme deviation from neighbors:
                     |mid_mean - high_mean| > 200_000 ppm OR
                     |mid_mean - low_mean| > 200_000 ppm
Action: documented as caveat in artifact; does not invalidate the
        primary verdict; suggests future archive extension for
        mid-regime claims.
```

Pre-declared verdict structure prevents post-hoc conclusion fitting
by design.

LD-420-7: Determinism gate promotion (conditional).

QFA-420 v1 itself: research-tier. Emits regime-stratified-fidelity
artifact without determinism inclusion.

regime-labels.json promotion path:

```text
Outcome A (validated equivalence): promote, with full pinning
Outcome B (validated difference):  promote, with full pinning
Outcome A + mid_anomaly_flag:      promote with caveat field
Outcome D:                         do NOT promote
```

When promoted, the determinism fixture pins:

- regime-labels.json content hash (SHA-256)
- VIX/VXN pinned snapshot hash
- Feb/Mar/Apr manifest hash set (all three)
- quality_exclusions list
- secondary_percentile_basis: "within_window" as a contract field

Pinning all five together prevents silent drift: changes to manifest
set, quality exclusions, or substrate vintage all break the
determinism hash and force a refresh ADR.

LD-420-8: Output artifact shape.

`artifacts/regime-fidelity/regime-stratified-fidelity-v1.json`

Required fields:

- methodology_id: "adr-0015-v1"
- input_substrate_hash (regime-labels.json SHA-256)
- input_manifest_hashes (Feb / Mar / Apr)
- probe_policy: ADR-0012 values restated
- sesoi_ppm: 50_000
- per_session: list of { regime, session_id, share_ppm,
  comparable_probes }
- per_regime_equal_weight: per regime { mean, n, ... }
- per_regime_probe_weighted: per regime { pooled_share,
  comparable_probes, ... }
- high_low_delta:
  - equal_weight_delta_ppm
  - ci_90_lower, ci_90_upper, ci_95_lower, ci_95_upper
  - block_length_5_verdict, block_length_3_verdict,
    block_length_7_verdict
  - block_length_stability_flag
- mid_descriptive: { sessions, mean, median, min, max,
  loo_pair_means }
- twenty_one_plus_diagnostic: per regime { pooled_share,
  comparable_probes }
- twenty_one_plus_warning_flag (boolean)
- mid_anomaly_flag (boolean)
- primary_verdict: "A" | "B" | "D"
- mid_regime_status: "screening_floor"
- mid_regime_inference: "descriptive_only"
- bootstrap_replications: 10000
- bootstrap_block_lengths_tested: [3, 5, 7]
- bootstrap_seed: <integer>

`docs/research/qfa-420-cross-regime-fidelity.md`

- methodology recap referencing ADR-0011/0012/0013/0014/0015
- all numeric tables matching the JSON
- bootstrap interpretation notes
- 21+ diagnostic interpretation
- mid-regime caveat reasoning
- verdict + downstream implication
- ADR-0015 LD numbers cited where applicable

`scripts/regime/qfa-420-cross-regime-fidelity.py`

Python helper, reusing QFA-212 helpers + cluster-bootstrap from
QFA-402c. Streaming pattern for archive reads.

LD-420-9: Out-of-scope guardrails.

ADR-0011 threshold + tolerance preserved.
ADR-0012 probe policy preserved.
ADR-0013 / 0014 substrate methodology preserved.
QFA-105 model unchanged.
QFA-402 formula unchanged.
No new session fetches, no archive extension (LD-212-9 dormant
unless Outcome D triggers reactivation).
RunSpec / journal / determinism CI unchanged until LD-420-7
promotion path activates.

LD-420-10: Mid-regime calibration use.

Mid sessions (n=3) included in v1 analysis with explicit fields:

```text
mid_regime_status:     "screening_floor"
mid_regime_inference:  "descriptive_only"
```

Mid statistics enter tables and 21+ diagnostics; mid does NOT enter
primary-axis bootstrap inference; mid does NOT determine the primary
verdict.

LD-420-11: Anomaly session exclusion.

Consume only sessions with quality_excluded == false per ADR-0013
LD-212-7 + QFA-119c whitelist semantics.

Excluded sessions:

- Mar 2026-03-17, -18, -19, -20 (H-cycle expiry-thinning)
- Any future quality_exclusions added to regime-labels.json
- Sessions with insufficient_coverage status

Excluded sessions retain informational regime labels but do not
enter calibration or inference.

## Consequences

QFA-420 v1 produces a statistically coherent answer to a single
primary question:

> Is high-vs-low queue fidelity practically equivalent within
> +/-50,000 ppm, given QFA-402's locked metric and QFA-212's regime
> substrate?

Mid regime is honestly reported as descriptive-only because n=3
cannot support 5-session moving-block bootstrap (3 - 5 + 1 = -1
base blocks; even l=3 yields one base block).

Outcome A unblocks QFA-510. Outcome B requires coordinator
walkthrough before QFA-510. Outcome D requires substrate decision
(accept-as-is vs LD-212-9 archive extension).

ADRs 0010-0014 preserved unchanged. The QFA-105 model is unchanged.
The QFA-402 formula is unchanged. Validation policy, RunSpec, journal
events, and CI behavior are unchanged until LD-420-7 promotion path
activates on a validated outcome.

## References

- ADR-0010 - Validation gate
- ADR-0011 - QFA-402 threshold posture
- ADR-0012 - QFA-402 probe policy lock at 15s/60s
- ADR-0013 - Regime substrate methodology
- ADR-0014 - QFA-212 archive-size adjustment
- QFA-119d PR #159 (merge 7bcd75b)
- QFA-212 PR #158 (merge 80232bf)
- White (2000), Reality Check for data-snooping bias
- Schuirmann (1987), TOST equivalence testing framework
- Politis-Romano-Wolf, moving-block bootstrap for time-series
- `artifacts/regime/regime-labels.json` (v2 substrate, post-#159)
- `config/research/vix-vxn-daily-2025-09-to-2026-04.json`
