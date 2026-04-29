# SIM-03K: Limit Queue Front Distribution Analysis

SIM-03K is an analysis-only follow-up to the real SIM-03 corpus run. The SIM-03 chain now runs end-to-end, but the targeted `limit_queue:front` median refit improved the time-to-fill residual without clearing the acceptance threshold.

SIM-03K does not change thresholds, mutate calibration reports, produce a passing report, or unblock REL-01. It explains the remaining front-bucket error so SIM-03L can make a targeted model-class change with evidence.

## Inputs

```powershell
npm run sim:03k:analyze-front-distribution -- `
  --observations reports/sim/limit_queue_front_observations.jsonl `
  --calibration-report reports/sim/fill_slippage_calibration.json `
  --diagnosis-report reports/sim/limit_queue_front_diagnosis.json `
  --refit-report reports/sim/limit_queue_front_refit_report.json `
  --out reports/sim/limit_queue_front_distribution_analysis.json
```

The observation file is expected to follow the shared `limit_queue:front` schema used by SIM-03H and SIM-03I. SIM-03K validates each JSONL row against the source calibration report hash while streaming the file.

## What It Reports

The JSON report includes:

- Calibration vs validation filled time-to-fill percentiles: p10, p25, p50, p75, p90, p95, p99, mean, standard deviation, IQR, and p95/p50 tail ratio.
- Outcome counts for filled, no-fill, and cancelled observations.
- Deterministic histograms over millisecond/second buckets.
- Regime slices by side, session, instrument, time of day, order size, observed time bucket, and modeled time bucket.
- Queue-front definition audit for negative, zero, positive, and missing `queue_ahead_size` values.
- Candidate model-form estimates for single-median, side-specific, time-of-day, spread-bucket, robust trimmed statistic, and best available piecewise refits.
- A dominant failure classification and a SIM-03L recommendation.

## Safety Boundary

SIM-03K is deliberately read-only evidence. It keeps:

- `sim03_status: "failed"`
- `rel01_status: "blocked"`
- `status: "analysis_only"`

REL-01 remains blocked unless a later SIM-03L refit produces a SIM-03D-passing calibration report.

## Interpretation

Expected classifications include:

- `validation_distribution_shift`: calibration and validation distributions are shifted in a way that a single calibration median cannot close.
- `side_specific_underfit`: side-specific medians are enough to clear the estimated validation metric.
- `time_of_day_regime_underfit`: the error concentrates in deterministic RTH time buckets.
- `heavy_tail_metric_sensitivity`: p95/p50 or p99/p50 tail ratios dominate the residual.
- `queue_front_definition_mismatch`: the exported front bucket contains unexpected queue-ahead records or negative/zero queue-ahead records behave differently.
- `model_class_underfit`: the data supports the current failure as a front-bucket model-form issue, not a threshold issue.

Generated SIM-03K reports are operational evidence and should not be committed.
