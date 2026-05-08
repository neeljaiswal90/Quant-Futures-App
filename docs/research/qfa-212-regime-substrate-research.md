# QFA-212 regime substrate research

## Status

Research note for ADR-0013 and QFA-212 dispatch.

This artifact records the methodology selection for the Phase 4 regime
substrate. It is not an implementation artifact and does not emit regime labels.
The load-bearing implementation and archive-native validation are assigned to
QFA-212.

## Purpose

QFA-420 cross-regime stratification needs a deterministic, auditable per-session
regime substrate before it can produce regime-conditioned fidelity claims.
QFA-510 HMM/regime integration is held until that substrate is validated.

The substrate must satisfy four constraints:

```text
1. Available before the MNQ RTH session being labeled.
2. Deterministic and reproducible from pinned source data.
3. Coarse enough for the Feb-Mar 2026 calibration battery.
4. Separated from corpus manifests to preserve corpus-integrity audit scope.
```

## Candidate substrates considered

### VIX prior close

VIX prior close is the selected primary substrate.

Reasons:

```text
- Forward-looking volatility measure available before the target MNQ RTH session.
- Does not depend on MNQ intraday warmup or archive-native computation.
- Operationally simple to pin and regenerate.
- Public-proxy checks suggest prior-close VIX and same-day-close VIX agree at
  coarse regime granularity for 95.1% of sessions.
```

Caveat: VIX is an S&P 500 volatility index, not a Nasdaq-100-specific measure.
The methodology therefore stores MNQ-native realized volatility diagnostics and
a VIX/RV disagreement score.

### MNQ RTH realized volatility

MNQ RTH realized volatility is selected as a secondary diagnostic, not the
authoritative label.

Specification selected for QFA-212:

```text
- 5-minute RTH bars
- 10-session trailing smoother
- rolling 60-session percentile rank
```

Reasons it is diagnostic rather than primary:

```text
- It depends on archive-native data availability and bar construction choices.
- It has warmup dependency and can be unavailable or unstable around partial or
  quality-excluded sessions.
- It is useful for detecting substrate disagreement, but less clean as the
  operational label authority.
```

### Hybrid VIX/RV score

A hybrid score was considered:

```text
h_t = 0.5 * (p_VIX + p_RV)
```

The hybrid is not selected as an authoritative label because it would blur the
clean operational semantics of a prior-close primary label. QFA-212 may compute
it for diagnostics, but the stored disagreement score is:

```text
disagreement_score = abs(p_VIX - p_RV)
```

### VXN

VXN is deferred. Public-proxy evidence suggests VIX and VXN are near-equivalent
at coarse regime granularity, with approximately 97.6% agreement in the proxy
analysis. That supports using VIX as a practical primary substrate, but VXN is
not made authoritative in ADR-0013.

## Public-proxy evidence summary

The research environment used public daily proxies because Tier A archive
intraday data was not directly queryable during methodology selection. These
proxy results are methodology-selection evidence, not final operational numbers.

Observed proxy facts carried into ADR-0013:

```text
VIX prior close vs VIX same-day close:
  95.1% agreement at coarse regime granularity.

VIX vs public-proxy RV20:
  50% agreement.

VIX vs VXN:
  approximately 97.6% agreement at coarse regime granularity.
```

Interpretation:

```text
- Prior-close VIX is stable enough relative to same-day-close VIX for
  pre-session labeling.
- VIX and realized-volatility-style diagnostics are related but not redundant.
- VXN does not currently justify extra operational complexity for the primary
  label, though it remains a plausible future refinement.
```

Critical caveat:

```text
The VIX vs MNQ-RV agreement is predicted from public proxies, not observed on
archive-native MNQ RTH data. QFA-212 must reproduce the VIX vs MNQ-native RV
contingency matrix on the actual Tier A archive before QFA-420 consumes labels.
```

## Labeling algorithm specification

For each target session `t`, use the previous trading day's VIX close:

```text
primary_value_t = VIX_close_{t-1}
```

Compute the rolling 60-session percentile rank over the available prior values:

```text
primary_percentile_t = rank(primary_value_t within trailing_60_values) / count
```

If fewer than 60 prior eligible observations are available, emit:

```json
{
  "label_status": "warmup_unavailable"
}
```

Raw regime cuts:

