# SIM-03L: Robust Front-Bucket Time-To-Fill Refit

SIM-03L is a targeted model-class follow-up to SIM-03K. It applies a robust `limit_queue:front` time-to-fill statistic only when SIM-03K classifies the remaining failure as `heavy_tail_metric_sensitivity`.

It does not change global thresholds, marketable slippage, no-fill/cancel metrics, passing buckets, or REL gates directly. REL-01 remains blocked unless SIM-03D passes the SIM-03L output report.

## Why This Exists

The real SIM-03 chain showed that a median refit improved the front-bucket error from `0.465225` to `0.292783`, but the threshold is `0.25`. SIM-03K then showed the remaining error is dominated by tail sensitivity rather than a queue-front definition mismatch.

SIM-03L therefore tests a `10-90` trimmed mean statistic for the front bucket. This is intentionally narrow: it changes only the front-bucket time-to-fill component and records a tail-content audit so the trim cannot silently hide adverse fills.

## Tail Audit

Before SIM-03L applies the robust statistic, it checks:

- Validation p95 must not exceed calibration p95 by more than `1.25x`.
- Validation p99 must not exceed calibration p99 by more than `1.25x`.
- Validation share at or above calibration p95 must not exceed `10%`.
- Trimmed low/high counts and tail ratios are written to the patch report.

If the tail audit fails, SIM-03L writes an unchanged calibration output with `status: "tail_audit_failed"` and SIM-03D remains failed.

## Run

```powershell
npm run sim:03l:robust-front-refit -- `
  --calibration-report reports/sim/fill_slippage_calibration.json `
  --diagnosis-report reports/sim/limit_queue_front_diagnosis.json `
  --analysis-report reports/sim/limit_queue_front_distribution_analysis.json `
  --observations reports/sim/limit_queue_front_observations.jsonl `
  --out reports/sim/fill_slippage_calibration_robust_limit_queue_front.json `
  --patch-report reports/sim/limit_queue_front_robust_refit_report.json `
  --checked-at-ts-ns 1777399200000000000
```

SIM-03L always runs SIM-03D against the output report and embeds the gate result in the patch report.

## Outputs

- `reports/sim/fill_slippage_calibration_robust_limit_queue_front.json`
- `reports/sim/fill_slippage_calibration_robust_limit_queue_front_gate.json`
- `reports/sim/limit_queue_front_robust_refit_report.json`

Generated reports are operational evidence and should not be committed.

## Acceptance Boundary

`robust_refit_passed` means SIM-03D passed the output report. `robust_refit_failed` means the robust statistic was applied but SIM-03D still failed. `tail_audit_failed` means the robust statistic was not applied because the tail evidence was unsafe.

Only SIM-03D can move `ready_for_rel01_execution_simulation` to `true`.
