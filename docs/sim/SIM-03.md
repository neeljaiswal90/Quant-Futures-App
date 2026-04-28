# SIM-03 - Fill/Slippage Calibration

Status: implemented as a deterministic calibration/reporting CLI.

`SIM-03` consumes the SIM-03A verified Databento corpus and fits the constants
that replace SIM-02's placeholder fill/slippage assumptions. It does not fetch
data, call Databento, generate research datasets, or advance REL gates by itself.

## Inputs

The calibrator requires all three SIM-03A lineage inputs:

- `reports/sim/sim03_calibration_corpus_manifest.json`
- `reports/sim/sim03_calibration_corpus_verified_report.json`
- `config/sim03/corpus-integrity-thresholds.json`

The tool refuses to run unless:

- the manifest has `ready_for_sim03_model_fitting: true`;
- the verified report has `ready_for_sim03_model_fitting: true`;
- the current manifest SHA-256 matches `verified_report.source_manifest_hash`;
- the current thresholds SHA-256 matches `verified_report.thresholds_config_hash`;
- verified sessions include both calibration and validation splits.

## Run

```powershell
npm run sim:03 -- `
  --manifest reports/sim/sim03_calibration_corpus_manifest.json `
  --verified-report reports/sim/sim03_calibration_corpus_verified_report.json `
  --thresholds config/sim03/corpus-integrity-thresholds.json `
  --calibrated-at-ts-ns 1777395600000000000 `
  --out reports/sim/fill_slippage_calibration.json `
  --markdown-out reports/sim/fill_slippage_calibration.md
```

`--calibrated-at-ts-ns` is caller-provided. The script does not call the wall
clock, so the same corpus, thresholds, fitter version, and timestamp produce the
same report bytes.

Generated reports under `reports/sim/` are operational evidence and should not
be committed.

## Output

`reports/sim/fill_slippage_calibration.json` includes:

- `calibration_report_schema_version`;
- `simulated_execution_fitter_version = "fitter_v1"`;
- manifest, verified-report, and thresholds hashes;
- calibration and validation session counts;
- fitted marketable-slippage constants;
- fitted queue-fill constants by queue bucket;
- residual tables for marketable slippage, queue fills, and strategy-level cost;
- top-level `status: "pass" | "fail"`;
- top-level `ready_for_rel01_execution_simulation`.

REL-01 criterion 5 should read the top-level pass/fail status only. A missing or
failed SIM-03 report is not waivable by downstream release tooling.

## Residual Thresholds

SIM-03 scores the plan section 11.1 thresholds:

- marketable slippage two-sample KS statistic <= 0.15;
- marketable p50 residual <= max(0.25 tick, 20% of empirical absolute p50);
- marketable p90 residual <= max(0.50 tick, 25% of empirical absolute p90);
- adverse p95 residual <= max(0.50 tick, 25% of empirical adverse p95);
- limit fill-probability residual <= 10 percentage points;
- limit median time-to-fill relative error <= 25%;
- limit no-fill residual <= 10 percentage points;
- strategy-level mean slippage residual <= max(0.25 tick, 15% empirical mean
  absolute slippage).

Buckets below `--min-bucket-sample` are marked `insufficient_sample`. The
current fitter aggregates to the broad all-session bucket before failing a
bucket for insufficient sample size.

## Exit Codes

- `0`: calibration completed and all required residual thresholds passed.
- `1`: script or argument error, including lineage hash mismatch.
- `2`: calibration completed but one or more residual thresholds failed.

## Testing Boundary

CI tests use synthetic JSONL corpus files and never call Databento. Production
runs use Databento DBN files from the SIM-03A manifest via the local Databento
DBN reader.
