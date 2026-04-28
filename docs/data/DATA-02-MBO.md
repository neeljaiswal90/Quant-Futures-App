# DATA-02-MBO: Provider-Internal MBO Book State

DATA-02-MBO consumes DATA-01B-MBO lifecycle events and reconstructs provider-internal
order book state. It is the first derived MBO layer after INFRA-01F, but it still does not
complete full DATA-01B or authorize cross-feed order-by-order parity.

## Scope

Accepted:

- DATA-01B-MBO `MICROSTRUCTURE` lifecycle events.
- Rich Rithmic `MBO` rows for inline offline reconstruction when no upstream lifecycle
  journal exists.
- Provider-internal `Map<order_id, OrderState>` reconstruction.
- FIFO queue-position estimates within one provider feed.
- Price-level aggregate size and order count within the provider-internal MBO sub-scope.
- `exchange_event_ts_ns` as canonical event time.
- `sidecar_recv_ts_ns` as telemetry only.

Not accepted:

- Queue position as a provider-neutral fact.
- Cross-feed order-by-order replay equivalence.
- MBO `trade`/`unknown` taxonomy as a hard parity gate.
- SIM/ML/RSRCH/REL gates.

## Command

```powershell
npm run data:02:mbo -- `
  --input data/journals/data01b-mbo/mbo-order-lifecycle.jsonl `
  --out data/journals/data02-mbo/mbo-book-state.jsonl `
  --report reports/data/data02_mbo_report.json `
  --run-id data02-mbo-post04d `
  --session-id 2026-04-27-rth `
  --symbol MNQM6
```

Do not commit generated journals or reports.

## Event Shape

The builder emits derived `MICROSTRUCTURE` envelopes with:

- `source = "mbo_order_book_state"`;
- `microstructure_kind = "mbo_order_book_state"`;
- `causation_id` set to the source DATA-01B-MBO lifecycle `event_id` when present;
- `source_event_id` in the payload for operator visibility;
- `mbo_book_state_status = accepted_subscope`;
- `queue_position_status = provider_internal_estimate`;
- `data01b_full_status = blocked`.

If the input is a direct rich `MBO` probe row, the output is an inline offline derivation
and does not invent a `causation_id`; use DATA-01B-MBO input when EVT-01 lineage is
required.

Each payload includes:

- top bid/ask from the provider-internal MBO book;
- spread and midprice from that provider-internal MBO book;
- `bid_levels` and `ask_levels`, each sorted by price;
- `aggregate_size_subscope` and `order_count_subscope` per price level;
- active order count;
- queue estimates for the updated order:
  - `queue_position_estimate`;
  - `queue_ahead_size_estimate`;
  - `queue_ahead_order_count_estimate`;
  - `queue_position_as_fact_available = false`.

## Feature Availability

DATA-02-MBO bumps the DATA-03 mask to version 2:

- `mbo_book_state`, `mbo_top_bid_px`, `mbo_top_ask_px`, MBO spread/mid, active order
  counts, price-level aggregate sizes, order counts, and queue estimates are `subscope`.
- Generic `queue_position` and `queue_position_as_fact` remain `blocked`.
- `mbo_trade_unknown_taxonomy` remains `diagnostic_only`.

Consumers must not call `assertAuthoritative` on these MBO fields. They are available
only inside the provider-internal sub-scope accepted by ADR-0002 and INFRA-01F.

## Report Status

Reports include:

- `mbo_status = accepted_subscope`;
- `mbo_lifecycle_status = accepted_subscope`;
- `mbo_book_state_status = accepted_subscope`;
- `queue_position_status = provider_internal_estimate`;
- `provider_scope = provider_internal`;
- `data01b_full_status = blocked`.

## Gate Impact

DATA-02-MBO enables DATA-04 and SIM-02/SIM-03 to consume provider-internal order book
state intentionally. It does not make queue position a hard fact, does not unblock full
DATA-01B, and does not advance REL gates by itself.
