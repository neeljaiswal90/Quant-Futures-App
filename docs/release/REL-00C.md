# REL-00C - Controlled Live-Sim Runtime Journal Generator

REL-00C is the bridge between a successful live Rithmic market-data capture and the REL-00 controlled live-sim validator. It consumes already-normalized source journals, runs the strategy runtime with the simulated execution adapter, and emits the runtime journal that REL-00 validates.

REL-00C does not connect to Rithmic, does not place orders, and does not mark REL-00 or REL-01 complete.

## Scope

Inputs:

- `data01a_l1_trade.obs01.jsonl`
- `data01b_ps_mbp10_price_state.obs01.jsonl`

Outputs:

- `rel00_controlled_live_sim_journal.jsonl`
- `rel00c_controlled_live_sim_generation_report.json`

The generated runtime journal contains runtime events such as `QUOTE`, `TRADE`, `FEATURES`, `STRAT_EVAL`, `ORDER_INTENT`, `SIM_FILL`, and `EXEC_REJECT`. It must not contain broker/order-plant/live-order event types.

## Safety Boundary

REL-00C publishes only `QUOTE` and `TRADE` source events into the runtime journal. The MBP10 price-state journal is still scanned and hash-bound as source evidence, but REL-00C does not copy raw MBP10 `MICROSTRUCTURE` payloads into the runtime journal because those payloads can include diagnostic/subscope fields that are not accepted runtime decision inputs.

Runtime `FEATURES.values` are restricted to accepted L1/trade fields plus strategy-internal indicators derived from the accepted stream. The REL-00 validator treats unknown strategy fields as internal indicators and still rejects any blocked, diagnostic-only, or MBO/subscope feature fields.

## Run

```powershell
$runDir = "C:\Quant-futures-app\reports\rel\rel00_live_sim_20260429_085202"

npm run rel:00c:run-controlled-live-sim -- `
  --l1-trade-journal "$runDir\data01a_l1_trade.obs01.jsonl" `
  --mbp10-price-state-journal "$runDir\data01b_ps_mbp10_price_state.obs01.jsonl" `
  --out-journal "$runDir\rel00_controlled_live_sim_journal.jsonl" `
  --report "$runDir\rel00c_controlled_live_sim_generation_report.json" `
  --run-id "rel00-live-sim-20260429_085202" `
  --session-id "2026-04-29-rth"
```

Use `--max-feature-snapshots <n>` for bounded smoke runs. Omit it for the full controlled live-sim generation.

## Validate

```powershell
npm run rel:00:controlled-live-sim -- `
  --journal "$runDir\rel00_controlled_live_sim_journal.jsonl" `
  --out "$runDir\rel00_controlled_live_sim_report.json" `
  --out-md "$runDir\rel00_controlled_live_sim_report.md" `
  --min-source-events 10000
```

REL-00 passes only when the validator reports:

- `status = pass`
- real-order event count is zero
- execution remains simulated-only
- blocked/restricted runtime feature usage is zero
- traceability checks pass

## Release Posture

REL-00C can produce an admissible runtime journal, but REL-01 remains pending until a passing REL-00 report exists and the formal 10-session controlled live-sim run is completed.

Generated journals and reports under `reports/` are operational evidence. Do not commit raw probe files, normalized large JSONL files, runtime journals, or generated reports.
