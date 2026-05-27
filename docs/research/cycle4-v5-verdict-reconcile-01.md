# Cycle4 v5 verdict reconciliation

## Context

This memo reconciles the governance meaning of PR #255, `CYCLE4-V5-INFERENCE-02-2MNQ`, merged at `9f4d9b9d48106853037496702dcbcabb42dd209e`.

It is a decision-record memo only. It does not change strategy code, management runtime, strategy YAMLs, the registry, `ACTIVE_STRATEGY_IDS`, paper-observation status, broker dispatch, or any ADR.

The evidence chain consumed here is:

| PR | Ticket | Role |
|---|---|---|
| #250 | `CYCLE4-2MNQ-REPLAY-SIZING-HARNESS-01` | Added research-only `--research-fixed-contracts 2` harness |
| #251 | `CYCLE4-REAL-ARCHIVE-MULTI-EXIT-01` | Fixed real-archive multi-exit runner behavior |
| #252 | `CYCLE4-HELDOUT-ARTIFACT-EVIDENCE-EXTEND-01` | Added quantity and per-exit evidence projection |
| #253 | `CYCLE4-MULTI-EXIT-PNL-ACCOUNTING-01` | Fixed multi-exit PnL accounting |
| #254 | `CYCLE4-ARCHIVE-FRAME-DECODE-01` | Fixed zstd false-boundary archive decode |
| #255 | `CYCLE4-V5-INFERENCE-02-2MNQ` | Emitted final informational v5 2MNQ evidence |

## Evidence inputs

Primary evidence inputs:

- `artifacts/strategy-selection/strategy-selection-cycle4-v5-02-2mnq.json`
- `docs/research/cycle4-v5-inference-02-2mnq-memo.md`
- `artifacts/held-out-validation/cycle4-v5-inference-02-2mnq/regime_shock_reversion_short_v5_strict_deadline-feb-mar-apr-2026.json`
- `artifacts/held-out-validation/cycle4-v5-inference-02-2mnq/regime_shock_reversion_short_v5_trail_at_deadline-feb-mar-apr-2026.json`

PR #255 used the explicit two-strategy roster:

- `regime_shock_reversion_short_v5_strict_deadline`
- `regime_shock_reversion_short_v5_trail_at_deadline`

The selection artifact records:

| Field | Value |
|---|---:|
| `advance_count` | 0 |
| `reject_count` | 2 |
| `research_further_count` | 0 |
| `phase_6_dispatch_authorized` | false |
| `effective_trial_count` | 2 |

## Verdict reconciliation

Both v5 deadline-extension variants reconcile to informational `REJECT`.

| Strategy | Verdict | Reason |
|---|---|---|
| `regime_shock_reversion_short_v5_strict_deadline` | `REJECT` | `three_or_more_stage1_thresholds_failed` |
| `regime_shock_reversion_short_v5_trail_at_deadline` | `REJECT` | `three_or_more_stage1_thresholds_failed` |

Threshold summary for both strategies:

| Threshold | Result |
|---|---|
| Profit factor | failed |
| Sharpe | failed |
| DSR | failed |
| PSR zero | failed |
| Drawdown | failed |
| Sensitivity audit | failed |
| Hurdle | failed |
| Trade count | passed |
| Regime trade | passed |

Both strategies failed 7 of 9 ADR-0016 Stage 1 thresholds. The verdict reason is invariant because both strategies fail well beyond the three-failure cutoff; omitting any single failed threshold would not alter the `REJECT` classification.

## Roster and authority decision

Decision:

- `ACTIVE_STRATEGY_IDS` remains unchanged.
- No v5 strategy is promoted.
- No v5 strategy is activated.
- No paper-observation authorization is granted.
- No broker or paper dispatch is authorized.
- No tuning is authorized.
- No v5 demotion or cleanup is performed in this ticket.

The two v5 variants remain REGISTERED_INACTIVE informational research variants.

## Research caveat

Two findings must be kept separate:

1. The 2MNQ infrastructure and evidence chain is complete and replay-capable.
2. The strict-vs-trail deadline behavior comparison remains unanswered because the corpus produced zero deadline-extension branch exposure.

Deadline exposure evidence:

| Strategy | Deadline-action trades | Profile mode |
|---|---:|---|
| `regime_shock_reversion_short_v5_strict_deadline` | 0 | `unconditional_exit` |
| `regime_shock_reversion_short_v5_trail_at_deadline` | 0 | `activate_trail` |

Both strategy outputs were identical in PR #255 because no emitted trade reached the deadline-extension branch. This memo does not claim strict and trail behavior are equivalent in deadline-exposed scenarios.

Quantity and partial-exit evidence confirms the original 2MNQ replay objective was satisfied:

| Strategy | Trades | `entry_quantity=2` | `exit_quantity=2` | PT1 partial exits | PT2 final exits |
|---|---:|---:|---:|---:|---:|
| `regime_shock_reversion_short_v5_strict_deadline` | 1129 | 1129 | 1129 | 520 | 187 |
| `regime_shock_reversion_short_v5_trail_at_deadline` | 1129 | 1129 | 1129 | 520 | 187 |

## Future routing

Non-authorizing follow-up options:

- Draft a targeted deadline-exposure harness if the operator still wants strict-vs-trail behavior evidence under positions that actually reach deadline management.
- Route `STRATEGY-IDS-RECONCILE-01` discovery after operator decision on active/registered-inactive roster hygiene.
- Perform backlog and handoff hygiene after the current evidence chain is fully closed.

These are routing suggestions only. They do not authorize implementation, activation, paper observation, tuning, broker dispatch, or strategy roster mutation.

## Decision ledger

- Coord-1: ACCEPT
- Coord-2: ACCEPT
- Operator: PENDING
