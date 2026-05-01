# ADR-0003: MBO Action Taxonomy And Promotion Policy

## Status

Accepted

## Ticket

DATA-MBO-ADR-01

## Context

ADR-0002 accepted provider-internal MBO lifecycle ingestion as a V1 sub-scope, while
keeping full DATA-01B, queue-aware fill modeling, and MBO-derived trading decisions
blocked. DATA-01B-MBO now normalizes Rithmic MBO lifecycle records into OBS-01-compatible
`MICROSTRUCTURE` events for `add`, `modify`, and `cancel` actions.

The MBO shadow chain is operationally proven:

- ORCH-MBO-01 emits shadow-only telemetry with source-byte hash binding and
  `decision_use=false`.
- REL-00, REL-01D, and REL-01E validate the shadow journal surface, aggregate
  feature use, and source-lineage recomputation.
- `reports/rel/mbo_shadow_evidence_current/mbo_shadow_evidence_report.json`
  passed across 3 sessions, 85,591 indexed source MBO events, 857 shadow events, and
  2,571 shadow field occurrences.
- The evidence packet reported zero restricted uses, blocked uses, unsafe
  `decision_use` events, missing source events, lookahead events, recompute mismatches,
  and source hash mismatches.

That evidence proves the diagnostic/shadow lane is repeatable. It does not prove that
MBO-derived features are safe trading inputs. The remaining blocker is policy: which MBO
actions and derived features may advance from shadow to advisory, and which must remain
blocked until stronger lifecycle, taxonomy, and SIM calibration evidence exists.

## Decision

For V1, MBO remains diagnostic/shadow-only for runtime trading behavior.

This ADR is accepted as policy. Implementation tickets remain required before advisory
feature emission or any later decision-use canary.

## Accepted Normalized Action Literals

For V1, the only accepted normalized MBO action literals are:

- `add`
- `modify`
- `cancel`
- `trade`
- `unknown`

Any other normalized action literal is `blocked_unknown_taxonomy` until this ADR or a
successor ADR is updated.

The accepted provider-internal structural lifecycle action taxonomy is:

| Action | Policy class | Meaning | Eligible use |
| --- | --- | --- | --- |
| `add` | structural_book_action | New visible provider-internal order lifecycle fact. | Diagnostic, shadow, future advisory aggregate counts. |
| `modify` | structural_book_action | Provider-internal order size/price/lifecycle update. | Diagnostic, shadow, future advisory aggregate counts. |
| `cancel` | structural_book_action | Provider-internal visible order removal/cancel lifecycle fact. | Diagnostic, shadow, future advisory aggregate counts. |
| `trade` | provider_taxonomy_variance | Trade semantics are not accepted as MBO lifecycle truth for V1; trades are handled by LAST_TRADE. | Diagnostic only. |
| `unknown` | provider_taxonomy_variance | Provider-specific or unmapped action category. | Diagnostic only. |
| `delete` / `remove` | blocked_unknown_taxonomy unless explicitly normalized to `cancel` by provider-specific mapping | Resting order removal semantics are not accepted as standalone V1 action strings unless mapped to `cancel` in the normalizer with tests. | Diagnostic rejection counts only. |
| `decrement` | blocked_unknown_taxonomy unless explicitly normalized to `modify` by provider-specific mapping | Size-reduction semantics are not accepted as standalone V1 action strings unless mapped to `modify` in the normalizer with tests. | Diagnostic rejection counts only. |
| any unmapped action | blocked_unknown_taxonomy | Not accepted until explicitly classified by a later ADR. | Blocked except diagnostic rejection counts. |

The next promotion tier is advisory-only, not decision-use. Advisory means the feature may
be displayed, summarized, and recorded for operators, but must not affect strategy gates,
candidate confidence, ranking, risk gates, sizing, simulated fills, position management,
or ML/research labels.

Advisory-only features must not affect ordering, filtering, scoring, confidence, candidate
eligibility, risk acceptance, sizing, fill modeling, management actions, or ML labels.

## Feature Promotion Ladder

MBO features must move through these tiers in order:

| Tier | Meaning |
| --- | --- |
| `diagnostic_only` | May be counted, displayed, and used for health/taxonomy evidence only. |
| `shadow_only` | May be emitted as explicit shadow telemetry with `decision_use=false` and lineage where required. |
| `advisory_only` | May be displayed or recorded for operators, but cannot change decisions or output ordering. |
| `limited_decision_canary` | Future, single-feature, single-context simulation-only experiment after a successor ADR. |
| `decision_use` | Future accepted use after canary evidence, validator support, and explicit opt-in. |

