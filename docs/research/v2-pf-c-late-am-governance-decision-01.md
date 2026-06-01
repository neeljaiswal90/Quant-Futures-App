# V2-PF-C-LATE-AM-GOVERNANCE-DECISION-01

## 1. Context

This memo reviews whether the registered-inactive strategy `regime_shock_reversion_short_v2_utc_16_18_exclusion` should receive paper-observation / Phase 6 authority now. It is a governance recommendation only. It does not mutate rosters, strategy code, qfa logic, artifacts, paper routing, broker/live routing, or operational authority.

The system remains intentionally zero-active. Any paper observation for this strategy would be a new authority lane, not restoration of a prior active strategy.

## 2. Evidence chain summary

| PR | Ticket | Result |
|---|---|---|
| #284 | `V2-PF-IMPROVEMENT-MECHANISM-SCOPE-01` | Identified `exclude_time_tier_C_late_am` as a pre-entry PF-improvement mechanism. |
| #285 | `V2-PF-REGISTERED-INACTIVE-VARIANT-SCOPE-01` | Scoped the UTC `16:00 <= ts < 18:00` registered-inactive variant. |
| #286 | `V2-PF-C-LATE-AM-REGISTERED-INACTIVE-IMPL-01` | Implemented `regime_shock_reversion_short_v2_utc_16_18_exclusion`; qfa-611 returned `RESEARCH_FURTHER` due sensitivity coverage. |
| #287 | `V2-PF-C-LATE-AM-FIDELITY-COVERAGE-RECHECK-01` | Classified the sensitivity blocker as qfa-402c coverage gap dominant. |
| #288 | `QFA-402C-FIDELITY-COVERAGE-EXTEND-01` | Added real low-regime qfa-402c probes from `2026-04-16-rth`; qfa-611 now returns `ADVANCE_TO_PAPER`. |

The qfa-611 chronology is load-bearing:

| Evidence point | Selection SHA | Verdict / determination |
|---|---|---|
| PR #286 original qfa-611 selection | `97b2e5dd1bbbfd6faa48762a755b9fe023321096572ac6449034a8c4b3a32e15` | `RESEARCH_FURTHER`; sensitivity audit failed due missing-cell concentration. |
| PR #287 fidelity recheck | `fd1616d...` | `FIDELITY_COVERAGE_GAP_REMAINS_DOMINANT`; blocker classified as zero-probe coverage, not observed low-fidelity fragility. |
| PR #288 post-qfa402c-extension qfa-611 selection | `580b09f2db2bb10d3c1e4072ec7c6f85d6da9319f15d426c3f5fefc2c289724b` | `ADVANCE_TO_PAPER`; sensitivity audit passed after real low-regime qfa-402c coverage extension. |

This memo relies on the PR #288 post-extension qfa-611 selection, not the pre-extension PR #286 selection.

Evidence anchors from the current substrate:

| Evidence | SHA-256 |
|---|---|
| qfa-402c fidelity artifact | `548f11c4f2213026484b238ad0246abbc2987d66387b3dcf589ec20a79663ab3` |
| held-out artifact | `e77e7eef8b0dc588029fbb4318de399253dd64f1277ed4f0c05c5ba9b5192817` |
| qfa-611 selection JSON | `580b09f2db2bb10d3c1e4072ec7c6f85d6da9319f15d426c3f5fefc2c289724b` |
| qfa-611 selection Markdown | `e55473a46b7c336ff8bb35622387d76438bec478b38f7dffadf520aca7cb628a` |
| qfa-402c coverage diagnostic JSON | `816c188178f664700f252c17440daed21cda05400e200f80edff52fce88f74cb` |

## 3. Current strategy/governance state

| Item | State |
|---|---|
| Strategy ID | `regime_shock_reversion_short_v2_utc_16_18_exclusion` |
| Roster | `REGISTERED_INACTIVE` |
| `ACTIVE_STRATEGY_IDS` | `[]` |
| `CANDIDATE_STRATEGY_IDS` | `[]` |
| Actual paper authority | none |
| Actual broker/live authority | none |
| Actual Phase 6 authority | none |

## 4. qfa-611 evidence summary

| Metric | Value |
|---|---:|
| Verdict | `ADVANCE_TO_PAPER` |
| Verdict reason | `all_stage1_thresholds_passed` |
| PF | 1.354742 |
| Trades | 739 |
| Win rate | 0.484438 |
| Annualized Sharpe | 3.9562743142 |
| DSR statistic | 3.4510773787 |
| PSR zero | 0.9997208233 |
| Max drawdown | 0.595% |
| HAC t-stat | 1.5940534737 |
| qfa-611 `phase_6_dispatch_authorized` field | `true` |

Threshold results:

| Threshold | Pass |
|---|---|
| Profit factor | `true` |
| Sharpe | `true` |
| DSR | `true` |
| PSR zero | `true` |
| Hurdle | `true` |
| Trade count | `true` |
| Regime trade contribution | `true` |
| Drawdown | `true` |
| Sensitivity audit | `true` |

