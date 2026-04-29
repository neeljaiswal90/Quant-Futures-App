# REL-01 Controlled Live-Sim Runbook

This runbook describes the operator procedure for building the 10-session REL-01 controlled live-sim evidence packet.

REL-01 uses live Rithmic market data and simulated execution only. It does not place real orders, does not enable real-money execution, and does not promote MBO-derived decision features.

## Current Gate Posture

Required before starting or continuing the 10-session sequence:

- `REL-00A` offline readiness passes.
- `REL-00B` evidence index reports `ready_for_rel00_candidate`.
- `SIM-03D` passes with `ready_for_rel01_execution_simulation = true`.
- `REL-00C` can generate controlled live-sim runtime journals.
- `REL-00` validates each generated runtime journal.
- Full DATA-01B / MBO-derived decision features remain restricted unless later policy explicitly promotes them.

## Daily Preflight

Run from clean `main` or the accepted release branch:

```powershell
cd C:\Quant-futures-app
git checkout main
git pull origin main

npm run rel:00a
npm run rel:00b:evidence-index
```

Confirm:

- `REL-00A offline readiness: PASS`
- `REL-00B evidence index: ready_for_rel00_candidate`
- `reports/` remains untracked and is not committed.

Confirm Rithmic configuration is available through environment variables or command flags:

```powershell
$env:RITHMIC_CONNECT_POINT
$env:RITHMIC_SYSTEM_NAME
$env:RITHMIC_USER
```

If the capture script cannot infer credentials or connection details, pass `--connect-point`, `--system-name`, `--user`, and `--password` explicitly.

## Choose A Trading Date

Use one distinct RTH trading date per accepted REL-01 session.

Avoid:

- weekends;
- exchange holidays;
- early-close sessions;
- known Rithmic/provider outages;
- sessions with missing `LAST_TRADE`, `L1_QUOTE`, or `MBP10`;
- sessions whose REL-00 validation fails.

Session IDs must use this shape:

```text
YYYY-MM-DD-rth
```

Example setup:

```powershell
$tradeDate = "2026-04-30"
$sessionId = "$tradeDate-rth"
$runStamp = $tradeDate.Replace("-", "")
$runId = "rel01-live-sim-$runStamp"
$runDir = "C:\Quant-futures-app\reports\rel\rel01_$runStamp"

New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$rawProbe = "$runDir\rithmic_probe.jsonl"
```

## Step 1: Capture Rithmic Probe

```powershell
python scripts\infra\capture-rithmic-probe.py `
  --symbol MNQM6 `
  --exchange CME `
  --duration-sec 2100 `
  --streams LAST_TRADE,L1_QUOTE,MBP10 `
  --parity-payload `
  --out $rawProbe
```

The capture is usable only if the completion summary shows:

- `error_count = 0`
- `records_by_stream.LAST_TRADE > 0`
- `records_by_stream.L1_QUOTE > 0`
- `records_by_stream.MBP10 > 0`
- `unknown_template_ids = {}`

Discard the session if a required stream is zero or if unknown template IDs appear.

## Step 2: Normalize DATA-01A

```powershell
npm run data:01a:l1-trade -- `
  --input "$rawProbe" `
  --out "$runDir\data01a_l1_trade.obs01.jsonl" `
  --report "$runDir\data01a_l1_trade_report.json" `
  --run-id "$runId" `
  --session-id "$sessionId"
```

Expected posture:

- L1/trade sub-scope passes.
- Full DATA-01 remains blocked if L2/L3 policy is not complete.
- MBP10 rows are skipped by DATA-01A, not promoted.

## Step 3: Normalize DATA-01B-PS MBP10 Price-State

```powershell
npm run data:01b:price-state -- `
  --input "$rawProbe" `
  --out "$runDir\data01b_ps_mbp10_price_state.obs01.jsonl" `
  --report "$runDir\data01b_ps_mbp10_price_state_report.json" `
  --run-id "$runId" `
  --session-id "$sessionId"
```

Expected posture:

- MBP10 price-state sub-scope is accepted.
- Full DATA-01B remains blocked.
- Size/order-count remains diagnostic-only.
- MBO-derived fields are not decision inputs.

## Step 4: Generate Controlled Live-Sim Runtime Journal

```powershell
npm run rel:00c:run-controlled-live-sim -- `
  --l1-trade-journal "$runDir\data01a_l1_trade.obs01.jsonl" `
  --mbp10-price-state-journal "$runDir\data01b_ps_mbp10_price_state.obs01.jsonl" `
  --out-journal "$runDir\rel00_controlled_live_sim_journal.jsonl" `
  --report "$runDir\rel00c_controlled_live_sim_generation_report.json" `
  --run-id "$runId" `
  --session-id "$sessionId"
```

Expected posture:

- `status = generated`
- `execution_adapter = simulated`
- `real_order_event_types_emitted = 0`
- `blocked_feature_fields_used = []`
- `restricted_feature_fields_used = []`

Discard or investigate the session if REL-00C emits any real-order event type or uses blocked/restricted fields.

## Step 5: Validate The Session With REL-00

```powershell
npm run rel:00:controlled-live-sim -- `
  --journal "$runDir\rel00_controlled_live_sim_journal.jsonl" `
  --out "$runDir\rel00_controlled_live_sim_report.json" `
  --out-md "$runDir\rel00_controlled_live_sim_report.md" `
  --min-source-events 10000
```