```text
p_t < 0.33          -> low
0.33 <= p_t < 0.67 -> mid
p_t >= 0.67        -> high
```

Confirmed labels apply two-session hysteresis:

```text
low -> mid:   p_t >= 0.40 for 2 consecutive eligible sessions
mid -> high:  p_t >= 0.70 for 2 consecutive eligible sessions
high -> mid:  p_t <= 0.60 for 2 consecutive eligible sessions
mid -> low:   p_t <= 0.30 for 2 consecutive eligible sessions
```

If the raw label differs from the confirmed label but the hysteresis condition
has not been met, retain the prior confirmed label and emit:

```json
{
  "transition_pending": true
}
```

Labels are per-session. There is no intraday relabeling.

## Artifact shape recommendation

QFA-212 should emit a separate artifact:

```text
artifacts/regime/regime-labels.json
```

Minimum top-level fields:

```json
{
  "schema_version": 1,
  "methodology": "ADR-0013",
  "source_manifests": {
    "2026-02": "05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c",
    "2026-03": "cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f"
  },
  "labels": []
}
```

Per-session label fields should include:

```text
session_id
label_status
confirmed_label
raw_label
primary_value
primary_percentile
secondary_value
secondary_percentile
disagreement_score
transition_pending
partial_session
quality_excluded
quality_exclusion_reason
use_for_calibration
```

Numeric precision should be fixed by QFA-212 and preserved in any future
determinism-gate promotion.

## Archive-native validation requirement

QFA-212 must validate the proxy-derived methodology on Tier A archive data.

Required archive-native diagnostics:

```text
1. VIX vs MNQ-native RV contingency matrix.
2. VIX vs VXN contingency matrix, diagnostic only.
3. Agreement rates with 5-session moving-block bootstrap 95% CIs.
4. Mean and distribution of p_VIX - p_RV.
5. Bootstrap CIs for 33rd and 67th percentile cut values.
6. Counts by regime, transition_pending, quality_excluded, and
   use_for_calibration.
```

Material-divergence rule from ADR-0013:

```text
If archive-native VIX vs MNQ-RV agreement diverges from the public-proxy
50% RV20 agreement by more than 20 percentage points in either direction,
QFA-212 must stop and surface a research finding requiring ADR-0013 amendment
review before QFA-420 dispatches.
```

## Calibration battery and confidence intervals

Session-level clustering matters because probes within a session are not
independent. Regime-difference claims therefore require cluster-aware intervals.

ADR-0013 locks this battery:

```text
Minimum:   >= 2 clean sessions per labeled regime
           Screening floor only.

Practical: 4-6 sessions per regime
           Roughly suitable for 50k ppm effects.

Fine:      7-14 sessions per regime
           Roughly suitable for 25k ppm effects.
```

Confidence intervals must use a 5-session moving-block bootstrap for
regime-difference claims.

## Anomaly handling

Anomaly sessions are labeled informatively but excluded from calibration. This
keeps the label artifact complete while avoiding contamination of calibration
claims.

The H-cycle expiry-thinning sessions are excluded by default:

```text
2026-03-17-rth
2026-03-18-rth
2026-03-19-rth
2026-03-20-rth
```

Required per-session flags:

```json
{
  "quality_excluded": true,
  "quality_exclusion_reason": "h_cycle_expiry_thinning",
  "use_for_calibration": false
}
```

This is intentionally compatible with the QFA-119c `quality_exclusions`
whitelist and the `verify-corpus` `quality_excluded` status semantics.

## Recommendation

Proceed with ADR-0013 and QFA-212 using VIX prior close as the authoritative
primary substrate and MNQ-native RV as a secondary diagnostic.

Do not dispatch QFA-420 until QFA-212 has produced archive-native validation.
If the archive-native agreement reproduces the public-proxy pattern within the
ADR-0013 20 percentage-point tolerance, QFA-420 is unblocked. If it diverges
materially, QFA-420 remains blocked pending ADR-0013 amendment review.

## Non-goals

```text
- No QFA-420 stratification implementation.
- No QFA-510 HMM/regime modeling.
- No determinism-gate promotion yet.
- No VXN authoritative label.
- No intraday relabeling.
- No corpus manifest modification.
- No QFA-105 or QFA-402 changes.
```