The qfa-611 output is evidence for review. It is not operational authority.

## 5. Fidelity coverage and residual low-fidelity assessment

PR #288 changed the sensitivity blocker from coverage-missing to coverage-observed. The coverage diagnostic records:

| Field | Value |
|---|---:|
| Determination | `SENSITIVITY_PASS_AFTER_COVERAGE_EXTENSION` |
| qfa-611 outcome | `ADVANCE_TO_PAPER` |
| Authority created by PR #288 | `false` |
| Unknown-cell trades before PR #288 | 351 |
| Unknown-cell trades after PR #288 | 0 |
| Low-fidelity trades after PR #288 | 43 |
| Low-fidelity fraction after PR #288 | 5.81867388% |
| Sensitivity audit reason | `clean` |

The residual low-fidelity exposure does not block the qfa-611 sensitivity gate because it is below the concentration threshold. That does not prove the low-fidelity cells are harmless. It means the evidence package no longer fails the qfa-611 sensitivity rule. If paper observation is later scoped, these low-fidelity cells should be monitored explicitly as an operational risk item.

Residual low-fidelity cells:

| Cell | Probe count | Share ppm | Strategy trades | Strategy trade fraction |
|---|---:|---:|---:|---:|
| `low / 2-tick / 21+` | 75 | 560000 | 1 | 0.135318% |
| `low / 3+ ticks / 1-5` | 564 | 739361 | 20 | 2.706360% |
| `low / 3+ ticks / 6-20` | 383 | 592689 | 22 | 2.976996% |

## 6. Risk assessment

Primary favorable points:

- qfa-611 reports `ADVANCE_TO_PAPER` with `all_stage1_thresholds_passed`.
- The sensitivity audit passes after qfa-402c coverage extension.
- Unknown-cell exposure is eliminated.
- PF is above the `1.35` qfa-611 threshold at `1.354742`.
- Drawdown is low in the held-out artifact at 0.595%.

Primary risks:

- Evidence is still held-out replay evidence from Feb-Mar-Apr 2026, not live/paper observation.
- qfa-402c coverage was extended using `2026-04-16-rth`; that is a real observed low-regime session, but still a finite coverage sample.
- Residual low-fidelity exposure remains at 43 trades / 5.81867388%.
- The active roster is intentionally empty, so any paper observation would be a new operational lane.
- qfa-611's `phase_6_dispatch_authorized: true` field is not itself authority in this governance process.

## 7. Decision options considered

| Option | Disposition | Assessment |
|---|---|---|
| A | `APPROVE_PAPER_OBSERVATION_ONLY` | Supported as a recommendation-only disposition because qfa-611 advances, all stage-1 thresholds pass, sensitivity passes, residual low-fidelity exposure is below threshold, and the strategy remains registered inactive. |
| B | `APPROVE_PHASE6_PREP_ONLY` | More aggressive than necessary for the immediate next step. Phase 6 prep can follow paper-observation scoping if operators approve. |
| C | `DEFER_AUTHORITY_PENDING_ADDITIONAL_EVIDENCE` | Not selected because the specific qfa-402c coverage gap was resolved and no artifact mismatch was found. |
| D | `REJECT_AUTHORITY` | Not selected because the latest qfa-611 evidence passes the stage-1 and sensitivity gates. |

## 8. Recommended disposition

Recommended disposition:

`APPROVE_PAPER_OBSERVATION_ONLY`

This is a recommendation only. It does not grant paper-observation authority by itself. The strategy should remain `REGISTERED_INACTIVE` until a separate implementation/ops ticket scopes and authorizes any paper-observation wiring. Broker/live dispatch remains forbidden.

Rationale:

- qfa-611 verdict is `ADVANCE_TO_PAPER`.
- qfa-611 reason is `all_stage1_thresholds_passed`.
- All stage-1 threshold booleans are true.
- Sensitivity audit passes after PR #288.
- Unknown-cell trades are `0`.
- Residual low-fidelity exposure is below the qfa-611 concentration threshold.
- No evidence artifact mismatch was found.
- Current actual authority remains none.

## 9. Required follow-up ticket

Recommended follow-up ticket:

`V2-PF-C-LATE-AM-PAPER-OBSERVATION-SCOPE-01`

Purpose:

`Scope paper-observation wiring/checklist for regime_shock_reversion_short_v2_utc_16_18_exclusion without broker/live authority.`

That follow-up should explicitly decide whether and how to create a paper-observation lane, what monitoring is required for the residual low-fidelity cells, and which operator approvals are required before any paper dispatch occurs. Do not add broker/live authority in that ticket unless separately authorized.

## 10. Authority caveat

This memo does not activate any strategy, does not mutate `ACTIVE_STRATEGY_IDS`, does not mutate `CANDIDATE_STRATEGY_IDS`, does not remove the strategy from `REGISTERED_INACTIVE_STRATEGY_IDS`, does not authorize paper observation, does not authorize broker/live dispatch, and does not create Phase 6 authority.

Actual authority requires a separate operator-approved implementation/ops ticket.
