# ADR-0013: Regime substrate methodology for QFA-212 / QFA-420

## Status

Accepted

## Context

Phase 3 exit (PR #153) closed Phase 3 queue fidelity at locked
`mbp_trades_proxy` plus the 15s / 60s probe policy, with substantive
evidence that fidelity behavior varies by market microstructure regime
(spread, queue-ahead, time-of-day). Phase 4's QFA-420 cross-regime
stratification will consume regime labels to produce stratified fidelity
claims; QFA-510 HMM/regime integration is held until the regime substrate
is empirically validated.

QFA-212 produces the regime substrate. ADR-0013 locks the methodology before
implementation per the Phase 3 ADR-before-housekeeping pattern (precedent:
ADR-0011 locked QFA-402 threshold posture before QFA-402-housekeeping-3
source changes).

Source research: `docs/research/qfa-212-regime-substrate-research.md`
(VIX vs MNQ-RV vs hybrid comparison; cut-point methodology analysis;
public-proxy contingency matrices on Feb-Mar 2026 Nasdaq-100 daily close plus
VIX/VXN daily close series; calibration-battery power analysis with
cluster-adjustment; mathematical specification of the labeling algorithm).

Critical caveat from the research: the contingency analysis used public daily
proxies because the Tier A archive intraday data was not directly queryable in
the research environment. The methodology selection is well-grounded, but
archive-native validation is required during QFA-212 implementation before
QFA-420 consumes the labels.

## Decision

LD-212-1: Substrate composition.

Primary: VIX close on previous trading day.

Secondary diagnostic: MNQ RTH realized volatility, 5-minute bars, 10-session
trailing smoother.

Hybrid diagnostic: `h_t = 0.5 * (p_VIX + p_RV)` may be computed for
diagnostics, but `abs(p_VIX - p_RV)` is the stored disagreement score and is
never used as the authoritative label.

VXN is deferred as a future refinement. Public-proxy evidence suggests
near-equivalence to VIX at coarse regime granularity, but VXN is out of scope
for ADR-0013 as an authoritative substrate.

LD-212-2: Cut-point methodology.

Use a rolling 60-session percentile rank of the primary substrate value.

Raw cuts:

```text
p_t < 0.33        -> low
0.33 <= p_t < 0.67 -> mid
p_t >= 0.67       -> high
```

Hysteresis requires two-session confirmation with asymmetric deadbands:

```text
low -> mid:   p_t >= 0.40 for 2 consecutive eligible sessions
mid -> high:  p_t >= 0.70 for 2 consecutive eligible sessions
high -> mid:  p_t <= 0.60 for 2 consecutive eligible sessions
mid -> low:   p_t <= 0.30 for 2 consecutive eligible sessions
```

When hysteresis suppresses a transition, set `transition_pending=true` and
retain the previous confirmed state.

LD-212-3: Time-window resolution.

Labels are per-session. There is no intraday relabeling.

Partial or early-close sessions are labeled if previous-close VIX is available,
with `partial_session=true`, and are excluded from calibration by default.

Warmup-insufficient sessions use `label_status="warmup_unavailable"`.

LD-212-4: Artifact shape.

Emit a separate `regime-labels.json` artifact; do not embed labels in corpus
manifests. Cross-reference source manifest hashes via a `source_manifests`
field. This preserves the corpus-integrity audit boundary established in
ADR-0010, ADR-0011, and ADR-0012.

LD-212-5: Determinism gate inclusion.

Determinism inclusion is conditional. Until QFA-420, or another validated
artifact path, consumes `regime-labels.json` in a pass/fail or published-metric
context, the artifact remains research-tier and outside the determinism chain
hash.

On promotion, the methodology, source series, vintage pinning, JSON ordering,
and numeric rounding must be locked into the determinism fixture in a separate
ADR amendment or successor ADR.

LD-212-6: Calibration battery requirements.

```text
Minimum:    >= 2 clean sessions per labeled regime
            Screening floor only; non-load-bearing for fine claims.

Practical:  4-6 sessions per regime
            Intended for roughly 50k ppm difference detection.

Fine:       7-14 sessions per regime
            Intended for roughly 25k ppm difference detection.
```

Anomaly sessions are excluded from calibration even if labeled.

Cluster-bootstrap confidence intervals are required for regime-difference
claims, using a 5-session moving block.

LD-212-7: Anomaly session handling.

Anomaly sessions are labeled informatively but excluded from calibration:

```json
{
  "quality_excluded": true,
  "quality_exclusion_reason": "<documented_reason>",
  "use_for_calibration": false
}
```

This is compatible with the QFA-119c `quality_exclusions` whitelist and the
`verify-corpus` `quality_excluded` semantics. The H-cycle expiry-thinning
sessions (`2026-03-17-rth`, `2026-03-18-rth`, `2026-03-19-rth`,
`2026-03-20-rth`) are excluded by this rule.

LD-212-8: Archive-native validation requirement.

QFA-212 must reproduce the public-proxy contingency matrices for VIX vs
MNQ-native RV on actual Tier A archive data and report agreement rates with
bootstrap confidence intervals.

If archive-native agreement diverges materially from the public-proxy 50% RV20
agreement by more than 20 percentage points in either direction, surface this as
a research finding requiring ADR-0013 amendment review before QFA-420 dispatches.

QFA-212 should also reproduce the VIX vs VXN diagnostic agreement matrix, but
VXN remains diagnostic only.

## Consequences

QFA-212 implementation scope includes both label generation and archive-native
diagnostic reproduction. QFA-212 emits `regime-labels.json` plus a research
artifact documenting archive-native contingency matrices.

QFA-420 cross-regime stratification consumes `regime-labels.json`. Promotion of
`regime-labels.json` into the determinism gate happens on QFA-420's first
validated-artifact-path consumption per LD-212-5.

QFA-510 HMM/regime integration remains held until QFA-420 produces empirically
validated regime-stratified fidelity evidence.

ADR-0011 threshold posture (`800_000` ppm / `+/-100_000` ppm for QFA-402 queue
fidelity) is preserved unchanged. ADR-0012 probe policy lock (15s / 60s,
`mbp_trades_proxy`) is preserved unchanged. This ADR adds the regime substrate
methodology without amending predecessor locks.

The QFA-105 model is unchanged. The QFA-402 formula is unchanged. RunSpec,
journal events, and CI behavior are unchanged.

## References

- ADR-0010 - Validation gate (QFA-310)
- ADR-0011 - QFA-402 queue-fidelity threshold posture
- ADR-0012 - QFA-402 probe policy lock at 15s/60s
- `docs/research/qfa-212-regime-substrate-research.md`
- Phase 3 critical-path PRs #139-#155
- Cboe VIX methodology (SPX/SPXW options plus Treasury yield curve)
- CME MNQ specifications ($2 x Nasdaq-100, near-24-hour Globex)
