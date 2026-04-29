# SIM-03I Targeted Limit Queue Front Observation Export

SIM-03I produces the missing `limit_queue:front` observation JSONL consumed by SIM-03H. It is an evidence producer only: it does not change thresholds, patch SIM-03 reports, tune passing buckets, or unblock REL-01.

## Why This Exists

The full SIM-03 calibration failed only `limit_queue:front` time-to-fill. SIM-03G rejected aggregate-only patching and SIM-03H can refit only when it receives real observation rows bound to the source calibration report hash. SIM-03I fills that gap.

## Source Discipline

SIM-03I prefers the SIM-03 source manifest referenced by `fill_slippage_calibration.json.inputs.manifest_path`. From that manifest it reads only `mbo` files for sessions whose split matches `--split`.

Supported source formats are decoded `.jsonl` and `.json` MBO rows with the same fields used by SIM-03:

```json
{ "ts_event": 1000000000, "order_id": 1, "price": 100000000000, "size": 1, "action": "A", "side": "B" }
```

If the source files are DBN/ZST and no decoded JSONL source is present, SIM-03I emits `requires_decoded_observation_source` instead of faking observations. The preferred follow-up is a targeted DBN decode/export path, not a full calibration rerun.

## Observation Schema

Each output JSONL row is accepted by SIM-03H's shared validator:

```json
{
  "schema_version": 1,
  "bucket": "limit_queue:front",
  "split": "calibration",
  "instrument": "MNQM6",
  "session_id": "2026-04-27-rth",
  "event_ts_ns": "1777296600000000000",
  "order_side": "bid",
  "queue_bucket": "front",
  "observed_time_to_fill_ms": 3900,
  "modeled_time_to_fill_ms": null,
  "fill_outcome": "filled",
  "no_fill_or_cancel_outcome": null,
  "queue_position_features": {
    "queue_bucket": "front",
    "queue_ahead_size": 0,
    "queue_ahead_order_count": 0
  },
  "source_report_hash": "<sha256 of fill_slippage_calibration.json>",
  "source_session_or_file": "2026-04-27-rth:<mbo path>",
  "observation_id": "<deterministic sha256>"
}
```

`observation_id` is deterministic from stable row fields. No wall-clock or random data is used.

## Run

```powershell
npm run sim:03i:export-front-observations -- `
  --calibration-report reports/sim/fill_slippage_calibration.json `
  --diagnosis-report reports/sim/limit_queue_front_diagnosis.json `
  --corpus-root A:\Quant-futures-app-data\databento\sim03_corpus `
  --out reports/sim/limit_queue_front_observations.jsonl `
  --manifest-out reports/sim/limit_queue_front_observations_manifest.json
```

Optional controls:

```powershell
--split calibration|validation|both
--max-records 100000
--generated-at-ts-ns 1777399200000000000
--progress-log reports/sim/limit_queue_front_observations_progress.jsonl
```

## Feed SIM-03H

After `status: "exported"`:

```powershell
npm run sim:03h:refit-front -- `
  --calibration-report reports/sim/fill_slippage_calibration.json `
  --diagnosis-report reports/sim/limit_queue_front_diagnosis.json `
  --observations reports/sim/limit_queue_front_observations.jsonl `
  --out reports/sim/fill_slippage_calibration_refit_limit_queue_front.json `
  --patch-report reports/sim/limit_queue_front_refit_report.json `
  --checked-at-ts-ns 1777399200000000000
```

REL-01 remains blocked unless SIM-03D passes on the refit report.
