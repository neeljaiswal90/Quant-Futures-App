# REL-01B - Daily Controlled Live-Sim Session Wrapper

REL-01B automates the daily REL-01 session procedure from the runbook. It is an operator wrapper only: it does not connect to any trading/order-entry path, does not change strategy/risk/simulation behavior, and does not promote MBO-derived or blocked feature fields.

The wrapper runs the same commands an operator would run by hand:

1. Capture a Rithmic probe.
2. Normalize DATA-01A L1/trade observations.
3. Normalize DATA-01B-PS MBP10 price-state observations.
4. Generate the controlled live-sim runtime journal with REL-00C.
5. Validate the runtime journal with REL-00.
6. Append the session to the REL-01 manifest only if REL-00 passes.

## Safety Boundary

REL-01B preserves the current release posture:

- Live data source: Rithmic capture.
- Execution mode: simulated only.
- Real orders: forbidden.
- Accepted feature surface: enforced by REL-00C and REL-00.
- MBO-derived decision fields: still blocked unless a later policy explicitly promotes them.
- Full DATA-01B: still restricted.

REL-01B reports command names, paths, hashes, counts, and statuses only. It does not embed raw Rithmic rows, normalized journal rows, runtime payload values, DBN files, credentials, stdout, or stderr.

## Manifest Requirement

By default REL-01B expects `reports/rel/rel01_manifest.json` to already exist. This prevents the wrapper from inventing runtime/config/SIM-03 lineage.

If the manifest does not exist, provide the seed fields explicitly:

```powershell
npm run rel:01b:daily-session -- `
  --trade-date 2026-04-30 `
  --rel01-run-id rel01-20260429-to-20260512 `
  --runtime-commit <commit> `
  --config-hash <hash> `
  --strategy-config-hash <hash> `
  --risk-config-hash <hash> `
  --management-config-hash <hash>
```

The wrapper refuses duplicate `session_id` or `run_id` before running capture, so a repeated command cannot silently recapture and mutate a previously accepted session.

## Daily Command

Run from the accepted release branch:

```powershell
cd C:\Quant-futures-app

npm run rel:01b:daily-session -- `
  --trade-date 2026-04-30 `
  --manifest reports/rel/rel01_manifest.json `
  --min-source-events 10000
```

Default derived values:

- `session_id = YYYY-MM-DD-rth`
- `run_id = rel01-live-sim-YYYYMMDD`
- `run_dir = reports/rel/rel01_YYYYMMDD`
- `symbol = MNQM6`
- `exchange = CME`
- `duration_sec = 2100`
- `streams = LAST_TRADE,L1_QUOTE,MBP10`

The wrapper writes:

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
  rel01b_daily_session_report.json
```

## Existing Capture Mode

If a Rithmic probe already exists, REL-01B can skip capture and continue the normalization/generation/validation chain:

```powershell
npm run rel:01b:daily-session -- `
  --trade-date 2026-04-30 `
  --raw-probe reports/rel/rel01_20260430/rithmic_probe.jsonl `
  --skip-capture
```

The raw probe must exist and be non-empty. The wrapper still hashes it in the report.

Before any normalization step, REL-01B also audits timestamped raw-probe rows. Every checked `exchange_event_ts_ns` must match the requested `--trade-date` and fall inside the CME equity-index RTH UTC window (`13:30 <= time < 20:00`). This prevents accidentally reusing a prior day's capture or an ETH/non-RTH probe under an `*-rth` session id.

## Success Criteria

REL-01B appends the manifest only if all of these hold:

- Capture command succeeds and `rithmic_probe.jsonl` exists.
- Raw-probe exchange timestamps match the requested RTH trade date.
- DATA-01A emits quote and trade events.
- DATA-01B-PS emits MBP10 price-state events with `mbp10_price_state_status = accepted_subscope`.
- REL-00C reports `status = generated`.
- REL-00C emits zero real-order event types.
- REL-00C uses no blocked or restricted fields.
- REL-00 reports `status = pass`.

After success, run REL-01A:

```powershell
npm run rel:01a:aggregate -- `
  --manifest reports/rel/rel01_manifest.json `
  --out-json reports/rel/rel01_aggregate_report.json `
  --out-md reports/rel/rel01_aggregate_report.md `
  --required-sessions 10 `
  --min-source-events 10000
```

Expected aggregate state before day 10 is `incomplete`, not `fail`.

## Failure Handling

If REL-01B returns `failed`, do not append the session manually unless a reviewer has inspected the failed evidence. The wrapper intentionally leaves failed artifacts in the run directory for local diagnosis, but the manifest remains unchanged.

Manifest updates are written with a temporary file and replace step, so a successful append leaves no `rel01_manifest.json.tmp` behind.

If REL-01B returns `duplicate_session`, use a new distinct RTH trading date or perform an explicit manual manifest repair. Do not overwrite a prior accepted session entry by rerunning the wrapper.

If REL-01B returns `requires_manifest_seed`, create `reports/rel/rel01_manifest.json` from the runbook skeleton or rerun with all manifest seed fields.

## What Not To Commit

Do not commit:

- `reports/rel/rel01_*/rithmic_probe.jsonl`
- normalized source journals
- runtime journals
- REL reports under `reports/`
- credentials or local environment files

Only commit code, docs, and tests.
