# DATA-03: Feature Availability Mask

DATA-03 adds a deterministic feature-availability mask so downstream consumers can tell
which fields are authoritative, accepted only under a sub-scope, diagnostic-only,
shadow-only, advisory-only, future-available, or still blocked. The mask prevents
ingestion from being mistaken for trading-signal eligibility.

## Scope

The mask is versioned and shared across TypeScript and Python:

- TypeScript: `apps/strategy_runtime/src/features/availability-mask.ts`
- Python: `services/market_data_sidecar/features/availability_mask.py`

Both implementations produce the same JSON object and `mask_hash`.

## Tiers

| Tier | Meaning |
| --- | --- |
| `authoritative` | May be consumed as a hard trading/replay field under the current policy. |
| `subscope` | Accepted only within the documented provider-internal or partial sub-scope. |
| `diagnostic_only` | May be observed and reported, but must not drive hard trading gates. |
| `shadow_only` | May be emitted only in explicit shadow payloads with `decision_use=false`; must not drive strategy, risk, sizing, fill, or REL decisions. |
| `advisory_only` | May be displayed or summarized as advisory telemetry only; must not affect ordering, filtering, scoring, eligibility, risk, sizing, fills, management, or ML labels. |
| `available` | Reserved for a future accepted decision-use policy. No MBO field is `available` in DATA-MBO-03. |
| `blocked` | Must not be consumed by ORCH, strategy, SIM, RSRCH, or REL gates yet. |

## Current Assignments

Authoritative:

- `exchange_event_ts_ns`
- L1 quote bid/ask prices
- LAST_TRADE price, size, and aggressor side
- MBP10 price-state top bid/ask, spread, mid, price ladders, freshness, and L1-vs-MBP10
  price consistency

Sub-scope:

- MBO provider-internal lifecycle event fields: action, side, price, size, order ID,
  sequence, and priority
- DATA-02-MBO provider-internal book state fields: MBO top bid/ask, spread, mid,
  active order counts, price-level aggregate sizes, order counts, and FIFO queue-position
  estimates
- DATA-04 provider-internal derived microstructure fields: MBO size imbalance,
  microprice offset, OFI windows, recent depth imbalance, and queue-ahead fraction

Diagnostic only:

- `sidecar_recv_ts_ns` and `rithmic_publish_ts_ns`
- MBP10 size and order-count fields
- MBO health telemetry such as record/action/side counts, sequence/timestamp coverage,
  order-ID coverage, price-tick alignment, trade/unknown counts, and taxonomy status
- Generic size-weighted microprice, top-of-book size imbalance, depth imbalance, and OFI
  fields that are not explicitly produced from the accepted DATA-02-MBO provider-internal
  sub-scope
- Databento `trade`/`unknown` MBO action taxonomy equivalence

Shadow only:

- `cancel_add_ratio_shadow`
- `order_lifetime_shadow`
- `absorption_score_shadow`
- `sweep_score_shadow`
- `mbo_action_imbalance_shadow`

Advisory only:

- `mbo_action_counts_advisory`
- `mbo_side_counts_advisory`
- `mbo_action_imbalance_advisory`
- `cancel_add_ratio_advisory`

Blocked:

- Generic queue position as a hard fact
- Queue-ahead facts
- Order lifetime
- Cancel/add ratio
- Absorption and sweep logic
- MBO-derived SIM fill inputs, ML labels, and REL replay gates

## Payload Contract

DATA-01B-PS, DATA-01B-MBO, DATA-02-PS, DATA-02-MBO, and DATA-04 payloads carry:

```json
{
  "feature_availability_mask": {
    "schema_version": 1,
    "mask_version": 5,
    "mask_id": "feature-availability-mask-v5-adr0003-data-mbo03-advisory-policy",
    "mask_hash": "sha256:...",
    "lineage": {
      "adr": "ADR-0003",
      "prior_adr": "ADR-0002",
      "infra01e": "MBP10_PRICE_STATE_ACCEPTED_SUBSCOPE",
      "infra01f": "MBO_PROVIDER_INTERNAL_ACCEPTED_SUBSCOPE",
      "data_mbo_03": "MBO_FEATURE_USE_CONTEXT_POLICY",
      "data01b_full_status": "blocked",
      "data01_full_status": "blocked",
      "mbo_decision_use_status": "blocked"
    },
    "field_tiers": {
      "mbp10_top_bid_px": "authoritative",
      "mbo_order_id": "subscope",
      "mbo_ofi_short": "subscope",
      "queue_position_estimate": "subscope",
      "mbp10_size_diagnostic": "diagnostic_only",
      "mbo_record_count": "diagnostic_only",
      "cancel_add_ratio_shadow": "shadow_only",
      "mbo_action_counts_advisory": "advisory_only",
      "queue_position": "blocked"
    },
    "mbo_policy": {
      "accepted_normalized_actions": ["add", "modify", "cancel", "trade", "unknown"],
      "decision_contexts": [
        "strategy_gate",
        "candidate_confidence",
        "rank",
        "risk_gate",
        "sizing",
        "sim_fill",
        "position_management",
        "ml_training"
      ]
    }
  }
}
```

The scalar `values` map also carries:

- `feature_availability_mask_version`
- `feature_availability_mask_id`
- `feature_availability_mask_hash`

## Consumer Rules

TypeScript consumers should use:

```ts
assertAuthoritative(mask, 'mbp10_top_bid_px');
tierOf(mask, 'mbo_order_id');
```

`assertAuthoritative` throws for `subscope`, `diagnostic_only`, `shadow_only`, or `blocked`
fields. This is intentional: strategy/ranking/REL code must make an explicit policy choice
before using anything outside the authoritative tier.

MBO-specific consumers should also use:

```ts
assertFeatureUseAllowed('cancel_add_ratio_shadow', 'shadow');
assertFeatureUseAllowed('queue_position', 'blocked_diagnostic_count');
```

`assertFeatureUseAllowed(featureName, useContext)` fails closed for unmapped feature names.
DATA-MBO-03 allows diagnostic MBO fields only in diagnostic, shadow, or advisory-display
contexts; shadow fields only in shadow or advisory-display contexts; advisory fields only
in advisory-display contexts; and blocked fields only for explicit blocked-diagnostic
counting. No MBO feature may be used in a decision context unless a future ADR promotes
that exact feature.

REL-00 / REL-01 decision payloads use `FEATURES.values` and `MICROSTRUCTURE.values`.
Those maps must stay authoritative-only. Diagnostic MBO telemetry may appear only in
`diagnostic_values` with `decision_use=false`; MBO shadow candidates may appear only in
`shadow_values` with `decision_use=false`. The validators fail if shadow fields appear in
decision `values`, if diagnostic/shadow payloads omit `decision_use=false`, or if blocked
fields appear anywhere in the feature surface.

## Gate Impact

DATA-03/DATA-MBO-03 is a guardrail layer. It does not unlock full DATA-01B,
MBO decision-use, queue-aware SIM_FILL modeling, RSRCH/ML, or REL gates by itself. It
makes later tickets safer by forcing DATA-04, ORCH, strategy ranking, replay parity, and
operator tools to read field eligibility from a single versioned policy surface instead of
scattered status strings.
