# SIM-03H Targeted Limit Queue Front Refit

SIM-03H refits only the `limit_queue:front` time-to-fill component from targeted observations. It exists because SIM-03F diagnosed a bucket-specific model underfit and SIM-03G correctly refused aggregate-only patching.

## Why Aggregate Patching Is Forbidden

The SIM-03 report contains point residuals, not the calibration distribution needed to refit without validation leakage. SIM-03H therefore requires exported `limit_queue:front` observations. Without them it emits `requires_targeted_observation_export`, writes an unchanged output report, and keeps SIM-03D failing.

## Observation JSONL Schema

Each line is a JSON object:

```json
{
  "schema_version": 1,
  "bucket": "limit_queue:front",
  "split": "calibration",
  "observed_time_to_fill_ms": 3900.0,
  "modeled_time_to_fill_ms": null,
  "fill_outcome": "filled",
  "queue_position_features": {
    "queue_bucket": "front"
  },
  "event_ts_ns": "1777296600000000000",
  "session_id": "2026-04-27-rth",
  "instrument": "MNQM6",
  "source_report_hash": "<sha256 of fill_slippage_calibration.json>"
}
```

`split` must be `calibration` or `validation`. `fill_outcome` must be `filled`, `no_fill`, or `cancelled`. Filled rows require `observed_time_to_fill_ms`. SIM-03H rejects observations whose `source_report_hash` does not match the input calibration report bytes.

## Run

```powershell
npm run sim:03h:refit-front -- `
  --calibration-report reports/sim/fill_slippage_calibration.json `
  --diagnosis-report reports/sim/limit_queue_front_diagnosis.json `
  --observations reports/sim/limit_queue_front_observations.jsonl `
  --out reports/sim/fill_slippage_calibration_refit_limit_queue_front.json `
  --patch-report reports/sim/limit_queue_front_refit_report.json `
  --checked-at-ts-ns 1777399200000000000
```

SIM-03H derives the modeled time-to-fill median from calibration split filled observations and the empirical time-to-fill median from validation split filled observations, then recomputes only the `limit_queue:front` time-to-fill residual.

## Validation

SIM-03H always runs the SIM-03D validator against the output report. REL-01 remains blocked unless the embedded `sim03d_gate.status` is `pass`.

## Missing Observations

If observations are missing or incomplete, the next ticket is SIM-03I: export only `limit_queue:front` observations from the SIM-03C checkpoint/progress pipeline or from a targeted corpus pass. A full 39 GB recalibration rerun should remain the fallback, not the first move.
