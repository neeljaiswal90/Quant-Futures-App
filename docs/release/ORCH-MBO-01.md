# ORCH-MBO-01 — MBO Shadow Telemetry Producer

ORCH-MBO-01 is an offline, read-only producer for MBO shadow telemetry. It takes an already generated controlled live-sim runtime journal and an already captured normalized MBO source journal, then emits a new runtime journal with additional `FEATURES.shadow_values` events.

It does not connect to Rithmic, place orders, mutate strategy logic, or make MBO decision-grade. The generated shadow events are for diagnostics and lineage validation only.

## Safety Contract

- Existing runtime events are copied unchanged.
- Shadow telemetry is emitted only in `shadow_values`.
- `values` is always empty on ORCH-MBO-01 events.
- `decision_use` is always `false`.
- No real broker/order-plant/live-order event types are emitted.
- Unsupported shadow fields are not emitted.
- Raw market-data payload values are not embedded in the generation report.

Supported fields in this ticket:

- `cancel_add_ratio_shadow`
- `mbo_action_imbalance_shadow`
- `order_lifetime_shadow`

Intentionally not emitted until derivation contracts are accepted:

- `absorption_score_shadow`
- `sweep_score_shadow`

## Command

```powershell
npm run orch:mbo:01:shadow-producer -- `
  --runtime-journal "$runDir\rel00_controlled_live_sim_journal.jsonl" `
  --mbo-source-journal "$runDir\data01b_mbo_order_lifecycle.obs01.jsonl" `
  --out-journal "$runDir\rel00_controlled_live_sim_shadow_journal.jsonl" `
  --report "$runDir\orch_mbo_01_shadow_producer_report.json" `
  --run-id "$runId" `
  --session-id "$sessionId"
```

Optional bounds for local smoke tests:

```powershell
  --window-event-count 100 `
  --emit-every 100 `
  --max-shadow-events 10
```

For operational evidence, omit `--max-shadow-events` unless intentionally producing a bounded diagnostic sample.

## Required Follow-Up Validators

Run the generated journal through the existing gates:

```powershell
npm run rel:00:controlled-live-sim -- `
  --journal "$runDir\rel00_controlled_live_sim_shadow_journal.jsonl" `
  --out "$runDir\rel00_shadow_precheck_report.json" `
  --out-md "$runDir\rel00_shadow_precheck_report.md" `
  --min-source-events 10000
```

Then include the generated journal plus `mbo_source_journal` and `mbo_source_journal_sha256` in a REL-01 manifest and run:

```powershell
npm run rel:01d:feature-surface-audit -- `
  --manifest "$runDir\rel01_shadow_manifest.json" `
  --out-json "$runDir\rel01d_shadow_feature_surface_report.json" `
  --out-md "$runDir\rel01d_shadow_feature_surface_report.md"

npm run rel:01e:mbo-shadow-lineage -- `
  --manifest "$runDir\rel01_shadow_manifest.json" `
  --out-json "$runDir\rel01e_mbo_shadow_lineage_report.json" `
  --out-md "$runDir\rel01e_mbo_shadow_lineage_report.md"
```

Expected validator posture:

- REL-00 passes because shadow data is non-decision-use and no blocked fields are emitted.
- REL-01D reports shadow field frequency by session and mask v4 binding.
- REL-01E passes only when every shadow field is hash-bound, causal, in-window, and recomputable from source MBO events.

## Manifest Patch

The ORCH-MBO-01 report includes a `manifest_session_patch` object with:

- `journal`
- `mbo_source_journal`
- `mbo_source_journal_sha256`

This is an operator convenience only. Review the generated paths before appending them to a REL-01 manifest.

## Not A Decision Unlock

ORCH-MBO-01 does not enable MBO for candidate gates, ranking, risk, sizing, queue-position fill logic, or ML feature generation. DATA-01B/MBO decision use remains blocked unless later policy explicitly promotes specific fields through a separate evidence review.
