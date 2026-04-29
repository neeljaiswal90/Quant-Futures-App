# REL-00 Controlled Live-Sim Readiness

REL-00 is the first controlled live-data readiness gate after the SIM-03 execution-simulation calibration gate has cleared. It is intentionally narrow: live Rithmic market data may be observed, but execution must remain simulated and no real order path may be active.

## Scope

- Uses an operator-supplied runtime journal from a controlled live-sim run.
- Validates OBS/EVT ingestion, canonical source timestamps, simulated execution safety, traceability, and feature-surface restrictions.
- Emits deterministic JSON and Markdown evidence under `reports/rel/`.
- Does not connect to a broker, send orders, mutate strategy decisions, or mark REL-01 complete.
- Does not embed raw market-data rows, journal payload values, DBN files, or generated large artifacts.

## Run

```powershell
npm run rel:00:controlled-live-sim -- `
  --journal C:\Quant-futures-app\reports\rel\controlled_live_sim_journal.jsonl `
  --out C:\Quant-futures-app\reports\rel\rel00_controlled_live_sim_readiness_report.json `
  --out-md C:\Quant-futures-app\reports\rel\rel00_controlled_live_sim_readiness_report.md
```

The command exits `0` only when all checks pass. It exits `2` for a clean readiness failure and `3` for invalid input/configuration.

For an operational run, pass a meaningful source-event floor:

```powershell
--min-source-events 10000
```

The default is intentionally small for smoke tests and unit fixtures. REL-01 is where the 10-session duration/completeness requirement is enforced; REL-00 validates that a supplied run journal is admissible, not that enough sessions have completed.

## Checks

REL-00 verifies:

- The journal exists, is non-empty, parses as JSONL, and ingests through the runtime journal transport without quarantine.
- Source market-data events are present and use canonical `exchange_event_ts_ns`.
- Real order event types such as `ORDER_PLANT`, `BROKER_ORDER`, or live execution reports are absent.
- `EXEC_REJECT` events use the simulated adapter, and `SIM_FILL` events do not use a blocked input tier.
- Runtime feature values do not use known blocked, diagnostic-only, or provider-internal MBO/queue fields as trading features.
- Every `ORDER_INTENT` has a simulated terminal event (`SIM_FILL` or `EXEC_REJECT`) when orders are present.

The real-order check is intentionally two-layered. The runtime journal transport rejects event types outside the typed `RuntimeEventType` allow-list, while REL-00 also scans the raw JSONL for known real-order/broker event names before transport ingestion. If future real-order event types are added to the runtime taxonomy, the REL-00 deny-list must be updated in the same PR.

## Feature Boundary

SIM-03L cleared the execution-simulation calibration gate, but it did not clear full DATA-01B or MBO-derived trading features. REL-00 therefore treats only authoritative accepted fields as live-sim runtime features. Known blocked fields such as `queue_position`, `mbo_derived_features`, `absorption`, and `sweep` fail the gate. Provider-internal MBO/queue fields remain off unless a later policy explicitly accepts them for REL use.

Unknown fields in `FEATURES.values` are treated as strategy-internal indicators and are summarized by key only. Their raw values are not embedded in the report.

REL-00 currently inspects `FEATURES.values` and `MICROSTRUCTURE.values`. Feature-like decision metadata in other event payloads is outside this validator's scope and should not be used to justify REL-01 readiness unless a later gate explicitly indexes it.

## Working Directory

The validator copies the supplied journal into an exclusive transport-validation directory before using the runtime ingestor. By default this is:

```text
reports/rel/rel00_controlled_live_sim_transport
```

Use `--validation-dir` only for a scratch directory owned by this command. The script refuses to clear a directory whose resolved path does not include `rel00`, but operators should still budget temporary disk space for one additional copy of the journal during validation.

## Outputs

Default outputs:

```text
reports/rel/rel00_controlled_live_sim_readiness_report.json
reports/rel/rel00_controlled_live_sim_readiness_report.md
```

The report includes path, SHA-256, size, counts, check statuses, and small scalar summaries only. It is an evidence index for a controlled run, not the raw run itself.

## Release Boundary

Passing REL-00 means the project is ready to proceed toward controlled REL-01 live-sim validation. It does not mean:

- REL-01's 10-session run is complete.
- Full DATA-01B/MBO-derived features are accepted.
- Real-money execution is allowed.
- Final release traceability spot-checks are complete.
