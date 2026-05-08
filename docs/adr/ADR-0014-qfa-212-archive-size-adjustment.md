# ADR-0014: QFA-212 archive-size adjustment for MNQ-RV secondary diagnostic

## Status

Accepted

## Context

ADR-0013 locked the QFA-212 regime substrate methodology with:

- LD-212-1 secondary diagnostic: MNQ RTH realized volatility, 5-min bars,
  10-session trailing smoother
- LD-212-2 cut-point methodology: rolling 60-session percentile rank
  (specified for primary substrate; implicitly extended to secondary
  via the disagreement_score field semantics)
- LD-212-8 archive-native validation: reproduce VIX vs MNQ-native RV
  contingency on Tier A archive

QFA-212 implementation Step 0 surfaced an archive-size constraint:

```text
Tier A archive:                 41 sessions (2026-02-02 -> 2026-03-31)
RV10 smoother first available:  session 10 (32 sessions of smoothed RV)
60-session rolling percentile:  0 sessions available
                                (requires 70-session prior history)
```

VIX primary substrate is unaffected. The QFA-212 pinned snapshot
(`config/research/vix-vxn-daily-2025-09-to-2026-04.json`) provides
171 VIXCLS daily closes from 2025-09-01 onwards, fully covering the
60-session warmup before Feb 2026.

The archive-native MNQ-RV percentile basis is the load-bearing
constraint. Three options were evaluated:

1. Extend Tier A archive ~70 sessions backwards
2. Refine ADR-0013 LD-212-1/2/8 to acknowledge the archive-size
   constraint and adapt the secondary-percentile basis
3. Defer the secondary diagnostic entirely

Option 2 is preferred. Archive extension is operationally expensive
(estimated $300-400 Databento spend, plus storage, manifest hash
cascade, and cascading test fixture refresh) and is not justified by
independent evidence that 60-session rolling is essential to the
within-archive analysis QFA-420 will perform. Within-window percentile
rank arguably better matches QFA-420's stratification target than
60-rolling, since the archive itself defines the regime under study.

## Decision

LD-212-1 (preserved unchanged).

Secondary diagnostic computation remains MNQ RTH RV at 5-minute bars
with 10-session trailing smoother.

LD-212-2 (refined).

Primary substrate (VIX) percentile basis remains rolling 60-session as
locked in ADR-0013.

Secondary substrate (MNQ-RV) percentile basis adapts to archive size:

- Use rolling 60-session percentile when at least 70 sessions of prior
  RV-smoothed history are available.
- Otherwise, use within-window percentile rank with explicit annotation
  of basis and session count.

Add new fields to per-session record:

```text
secondary_percentile_basis:           "rolling_60_sessions" | "within_window" | null
secondary_percentile_window_sessions: integer | null
secondary_status:                     "available" | "insufficient_coverage" | "warmup_unavailable"
```

When `secondary_status` is `insufficient_coverage`, emit
`secondary_value` (raw smoothed RV) but mark `secondary_percentile`
and `disagreement_score` with this status.

LD-212-8 (refined).

Archive-native validation reports VIX vs MNQ-RV contingency using the
within-window basis when `secondary_percentile_basis ==
"within_window"`. The 20-percentage-point divergence threshold is
preserved but evaluated against the within-window contingency matrix.

The validation artifact must explicitly document:

- `secondary_percentile_basis` used
- session count for the within-window basis
- reduced statistical power: cluster-bootstrap CIs are wider with a
  41-session within-window basis than with a 60-rolling basis populated
  from a deeper history
- explicit caveat that `disagreement_score` interpretation differs
  between the two bases (rolling-60 captures regime drift; within-window
  captures within-archive stratification)

LD-212-9 (new). Future archive extension trigger.

If QFA-420 cross-regime stratification produces empirical evidence
that within-window MNQ-RV percentile basis is insufficient for its
needs (for example, regime claims that depend on cross-archive
normalization), trigger archive extension as a separate ticket
(provisional name: `QFA-119d-mnq-rv-warmup-extension`), not an in-flight
amendment to this ADR. The fetch would target approximately 70 sessions
of MBO + MBP-1 + trades prior to 2026-02-02.

This trigger is conditional, not committed. Default expectation:
within-window basis is sufficient for QFA-420.

## Consequences

QFA-212 implementation can proceed with the pinned VIX/VXN snapshot
and the existing 41-session Tier A archive. The artifact schema gains
three fields (`secondary_percentile_basis`,
`secondary_percentile_window_sessions`, `secondary_status`) that
QFA-420 must respect when consuming labels.

QFA-420 cross-regime stratification consumes `regime-labels.json` with
within-window secondary basis. If QFA-420's analysis surfaces
insufficiency, LD-212-9 trigger activates the archive-extension ticket.

ADR-0010, ADR-0011, ADR-0012, and ADR-0013 are preserved unchanged.
ADR-0014 refines ADR-0013 LD-212-1/2/8 with explicit version-trail
preservation. The QFA-105 model is unchanged. The QFA-402 formula is
unchanged. Validation policy, RunSpec, journal events, and CI behavior
are unchanged.

## References

- ADR-0013 - Regime substrate methodology
- `docs/research/qfa-212-regime-substrate-research.md`
- QFA-212 Step 0 checkpoint: archive-size feasibility analysis
  (41 sessions, 0 rolling-60 secondary percentile observations)
- `config/research/vix-vxn-daily-2025-09-to-2026-04.json` (VIX/VXN
  pinned snapshot, vintage 2026-05-08T18:13:11Z)
