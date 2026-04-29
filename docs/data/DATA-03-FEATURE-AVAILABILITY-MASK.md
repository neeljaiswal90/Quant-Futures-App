# DATA-03: Feature Availability Mask

DATA-03 adds a deterministic feature-availability mask so downstream consumers can tell
which fields are authoritative, accepted only under a sub-scope, diagnostic-only,
shadow-only, or still blocked. The mask prevents ingestion from being mistaken for
trading-signal eligibility.

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

Blocked:

- Generic queue position as a hard fact
- Order lifetime
- Cancel/add ratio
- Absorption and sweep logic
- SIM calibration, ML/research features, and REL replay gates

## Payload Contract

DATA-01B-PS, DATA-01B-MBO, DATA-02-PS, DATA-02-MBO, and DATA-04 payloads carry:

```json
{
  "feature_availability_mask": {
    "schema_version": 1,
    "mask_version": 4,
    "mask_id": "feature-availability-mask-v4-adr0002-data03ps-mbo-shadow",
    "mask_hash": "sha256:...",
    "lineage": {
      "adr": "ADR-0002",
      "infra01e": "MBP10_PRICE_STATE_ACCEPTED_SUBSCOPE",
      "infra01f": "MBO_PROVIDER_INTERNAL_ACCEPTED_SUBSCOPE",
      "data01b_full_status": "blocked",
      "data01_full_status": "blocked"
    },
    "field_tiers": {
      "mbp10_top_bid_px": "authoritative",
      "mbo_order_id": "subscope",
      "mbo_ofi_short": "subscope",
      "queue_position_estimate": "subscope",
      "mbp10_size_diagnostic": "diagnostic_only",
      "mbo_record_count": "diagnostic_only",
      "cancel_add_ratio_shadow": "shadow_only",
      "queue_position": "blocked"
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

REL-00 / REL-01 decision payloads use `FEATURES.values` and `MICROSTRUCTURE.values`.
Those maps must stay authoritative-only. Diagnostic MBO telemetry may appear only in
`diagnostic_values` with `decision_use=false`; MBO shadow candidates may appear only in
`shadow_values` with `decision_use=false`. The validators fail if shadow fields appear in
decision `values`, if diagnostic/shadow payloads omit `decision_use=false`, or if blocked
fields appear anywhere in the feature surface.

## Gate Impact

DATA-03 is a guardrail layer. It does not unlock full DATA-01B, SIM-02/SIM-03,
RSRCH/ML, or REL gates by itself. It makes later tickets safer by forcing DATA-04,
ORCH, strategy ranking, replay parity, and operator tools to read field eligibility from a
single versioned policy surface instead of scattered status strings.
