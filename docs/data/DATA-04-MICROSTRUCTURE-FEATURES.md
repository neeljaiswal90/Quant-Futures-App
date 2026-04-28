# DATA-04 — Tier-Aware Microstructure Feature Engine

DATA-04 builds derived microstructure `FEATURES` events from the accepted V1 data surface:

- DATA-02-PS MBP10 price-state snapshots.
- DATA-02-MBO provider-internal order-book snapshots.
- DATA-01A trade events.
- DATA-03 feature availability mask v3.

The output status is:

```text
microstructure_feature_status = accepted_tiered
data01b_full_status = blocked
sim_status = blocked
rel_status = blocked
```

Full DATA-01B is still not complete. DATA-04 consumes accepted sub-scopes, but it does not claim strict cross-feed equivalence for MBO, queue position as fact, ML/research readiness, or REL replay readiness.

## Output

The CLI emits OBS-01 `FEATURES` envelopes:

```powershell
npm run data:04:microstructure-features -- `
  --input <data02-journal.jsonl> `
  --out <data04-features.jsonl> `
  --report <data04-report.json> `
  --run-id <run-id> `
  --session-id <YYYY-MM-DD-rth> `
  --symbol MNQM6
```

Each derived event carries:

- `causation_id` pointing to the triggering upstream event.
- `source_event_ids` listing the price-state, MBO, and trigger events used by the snapshot.
- `feature_availability_mask` with `mask_version = 3`.
- `feature_tiers` for every emitted derived feature.
- `blocked_features` for fields deliberately not emitted as usable features.
- `values` as a scalar map for strategy/runtime consumers.

`exchange_event_ts_ns` remains canonical. `sidecar_recv_ts_ns` is never used to timestamp DATA-04 feature snapshots.

## Feature Tiers

Authoritative features are derived only from accepted price-state or trade inputs:

- `spread_points`
- `spread_ticks`
- `mid_px`
- `trade_aggressor_imbalance`

Subscope features are provider-internal MBO-derived features accepted by ADR-0002 and INFRA-01F:

- `top_of_book_imbalance`
- `microprice_offset_ticks`
- `ofi_short`
- `ofi_medium`
- `ofi_blend`
- `recent_depth_imbalance`
- `queue_imbalance`
- `queue_ahead_fraction_estimate`

Diagnostic-only fields remain observability inputs, not hard trading gates:

- MBP10 size diagnostics.
- MBP10 order-count diagnostics.
- Databento `trade`/`unknown` MBO taxonomy comparisons.

Blocked fields are not emitted as usable derived features:

- `queue_position`
- `queue_position_as_fact = blocked`
- `order_lifetime`
- `cancel_add_ratio`
- `absorption`
- `sweep`

## Guardrails

DATA-04 intentionally does not start or unblock:

- Full DATA-01B.
- SIM-02/SIM-03 remain blocked.
- RSRCH-01..03.
- ML/research dataset generation.
- REL-00 / REL-01.
- Cross-feed order-by-order replay parity.

Consumers must use `feature_tiers` or the DATA-03 mask helpers before treating a field as authoritative. If a downstream component needs a hard fact, it must reject `subscope`, `diagnostic_only`, and `blocked` tiers.
