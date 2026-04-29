# SIM-03G Targeted Front Queue Recalibration

SIM-03G is a safety-bounded follow-up to the SIM-03F diagnosis. It targets only the `limit_queue:front` time-to-fill metric that failed SIM-03:

- Bucket: `limit_queue:front`
- Metric: `time_to_fill_relative_error_within_time_to_fill_relative_threshold`
- Real-corpus value: `0.465225`
- Threshold: `0.25`
- Diagnosis: `model_underfit_specific_bucket`

## Non-Goals

SIM-03G must not change global SIM-03 thresholds, passing queue buckets, marketable slippage, fill/no-fill thresholds, REL gates, or strategy runtime behavior. It must also not use validation-set empirical medians as fitted constants.

## CLI

```powershell
npm run sim:03g:recalibrate-front -- `
  --calibration-report reports/sim/fill_slippage_calibration.json `
  --diagnosis-report reports/sim/limit_queue_front_diagnosis.json `
  --out reports/sim/fill_slippage_calibration_recalibrated.json `
  --patch-report reports/sim/limit_queue_front_recalibration_patch.json
```

To run the independent SIM-03D gate against the output:

```powershell
npm run sim:03g:recalibrate-front -- `
  --calibration-report reports/sim/fill_slippage_calibration.json `
  --diagnosis-report reports/sim/limit_queue_front_diagnosis.json `
  --out reports/sim/fill_slippage_calibration_recalibrated.json `
  --patch-report reports/sim/limit_queue_front_recalibration_patch.json `
  --gate-out reports/sim/fill_slippage_calibration_recalibrated_gate.json `
  --checked-at-ts-ns 1777399200000000000
```

## Safety Boundary

If the source SIM-03 report contains only point residuals, SIM-03G emits `requires_targeted_bucket_rerun`. That is the expected safe outcome for the current real-corpus report: the report does not contain the front-bucket calibration distribution needed to refit time-to-fill without leaking validation data.

Aggregate-only recalibration is allowed only when the report includes explicit targeted refit evidence under `targeted_recalibration_inputs.limit_queue_front_time_to_fill` with method `targeted_bucket_refit_from_calibration_observations`.

Expected evidence shape:

```json
{
  "targeted_recalibration_inputs": {
    "limit_queue_front_time_to_fill": {
      "method": "targeted_bucket_refit_from_calibration_observations",
      "modeled_time_to_fill_median_ms": 3900.0,
      "time_to_fill_relative_error": 0.072154,
      "evidence": "calibration-only front bucket refit artifact path or hash"
    }
  }
}
```

The method value is policy, not a casual implementation detail. SIM-03G rejects validation-median patches or any other method string so the recalibrated report cannot be produced from validation leakage.

## REL-01 Evidence

REL-01 remains blocked until:

- SIM-03G produces a recalibrated SIM-03 report from legitimate targeted refit evidence.
- SIM-03D validates that recalibrated report as `status: "pass"`.
- The patch report records the source report hash, diagnosis report hash, changed fields, unchanged bucket count, and SIM-03D gate result.
