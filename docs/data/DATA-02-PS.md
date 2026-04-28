# DATA-02-PS: MBP10 Price-State Feature Snapshot Builder

DATA-02-PS builds feature snapshots from the ADR-0002 MBP10 price-state sub-scope. It
does not complete full DATA-01B, does not accept MBO parity, and does not enable
queue-position or size-authoritative features.

## Accepted Scope

Accepted inputs:

- DATA-01B-PS `MICROSTRUCTURE` price-state journal events.
- Rich Rithmic `MBP10` rows using the same price-keyed reconstruction.
- Optional `L1_QUOTE` rows/events for diagnostic L1-vs-MBP10 top-of-book consistency.

Accepted feature surface:

- Top bid and top ask price.
- Spread in points and ticks.
- Midprice.
- Complete top-of-book presence.
- MBP10 bid/ask price ladder.
- Price-level spacing and density summaries.
- Price-state freshness based on exchange-time gaps.
- Diagnostic L1-vs-MBP10 top-of-book consistency when L1 data is present.

Diagnostic only:

- MBP10 size summaries.
- MBP10 order-count summaries.
- Any values named with `diagnostic`.

Blocked:

- MBO production ingestion.
- MBO-derived features.
- Queue-position features.
- OFI or depth imbalance as hard trading gates.
- Full DATA-01B and full DATA-01.
- SIM-02/SIM-03, ML/research dataset generation, and REL gate advancement.

## Command

```powershell
npm run data:02:price-state-features -- `
  --input data/journals/data01b-ps/mbp10-price-state.jsonl `
  --out data/journals/data02-ps/mbp10-price-state-features.jsonl `
  --report reports/data/data02_ps_report.json `
  --run-id data02-ps-post04d `
  --session-id 2026-04-27-rth `
  --symbol MNQM6
```

The input may also be a rich Rithmic probe JSONL. Generated journals and reports are local
artifacts and must not be committed.

## Snapshot Shape

The builder emits OBS-01-compatible `MICROSTRUCTURE` envelopes. When the input is a
prior DATA-01B-PS `MICROSTRUCTURE` event, the output inherits the same
`exchange_event_ts_ns`/`ts_ns`, carries `payload.source_event_id`, and sets
`causation_id` to the prior event id. When the input is a rich Rithmic probe row, the
builder derives the source-like price-state fact inline from that row and uses the row's
`exchange_event_ts_ns` directly.

The payload includes:

- `feature_schema_version = 1`;
- `feature_snapshot_id`;
- `exchange_event_ts_ns` as canonical event time;
- `sidecar_recv_ts_ns` as telemetry only;
- `symbol`;
- `source = mbp10_price_state`;
- top-of-book price fields;
- `spread_points`, `spread_ticks`, and `mid_px`;
- `bid_levels_px` and `ask_levels_px`;
- `price_ladder_summary`;
- `validity`;
- `values`, a scalar map for downstream consumers.

The payload repeats the guardrail status fields:

- `mbp10_price_state_status = accepted_subscope`;
- `mbo_status = blocked`;
- `size_order_count_status = diagnostic_only`;
- `data01b_full_status = blocked`.

## Validity Masks

Every snapshot carries:

- `has_complete_top_of_book`;
- `spread_valid`;
- `price_ladder_valid`;
- `stale_mbp10_state`;
- `l2_l3_scope = price_state_only`;
- `mbo_features_available = false`.

Snapshots with missing top bid or top ask are emitted as invalid rather than silently
promoted. This keeps replay diagnostics visible without allowing incomplete book state to
be treated as a valid trading gate.

## Gate Impact

DATA-02-PS is a narrow feature-builder unlock for MBP10 price-state only. It may support
top-of-book and inside-price features for V1, but it does not validate size, queue, MBO, or
full depth authority. Full DATA-01B remains blocked until MBO parity and size/order-count
policy are separately accepted.