Feature promotion policy:

| Feature family | Current status | Next eligible status | Decision |
| --- | --- | --- | --- |
| MBO health telemetry | `diagnostic_only` | `diagnostic_only` | Accepted for operator diagnostics and evidence reports. |
| MBO action counts | `shadow_only` / diagnostic | `advisory_only` | Eligible for advisory after validator support exists. |
| MBO side counts | `shadow_only` / diagnostic | `advisory_only` | Eligible for advisory after validator support exists. |
| Structural add/cancel/modify aggregates | `shadow_only` | `advisory_only` | Eligible only under the taxonomy in this ADR. |
| `mbo_action_imbalance_shadow` | `shadow_only` | `advisory_only` | Eligible as the first advisory candidate; still not a decision signal. |
| `cancel_add_ratio_shadow` | `shadow_only` | `advisory_only` | Eligible for advisory after add/cancel stability is reviewed. |
| `order_lifetime_shadow` | `shadow_only` | blocked or advisory-later | Requires stronger lifecycle reconstruction and outlier policy. |
| `absorption_score_shadow` | `shadow_only` | blocked | Requires accepted trade/decrement semantics; not eligible yet. |
| `sweep_score_shadow` | `shadow_only` | blocked | Requires accepted trade semantics; not eligible yet. |
| queue position / queue-ahead | `blocked` or sub-scope diagnostic | blocked | Requires separate queue/fill calibration; not eligible for advisory promotion here. |
| MBO-derived SIM_FILL inputs | blocked | blocked | Requires SIM-MBO calibration before any promotion. |
| MBO-derived ML labels | blocked | blocked | Requires research-label ADR and leakage controls. |

MBO decision-use remains blocked. This ADR does not approve MBO-derived fields in:

- `STRAT_EVAL` gates;
- candidate confidence;
- ranking;
- `RISK_GATE`;
- sizing;
- `SIM_FILL` queue-position or fill-probability modeling;
- stop logic or position management;
- ML training labels.

## Required Follow-Up Gates

Before advisory promotion:

- DATA-MBO-03 must add an explicit MBO feature availability mask policy for
  `advisory_only` vs `shadow_only` vs `blocked` fields.
- The runtime must expose an `assertFeatureUseAllowed(feature_name, use_context)`-style
  guard or equivalent validator/runtime policy.
- ORCH-MBO-02 must emit advisory-only MBO facts with `decision_use=false`.
- REL-MBO-02 must fail if advisory fields enter decision channels or omit taxonomy/status
  metadata.
- An advisory-on/advisory-off replay comparison must prove byte-equivalent or
  structurally equivalent decision outputs for `STRAT_EVAL` decisions, the `CANDIDATE`
  set, `RANK` order, `SIZING` decisions, `RISK_GATE` decisions, `ORDER_INTENT` events,
  `SIM_FILL` events, and `POSITION` / `MGMT_ACTION` lifecycle events.
- The only allowed advisory-on/advisory-off difference is additional advisory or shadow
  telemetry events.

Before any limited decision-use canary:

- A later ADR must name exactly one feature and one permitted use context.
- The feature availability mask must mark that field available only for that context.
- Strategy config must explicitly opt in.
- REL validators must distinguish advisory use from decision-use and fail closed on
  unapproved contexts.
- The canary must remain simulation-only with no real orders.

Before queue-position or queue-aware fill modeling:

- MBO lifecycle reconstruction must cover add/modify/delete/cancel/trade/decrement
  semantics.
- A front-of-queue model must be calibrated against provider-internal replay evidence.
- SIM-MBO-01 or equivalent must show that queue-aware fills do not invalidate existing
  SIM-03 calibration.
- REL evidence must be regenerated under the queue-aware model.

## Consequences

The 3-session MBO shadow evidence packet may be cited as proof that MBO diagnostic/shadow
collection is repeatable under the current validators.

MBO may proceed to an advisory-only implementation track, starting with structural action
counts, side counts, `mbo_action_imbalance_shadow`, and possibly `cancel_add_ratio_shadow`.

MBO must not be enabled as a trading decision input by this ADR. The project must not
claim full DATA-01B, MBO decision readiness, queue-position readiness, or SIM_FILL
queue-model readiness from the shadow evidence packet alone.

This ADR does not change REL-01-Short or formal REL-01 decision feature-surface rules.

If future work adds new MBO action strings, derived fields, or decision contexts, they
must be added to this taxonomy or a successor ADR before validators or runtime code may
treat them as anything other than blocked/diagnostic.
