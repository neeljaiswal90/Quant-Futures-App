# DATA-01B-MBO: Provider-Internal MBO Lifecycle Ingestion

DATA-01B-MBO implements the MBO provider-internal sub-scope accepted by ADR-0002 and
INFRA-01F. It normalizes Rithmic rich `MBO` rows into OBS-01-compatible lifecycle
events. It does not complete full DATA-01B and does not enable MBO-derived features by
itself.

## Scope

Accepted:

- Rich Rithmic `MBO` rows from captured probes or sidecar records.
- Provider-internal order lifecycle actions: `add`, `modify`, and `cancel`.
- Provider-internal `order_id`, `sequence`, side, price, and size fields for lifecycle
  reconstruction.
- `exchange_event_ts_ns` as canonical event time.
- `sidecar_recv_ts_ns` as receive-time telemetry only.
- OBS-01-compatible `MICROSTRUCTURE` journal envelopes for source-like lifecycle facts.

Deferred:

- MBO-derived feature snapshots.
- Queue-position features.
- L2/L3 authority FSM.
- Cross-feed order-by-order replay equivalence.

Still blocked globally:

- Full DATA-01B.
- Full DATA-01.
- SIM-02/SIM-03, ML/research dataset generation, and REL gates.

## Command

```powershell
npm run data:01b:mbo -- `
  --input data/probes/infra01/full/probe-parity-post04d.jsonl `
  --out data/journals/data01b-mbo/mbo-order-lifecycle.jsonl `
  --report reports/data/data01b_mbo_report.json `
  --run-id data01b-mbo-post04d `
  --session-id 2026-04-27-rth
```

Do not commit generated journals or reports.

## Event Shape

The publisher emits `MICROSTRUCTURE` envelopes because this MBO ingestion layer is still
source market data. It is a root event for future derived features, so it does not invent
a `causation_id`. Downstream DATA-02-MBO and DATA-04 outputs must use these lifecycle
event IDs as their causation source.

Each payload includes:

- `feature_snapshot_id`;
- `exchange_event_ts_ns`;
- `sidecar_recv_ts_ns`;
- optional `rithmic_publish_ts_ns`;
- optional provider `sequence`;
- `l3_authority: "unavailable"`;
- `source: "mbo_order_lifecycle"`;
- `microstructure_kind: "mbo_order_lifecycle"`;
- normalized `action`, `side`, `price`, `size`, and `order_id`;
- scalar `values` with the same accepted lifecycle fields;
- status fields for the accepted MBO sub-scope and blocked full DATA-01B gate.

## Report Status

The conversion report must include:

- `mbo_status = accepted_subscope`;
- `mbo_lifecycle_status = accepted_subscope`;
- `mbo_feature_status = deferred_to_data02_mbo`;
- `data01b_full_status = blocked`.

Rows outside the MBO lifecycle path are diagnosed rather than silently skipped. `MBP10`
rows remain the responsibility of DATA-01B-PS and are skipped with
`mbp10_not_consumed_by_mbo_path`.

## Gate Impact

DATA-01B-MBO is the first consumer of the INFRA-01F MBO policy extension. It makes
provider-internal order lifecycle facts available to later sidecar layers, but it does
not authorize queue-aware trading or full L2/L3 features.

The next layers remain explicit:

- DATA-02-MBO builds provider-internal MBO book state.
- DATA-03 defines authority transitions and fail-closed behavior.
- DATA-04 derives MBO microstructure features.
- SIM-02/SIM-03 calibrate queue-aware fill behavior before REL gates can advance.
