# ADR-0011: QFA-402 queue-fidelity threshold posture

## Status

Accepted

## Context

QFA-402 defines the Phase 3 queue-fidelity comparison between MBO-derived passive-fill
realizations and synthesized queue-fill estimates. The locked acceptance language is:

```text
abs(synthesized_fill_probability_ppm - reference_fill_probability_ppm) <= 100_000
within_tolerance_share_ppm >= 800_000
```

This means at least 80% of deterministic passive probes must land within +/-0.1 of the
MBO reference fill fraction.

The original `800_000` ppm share and `100_000` ppm tolerance were directional Phase 3
clean-number targets. They were not derived from an empirical MBO dispersion study, a
probe-level calibration set, or a pre-existing reliability curve. The original dispatch
also assumed a richer Tier B-style proxy path than QFA-402 v1 could use at the time.
QFA-402 v1 used QFA-105 `mbp_proxy` because TBBO was absent from the locked corpus and
QFA-105 did not yet expose an MBP-1 plus trades proxy mode.

QFA-402-housekeeping-1 later showed that `mbp_proxy` missed the threshold badly on real
archive data:

```text
Feb 2026-02-25-rth full RTH: 123,760 ppm
Mar 2026-03-17-rth full RTH: 477,071 ppm
threshold:                     800,000 ppm
```

QFA-105-housekeeping-2 then added `mbp_trades_proxy`, and QFA-402b reran the smoke:

```text
Feb 2026-02-25-rth full RTH: 745,341 ppm
Mar 2026-03-02-rth 360s prefix: 880,555 ppm
threshold:                       800,000 ppm
```

The Feb result closed 91.9% of the original clean-baseline gap, but it still failed the
locked threshold by 54,659 ppm. This raised a policy question: should the project lower
the threshold to fit the observed `745,341` ppm clean-Feb floor, widen the tolerance,
keep the threshold and improve the model, or segment the threshold by probe/regime class?

## Decision

Keep the QFA-402 queue-fidelity threshold posture unchanged for now:

```text
tolerance_ppm = 100_000
min_within_tolerance_share_ppm = 800_000
```

Do not relax the threshold to `720_000` ppm or any other value as an immediate response
to QFA-402b. A `720_000` ppm floor would be post-hoc fitting to the first clean-Feb
`mbp_trades_proxy` result rather than a calibrated policy. It is therefore rescinded as
an acceptable immediate Phase 3 exit-gate change.

Treat `800_000` ppm as a directional hard gate pending QFA-402c residual analysis. The
next evidence ticket must explain the residual gap before any threshold change is
accepted.

QFA-402c must include at least:

```text
Feb baseline 1: 2026-02-25-rth full RTH
Feb baseline 2: another clean Feb full-RTH session, preferred 2026-02-24-rth or 2026-02-26-rth
Mar clean sample: 2026-03-02-rth or another clean early-March session, 1800s prefix first
```

QFA-402c must not retry full-RTH Mar at a 16 GB heap cap. If the 1800-second Mar prefix
is successful but full RTH is unsafe, record bounded Mar evidence and route full-session
scaling to a streaming-throughput ticket instead of fighting memory inside the residual
analysis ticket.

QFA-402c must produce probe-level residual evidence before any policy revision:

```text
error distribution
stratified within-tolerance share
side split
spread split
queue-ahead split
time-of-day split
predicted-probability bins
reference-probability bins
reliability / calibration table
Brier or squared-error diagnostic with target-representation note
comparison to QFA-402b
```

Only after that evidence exists should the coordinator decide among:

```text
model improvement
threshold re-derivation
probe-policy adjustment
runtime/streaming work
```

## Consequences

QFA-402b remains an evidence PR, not a policy change. Its Feb full-RTH result is highly
informative because trades closed most of the original gap, but it does not by itself
justify lowering the threshold.

Phase 3 exit remains blocked until QFA-402c explains whether the remaining miss is
systematic model error, probe-policy mismatch, irreducible MBO/proxy noise, threshold
miscalibration, or a mixture of these.

Keeping the threshold unchanged avoids post-hoc acceptance while preserving the ability
to revise the policy later with a documented empirical basis. If QFA-402c shows the
residual miss is stable and acceptable across clean sessions, a later ADR or policy PR
can re-derive the threshold. If QFA-402c shows systematic misses, the next step should be
model or probe-policy work rather than threshold relaxation.

No source code, QFA-402 formulas, QFA-105 model behavior, validation policy, RunSpec
contract, journal event type, manifest, or CI gate changes are implied by this ADR.
