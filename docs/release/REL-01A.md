# REL-01A - 10-Session Controlled Live-Sim Aggregate Validator

REL-01A validates the aggregate controlled live-sim evidence packet after REL-00C can generate runtime journals and REL-00 can validate each journal.

REL-01A is intentionally read-only. It does not connect to Rithmic, does not place orders, does not change strategy/risk/simulation/management behavior, does not enable MBO-derived decision fields, and does not mark real-money execution in scope.

## Scope

Inputs:

- `reports/rel/rel01_manifest.json`
- One controlled live-sim runtime journal per session
- One prior passing REL-00 report per session
- One REL-00C generation report per session
- A SIM-03 calibration report and SIM-03D gate report

Outputs:

- `reports/rel/rel01_aggregate_report.json`
- `reports/rel/rel01_aggregate_report.md`

The report contains paths, SHA-256 hashes, counts, statuses, field names, and event identifiers only. It does not embed raw market-data rows, feature payload values, order payload values, DBN files, or runtime journal payloads.

## Manifest

Example with the first accepted REL-01 session:

```json
{
  "schema_version": 1,
  "rel01_run_id": "rel01-20260429-to-20260512",
  "runtime_commit": "4dcffdb",
  "config_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "strategy_config_hash": "<strategy-config-hash>",
  "risk_config_hash": "<risk-config-hash>",
  "management_config_hash": "<management-config-hash>",
  "sim03_report": "reports/sim/fill_slippage_calibration_robust_limit_queue_front.json",
  "sim03_gate": "reports/sim/fill_slippage_calibration_robust_limit_queue_front_gate.json",
  "sessions": [
    {
      "session_id": "2026-04-29-rth",
      "run_id": "rel01-live-sim-20260429",
      "journal": "reports/rel/rel01_20260429/rel00_controlled_live_sim_journal.jsonl",
      "rel00_report": "reports/rel/rel01_20260429/rel00_controlled_live_sim_report.json",
      "rel00c_report": "reports/rel/rel01_20260429/rel00c_controlled_live_sim_generation_report.json"
    }
  ]
}
```

Append one session object after every distinct passing RTH session. Do not include failed REL-00 sessions in the final packet.

## Validate During Collection

REL-01A can run after session 1, after session 2, and so on. Fewer than the required sessions returns `status = incomplete`, not `fail`, as long as all supplied sessions are valid.

```powershell
npm run rel:01a:aggregate -- `
  --manifest reports/rel/rel01_manifest.json `
  --out-json reports/rel/rel01_aggregate_report.json `
  --out-md reports/rel/rel01_aggregate_report.md `
  --required-sessions 10 `
  --min-source-events 10000
```

Exit code meanings:

- `0`: aggregate packet passed.
- `2`: aggregate packet is incomplete or failed a clean gate.
- `3`: manifest/input was invalid enough that the validator could not evaluate the packet normally.

## Required Checks

Manifest checks:

- `schema_version = 1`
- no duplicate `session_id`
- no duplicate `run_id`
- every session is an RTH session
- every referenced journal/report exists
- manifest runtime/config hashes are present
- journal app-level `config_hash` values are reported for forensic review
- journal `strategy_config_hash` values match the manifest
- journal `risk_config_hash` values match the manifest
- journal `management_config_hash` values match the manifest when runtime journals emit them
- journal `management_profile_hash` values are reported when present

The app-level `config_hash` can include environment path inputs such as the journal output directory. REL-01A therefore reports it, but packet comparability gates on the stable behavioral hashes for strategy, risk, and management lineage.

Per-session checks:

- prior REL-00 report is `pass`
- prior REL-00 report hash-binds to the current journal bytes
- REL-00C report is `generated` or `pass`
- REL-00C report hash-binds to the current journal bytes
- current REL-00 re-run passes
- source event count meets the configured minimum

Safety checks:

- simulated execution only
- real-order event types absent
- no blocked feature fields
- no diagnostic-only or MBO/subscope feature fields
- accepted feature surface only

Journal checks:

- no malformed JSONL lines
- transport ingestability
- OBS/EVT timestamp and causation invariants through REL-00
- every `ORDER_INTENT` has a `SIM_FILL` or `EXEC_REJECT`
- every simulated terminal references a known intent through REL-00 traceability
- position events are counted for aggregate review

## TUI-04 Spot Checks

REL-01A runs deterministic `journal-query` spot checks over terminal simulated execution events when present, then order intents, then source events. The report stores event IDs and pass/fail status only.

## Completion Logic

- Fewer than `--required-sessions` valid sessions: `status = incomplete`
- Any unsafe or failed session: `status = fail`
- Required session count reached and all checks pass: `status = pass`

## MBO Boundary

REL-01A inherits the REL-00 feature boundary. SIM-03L cleared execution-simulation calibration, but it did not promote full DATA-01B or MBO-derived trading features. Provider-internal MBO/subscope fields remain blocked for runtime decisions unless a later policy explicitly promotes specific fields and updates REL-00/REL-01 gates.

## Pass Meaning

`status = pass` means the 10-session controlled live-sim evidence packet is internally coherent and all supplied journals pass the current REL-00 validator. It does not mean:

- real-money execution is allowed;
- full DATA-01B/MBO-derived features are accepted;
- final release traceability review is complete.
