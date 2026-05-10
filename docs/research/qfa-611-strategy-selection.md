# QFA-611 strategy selection v1

## Status

REJECT all current candidates because ADR-0016 LD-611-1 evidence packages are incomplete.

This is an implementation result, not a methodology amendment. ADR-0016 is applied count-agnostically to the canonical 4-strategy roster per CF-29.

## Inputs

- Methodology: `adr-0016-v1`
- Phase 2 hash: `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b`
- Phase 4 hash: `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090`
- Regime substrate hash: `f90e3e6df588a60756c675befe7fd77adf1a33ed3878fbb8900d519b79f0a41a`
- Active strategy roster: `trend_pullback_long`, `trend_pullback_short`, `breakout_retest_long`, `breakdown_retest_short`

## Regime substrate context

| Regime | Calibration-eligible sessions |
|---|---:|
| high | 43 |
| mid | 3 |
| low | 11 |

QFA-420 Outcome A remains the system-level fidelity context; no regime-conditioned sizing or threshold changes are introduced.

## Evidence-package finding

The repository currently contains strategy source/configuration plus QFA-301/302/303/410 framework code, but it does not contain validation-grade per-strategy QFA-410 held-out trade artifacts for Feb-Mar-Apr 2026. Existing replay-sanity fixtures are diagnostics and QFA-303 explicitly treats replay-sanity placeholder features as degraded replay, which cannot pass QFA-310.

Per ADR-0016 LD-611-1, QFA-611 must not fabricate held-out returns when this evidence package is missing. The Stage 1 statistical metrics are therefore not evaluable.

## Per-strategy verdicts

| Strategy | Verdict | Evidence status | Trades | Sharpe HAC | DSR | PSR zero | PSR hurdle | Max DD | PF | Reason |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| `trend_pullback_long` | REJECT | incomplete | 0 | n/a | n/a | n/a | n/a | n/a | n/a | LD-611-1 evidence package incomplete: no validation-grade QFA-410 per-trade/session held-out evidence is present for this strategy; statistical Stage 1 thresholds are therefore not evaluable. |
| `trend_pullback_short` | REJECT | incomplete | 0 | n/a | n/a | n/a | n/a | n/a | n/a | LD-611-1 evidence package incomplete: no validation-grade QFA-410 per-trade/session held-out evidence is present for this strategy; statistical Stage 1 thresholds are therefore not evaluable. |
| `breakout_retest_long` | REJECT | incomplete | 0 | n/a | n/a | n/a | n/a | n/a | n/a | LD-611-1 evidence package incomplete: no validation-grade QFA-410 per-trade/session held-out evidence is present for this strategy; statistical Stage 1 thresholds are therefore not evaluable. |
| `breakdown_retest_short` | REJECT | incomplete | 0 | n/a | n/a | n/a | n/a | n/a | n/a | LD-611-1 evidence package incomplete: no validation-grade QFA-410 per-trade/session held-out evidence is present for this strategy; statistical Stage 1 thresholds are therefore not evaluable. |

## Threshold application

All Stage 1 quantitative threshold booleans are false because the required held-out evidence is unavailable, not because measured alpha failed. This distinction matters for next dispatch: the blocker is evidence construction, not strategy performance inference.

## Sensitivity audit

The LD-611-1 strategy-level execution sensitivity audit is not evaluable without per-trade held-out records containing regime / spread / queue-ahead cells. The system-level QFA-420 21+ warning flag remains false, but no strategy-specific concentration claim is made.

## Verdict summary

- ADVANCE_TO_PAPER: 0
- RESEARCH_FURTHER: 0
- REJECT: 4
- Phase 6 dispatch authorized: false

## Recommended next coordinator action

Do not dispatch Phase 6 paper/live tickets yet. The next enabling ticket should construct validation-grade per-strategy evidence packages: QFA-410 per-trade held-out replay output, QFA-302 pinned fingerprints, QFA-303 ready capability assessments, and QFA-310 primary pass artifacts for each active strategy. Then rerun QFA-611 against those artifacts.

## Scope discipline

No ADR, QFA-105, QFA-402, strategy formula, RunSpec, journal, determinism-gate, VIX/VXN, regime-label, or manifest changes are made by this ticket.
