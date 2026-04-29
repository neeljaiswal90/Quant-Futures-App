# SIM-03F Limit Queue Front Diagnosis

SIM-03F diagnoses the isolated SIM-03 `limit_queue:front` calibration failure without changing thresholds, fitted constants, REL gates, or the source SIM-03 report.

## CLI

```powershell
npm run sim:03f:diagnose-limit-front -- `
  --report reports/sim/fill_slippage_calibration.json `
  --out reports/sim/limit_queue_front_diagnosis.json
```

The CLI emits a deterministic JSON diagnosis report. It is intentionally diagnostic evidence, not a pass/fail override.

## What The Report Answers

- Extracts the `limit_queue:front` sample counts, residuals, checks, thresholds, and exact failed criteria.
- Compares `front` against `near` (reported as alias `near_front`), `middle`, and `back`.
- Summarizes marketable bucket context so a queue-specific failure is not mistaken for a broad marketable-slippage failure.
- Classifies the likely failure class using report-only evidence.
- Recommends a targeted follow-up while explicitly keeping SIM-03 failed.

## Current Expected Finding

The real SIM-03 corpus run failed only `limit_queue:front` on time-to-fill median relative error. Fill probability and no-fill residuals passed, neighboring queue buckets passed, and sample counts were healthy. The expected diagnosis is `model_underfit_specific_bucket`, with a targeted front-bucket time-to-fill recalibration recommended before REL-01 can consume SIM-03.
