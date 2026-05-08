# ADR-0012: Lock QFA-402 probe policy at 15s fill horizon and 60s depletion lookback

## Status

Accepted

## Context

ADR-0011 preserved the QFA-402 queue-fidelity threshold at
`within_tolerance_share_ppm >= 800_000` with `+/-100_000 ppm` tolerance,
and required residual / calibration evidence before any policy change.

QFA-402c (PR #150) showed the QFA-402b miss was concentrated in specific
strata (2-tick spread, 6-20 visible queue-ahead, mid-session), not
uniformly distributed. The reference target at the 5s fill horizon is
near-bimodal while the synthesizer emits graded continuous probabilities,
indicating a probe-policy mismatch rather than a model failure. Verdict:
`probe_policy_adjustment_candidate`.

QFA-402d (PR #151) executed a 12-cell probe-policy sweep over
`fill_horizon_ns` and `depletion_lookback_ns` on two clean Feb full-RTH
sessions (`2026-02-24-rth`, `2026-02-25-rth`):

```text
Best cell:        fill_horizon_ns = 15_000_000_000  (15s)
                  depletion_lookback_ns = 60_000_000_000  (60s)

Feb 2026-02-25:   889,636 ppm   PASS  (current default 5s/30s: 745,341 FAIL)
Feb 2026-02-24:   902,218 ppm   PASS  (current default 5s/30s: 790,738 FAIL)

Min margin above threshold: +89,636 ppm
MAE drop:                   ~50% in both sessions
Stratified failures (QFA-402c): all close at the new policy
Dominant axis:              fill_horizon_ns (5s -> 10s flips fail-both
                            to pass-both regardless of lookback)
```

## Decision

Lock the QFA-402 probe policy at:

```text
fill_horizon_ns       = 15_000_000_000  (15s)
depletion_lookback_ns = 60_000_000_000  (60s)
```

Replace `DEFAULT_QUEUE_FIDELITY_POLICY_V1` defaults globally rather than
exposing a Phase 3-only override. Two-policy maintenance has no
empirical upside given that the new policy dominates the old across all
measured strata.

ADR-0011 threshold and tolerance posture is preserved unchanged:

```text
tolerance_ppm                  = 100_000   (unchanged)
min_within_tolerance_share_ppm = 800_000   (unchanged)
```

The QFA-402 hardcoded path also moves from `mbp_proxy` to
`mbp_trades_proxy` per QFA-105-housekeeping-2 evidence.

Pre-lock validation: QFA-402-housekeeping-3 must run a bounded Mar
2026-03-02 1800s prefix smoke at the new policy and confirm the
within-tolerance share remains >= 800,000 ppm before declaring Phase 3
queue fidelity unblocked. The Mar confirmation is required because the
QFA-402d sweep was Feb-only.

QFA-402-housekeeping-3 must run final smoke on all three validation
windows:

```text
- Feb 2026-02-24-rth full RTH
- Feb 2026-02-25-rth full RTH
- Mar 2026-03-02-rth 1800s prefix
```

All three must reach >= 800,000 ppm for Phase 3 queue fidelity to
unblock.

## Consequences

QFA-402 default queue-fidelity policy values change in
`DEFAULT_QUEUE_FIDELITY_POLICY_V1`. Test fixtures pinning the old 5s/30s
values must be updated as part of QFA-402-housekeeping-3.

Phase 3 queue-fidelity exit-gate unblocks on QFA-402-housekeeping-3
merge contingent on the three-window smoke passing.

The 21+ visible-queue-ahead bucket remains poor (471,910 ppm Feb25 /
505,263 ppm Feb24 at the new policy) but is sparse (267/95 probes per
session) and does not drive the session-level metric. This residual is
documented as a known diagnostic, not a blocker. If a future regime
makes the 21+ bucket load-bearing, a separate residual analysis ticket
(QFA-402-h3-followup) can revisit it.

The QFA-105 model is unchanged. The QFA-402 formula is unchanged. The
ADR-0011 threshold is unchanged. Validation policy, RunSpec contracts,
journal events, and CI behavior are unchanged.

## References

- ADR-0011 - QFA-402 queue-fidelity threshold posture
- QFA-402-h1 PR #145, evidence
- QFA-402b PR #147 (merge 5e200091), mbp_trades_proxy + 5s/30s
- QFA-402c PR #150 (merge c0d709ad), residual analysis
- QFA-402d PR #151 (merge d77952d6), probe-policy sweep
