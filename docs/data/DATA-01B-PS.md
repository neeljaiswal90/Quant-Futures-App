# DATA-01B-PS: MBP10 Price-State Ingestion Sub-Scope

DATA-01B-PS implements only the MBP10 price-state sub-scope accepted by ADR-0002. It does
not complete full DATA-01B and does not enable MBO-derived or queue-position features.

## Scope

Accepted:

- Rich Rithmic `MBP10` rows.
- Price-keyed bid/ask book reconstruction.
- Bid levels sorted descending.
- Ask levels sorted ascending.
- Zero-size updates delete the price level.
- `exchange_event_ts_ns` as canonical event time.
- `sidecar_recv_ts_ns` as receive-time telemetry only.
- OBS-01-compatible `MICROSTRUCTURE` journal envelopes for price-state snapshots.

Diagnostic only:

- MBP10 size fields.
- MBP10 order-count fields.
- Cross-source size/order-count parity.

Not consumed by this price-state path:

- MBO production ingestion.
- MBO-derived features.
- Queue-position features.

Still blocked globally:

- Full DATA-01B.
- Full DATA-01.
- SIM-02/SIM-03, ML/research dataset generation, and REL gates.

## Command

```powershell
npm run data:01b:price-state -- `
  --input data/probes/infra01/full/probe-parity-post04d.jsonl `
  --out data/journals/data01b-ps/mbp10-price-state.jsonl `
  --report reports/data/data01b_ps_report.json `
  --run-id data01b-ps-post04d `
  --session-id 2026-04-27-rth
```

Do not commit generated journals or reports.

## Event Shape

The publisher emits `MICROSTRUCTURE` envelopes because that event type is already
OBS-01-compatible and carries source timestamps. The payload includes:

- `feature_snapshot_id`;
- `exchange_event_ts_ns`;
- `sidecar_recv_ts_ns`;
- optional `rithmic_publish_ts_ns`;
- `l3_authority: "unavailable"`;
- scalar `values` containing accepted price-state fields such as `bid_px_00` and
  `ask_px_00`;
- `bids[]` and `asks[]` arrays with `px`, `size_diagnostic`, and
  `order_count_diagnostic`.

Only price fields are accepted as the sub-scope. Size and order-count fields are explicitly
named diagnostic to prevent accidental hard-gate use.

## Report Status

The conversion report must include:

- `mbp10_price_state_status = accepted_subscope`;
- `mbo_status = accepted_subscope`;
- `size_order_count_status = diagnostic_only`;
- `data01b_full_status = blocked`.

MBO rows are skipped by this MBP10 price-state-only path with:

```text
mbo_accepted_subscope_not_consumed_by_price_state_path
```

That reason points to INFRA-01F: MBO has an accepted provider-internal sub-scope, but this
publisher is not the MBO consumer.

## Gate Impact

DATA-01B-PS is useful launch-progress plumbing, not a full data gate pass. It enables
downstream code to consume MBP10 price-state snapshots while preserving the policy
boundary:

- price-state features can be built against this sub-scope;
- size/order-count features must remain diagnostic or blocked;
- MBO/queue features require their own consumer and authority implementation;
- full DATA-01B and DATA-01 stay blocked until the MBO consumer, DATA-03/DATA-04, SIM
  calibration, and provider-internal replay evidence are implemented and verified.