Required result:

```text
REL-00 controlled live-sim readiness: pass
```

The session is not admissible for REL-01 unless REL-00 passes.

## Step 6: Append The REL-01 Manifest

Create or update:

```text
reports/rel/rel01_manifest.json
```

Manifest skeleton:

```json
{
  "schema_version": 1,
  "rel01_run_id": "rel01-20260429-to-20260512",
  "runtime_commit": "<runtime-commit>",
  "config_hash": "<runtime-config-hash>",
  "strategy_config_hash": "<strategy-config-hash>",
  "risk_config_hash": "<risk-config-hash>",
  "management_config_hash": "<management-config-hash>",
  "sim03_report": "reports/sim/fill_slippage_calibration_robust_limit_queue_front.json",
  "sim03_gate": "reports/sim/fill_slippage_calibration_robust_limit_queue_front_gate.json",
  "rel00b_report": "reports/rel/rel00b_evidence_index.json",
  "sessions": []
}
```

Append one object per accepted REL-00 passing session:

```json
{
  "session_id": "2026-04-30-rth",
  "run_id": "rel01-live-sim-20260430",
  "journal": "reports/rel/rel01_20260430/rel00_controlled_live_sim_journal.jsonl",
  "rel00_report": "reports/rel/rel01_20260430/rel00_controlled_live_sim_report.json",
  "rel00c_report": "reports/rel/rel01_20260430/rel00c_controlled_live_sim_generation_report.json"
}
```

Do not append failed sessions. Do not reuse a trading date. Do not edit an old session entry to point at different bytes without regenerating its REL-00 report.

## Step 7: Run REL-01A Aggregate Validation

Run REL-01A after every accepted session so failures are caught before day 10:

```powershell
npm run rel:01a:aggregate -- `
  --manifest reports/rel/rel01_manifest.json `
  --out-json reports/rel/rel01_aggregate_report.json `
  --out-md reports/rel/rel01_aggregate_report.md `
  --required-sessions 10 `
  --min-source-events 10000
```

Expected states:

- After fewer than 10 valid sessions: `status = incomplete`
- After any unsafe or failed session: `status = fail`
- After 10 valid sessions: `status = pass`

## When To Discard A Session

Discard or quarantine the session if any of these occur:

- capture has nonzero `error_count`;
- any required stream has zero records;
- unknown template IDs are present;
- DATA-01A normalization fails;
- DATA-01B-PS normalization fails;
- REL-00C fails or emits real-order event types;
- REL-00 fails;
- blocked, diagnostic-only, or MBO/subscope fields appear in runtime decision payloads;
- journal contains malformed JSONL;
- journal has unterminated `ORDER_INTENT` events;
- REL-01A reports stale REL-00 or REL-00C hash binding.

## Failure Handling

If capture fails:

- keep the failed run directory for local diagnosis if useful;
- do not add it to `rel01_manifest.json`;
- rerun on a later distinct RTH trading date.

If normalization fails:

- inspect the normalization report;
- do not manually patch normalized journals;
- rerun from the raw probe only if the raw probe is valid.

If REL-00C fails:

- do not edit the runtime journal by hand;
- inspect `rel00c_controlled_live_sim_generation_report.json`;
- verify blocked/restricted field lists and simulated adapter posture.

If REL-00 fails:

- inspect `rel00_controlled_live_sim_report.md`;
- fix the source issue or discard the session;
- do not include the failed session in REL-01A.

If REL-01A fails:

- inspect `reports/rel/rel01_aggregate_report.md`;
- identify the failed session IDs;
- regenerate affected REL-00 evidence or remove the session from the manifest.

## Preserve Evidence

Keep the following under the session run directory:

```text
reports/rel/rel01_YYYYMMDD/
  rithmic_probe.jsonl
  data01a_l1_trade.obs01.jsonl
  data01a_l1_trade_report.json
  data01b_ps_mbp10_price_state.obs01.jsonl
  data01b_ps_mbp10_price_state_report.json
  rel00_controlled_live_sim_journal.jsonl
  rel00c_controlled_live_sim_generation_report.json
  rel00_controlled_live_sim_report.json
  rel00_controlled_live_sim_report.md
```

These are operational evidence artifacts. They should remain local or in the approved evidence store.

## What Not To Commit

Do not commit:

- raw Rithmic probe JSONL files;
- normalized OBS-01 JSONL files;
- runtime journal JSONL files;
- generated reports under `reports/`;
- DBN files;
- credentials or connection config;
- ad hoc patched evidence.

Safe to commit:

- source code;
- tests;
- docs;
- deterministic schemas and validators.

## MBO And Shadow Telemetry

REL-01 does not enable MBO-derived decision features by default.

Before collecting MBO shadow telemetry in REL-01 sessions, add and pass a dedicated validator that proves:

- MBO telemetry appears only in diagnostic/shadow payloads;
- shadow features carry `decision_use = false`;
- MBO does not appear in candidate, ranking, risk, sizing, order, fill, or queue-position decision inputs.

Until that validator exists and passes, keep REL-01 sessions on the accepted L1/trade plus MBP10 price-state surface.
