# DATA-MBO-03: MBO Feature Use-Context Policy

DATA-MBO-03 implements the MBO feature availability and use-context policy from
ADR-0003. It creates the mechanical boundary between MBO diagnostics, shadow telemetry,
future advisory display, and blocked decision-use.

This ticket does not enable MBO trading decisions.

## Scope

Accepted:

- A versioned feature availability mask with explicit MBO policy metadata.
- A hard TypeScript helper:

```ts
assertFeatureUseAllowed(feature_name, use_context);
```

- Use-context checks for diagnostic, shadow, advisory-display, and decision contexts.
- Fail-closed handling for unmapped MBO feature names.
- A blocked-diagnostic-count exception so validators can count forbidden feature attempts
  without treating them as valid usage.

Still blocked:

- MBO in `STRAT_EVAL` gates.
- MBO in candidate confidence.
- MBO in ranking or ordering.
- MBO in `RISK_GATE`.
- MBO in sizing.
- MBO in `SIM_FILL` queue-position or fill-probability modeling.
- MBO in position management.
- MBO-derived ML labels.
- Queue position and queue-ahead as trading facts.

## Mask Version

DATA-MBO-03 advances the shared feature availability mask to:

```text
mask_version = 5
mask_id = feature-availability-mask-v5-adr0003-data-mbo03-advisory-policy
```

The TypeScript and Python implementations must remain byte-equivalent after JSON parse:

- `apps/strategy_runtime/src/features/availability-mask.ts`
- `services/market_data_sidecar/features/availability_mask.py`

The mask lineage references ADR-0003 while retaining ADR-0002 as the prior provider
sub-scope decision.

## Use Contexts

| Context | Meaning |
| --- | --- |
| `diagnostic` | Health, taxonomy, and operator diagnostics. |
| `shadow` | Explicit shadow telemetry with `decision_use=false`. |
| `advisory_display` | Operator display / recording only; no decision effect. |
| `strategy_gate` | Strategy gate or eligibility logic. |
| `candidate_confidence` | Candidate confidence or score construction. |
| `rank` | Candidate ordering, ranking, filtering, or tie-breaking. |
| `risk_gate` | Risk acceptance or rejection. |
| `sizing` | Quantity or risk-budget sizing. |
| `sim_fill` | Fill probability, queue position, or simulated execution modeling. |
| `position_management` | Stop, target, flatten, or management actions. |
| `ml_training` | Training labels or research datasets. |
| `blocked_diagnostic_count` | Validator-only counting of forbidden attempts. |

## Tier Rules

| Tier | Allowed contexts |
| --- | --- |
| `diagnostic_only` | `diagnostic`, `shadow`, `advisory_display` |
| `shadow_only` | `shadow`, `advisory_display` |
| `advisory_only` | `advisory_display` |
| `blocked` | `blocked_diagnostic_count` only |
| `available` | Reserved for a future accepted decision-use ADR. |

No MBO feature may enter a decision context unless a future ADR marks that exact feature
`available` for that exact context and validators are updated to enforce it.

## Current MBO Feature Policy

| Feature | Tier | Notes |
| --- | --- | --- |
| `mbo_action_counts` | `diagnostic_only` | Health/taxonomy evidence only. |
| `mbo_side_counts` | `diagnostic_only` | Health/taxonomy evidence only. |
| `mbo_action_counts_advisory` | `advisory_only` | Reserved for ORCH-MBO-02 display; no ranking effect. |
| `mbo_side_counts_advisory` | `advisory_only` | Reserved for ORCH-MBO-02 display; no ranking effect. |
| `mbo_action_imbalance_advisory` | `advisory_only` | Reserved for ORCH-MBO-02 display; no ranking effect. |
| `cancel_add_ratio_advisory` | `advisory_only` | Reserved for ORCH-MBO-02 display; no ranking effect. |
| `mbo_action_imbalance_shadow` | `shadow_only` | Existing ORCH-MBO-01 / REL-01E shadow field. |
| `cancel_add_ratio_shadow` | `shadow_only` | Existing ORCH-MBO-01 / REL-01E shadow field. |
| `order_lifetime_shadow` | `shadow_only` | Existing shadow field; not advisory-promoted yet. |
| `absorption_score_shadow` | `shadow_only` | Shadow vocabulary only; derivation remains unsupported until policy lands. |
| `sweep_score_shadow` | `shadow_only` | Shadow vocabulary only; derivation remains unsupported until policy lands. |
| `queue_position` | `blocked` | Requires separate queue/fill calibration. |
| `queue_ahead` | `blocked` | Requires separate queue/fill calibration. |
| `mbo_sim_fill_inputs` | `blocked` | Requires SIM-MBO calibration. |
| `mbo_ml_labels` | `blocked` | Requires research-label ADR and leakage controls. |

## Runtime Contract

Code that wants to use an MBO feature outside raw ingestion should call:

```ts
assertFeatureUseAllowed('cancel_add_ratio_shadow', 'shadow');
assertFeatureUseAllowed('mbo_action_counts_advisory', 'advisory_display');
```

These calls throw:

```ts
assertFeatureUseAllowed('cancel_add_ratio_shadow', 'rank');
assertFeatureUseAllowed('queue_position', 'sim_fill');
assertFeatureUseAllowed('unmapped_mbo_feature', 'diagnostic');
```

Blocked features may only be observed through:

```ts
assertFeatureUseAllowed('queue_position', 'blocked_diagnostic_count');
```

That exception exists for validators and reports that count forbidden attempts. It is not
permission to consume the field.

## Gate Impact

DATA-MBO-03 permits the project to implement ORCH-MBO-02 as an advisory-only display lane.

It does not permit:

- MBO decision-use.
- Queue-aware simulated fills.
- Real-order routing.
- Full DATA-01B promotion.
- Any change to REL-01-Short or formal REL-01 decision feature-surface comparability.

The next required tickets are ORCH-MBO-02 and REL-MBO-02.
