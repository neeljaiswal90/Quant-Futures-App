# SIM-03D Calibration Report Gate

SIM-03D validates a completed SIM-03 fill/slippage calibration report without
touching the Databento corpus. It is filesystem-only: no DBN reads, no network
calls, and no model fitting.

## Command

```powershell
npm run sim:03d:validate-calibration -- `
  --report reports/sim/fill_slippage_calibration.json `
  --checked-at-ts-ns 1777399200000000000 `
  --out reports/sim/fill_slippage_calibration_gate.json
```

`checked-at-ts-ns` is caller-provided so the gate report remains deterministic
and does not depend on wall-clock time.

## Gate Rules

The gate rechecks the residual values already written by SIM-03:

- Marketable slippage: KS, p50, p90, and adverse p95 residuals.
- Limit queue: fill probability, time-to-fill median relative error, and no-fill rate.
- Strategy cost: strategy-level mean slippage residual.
- Top-level source status, REL-ready flag, empty failure reasons, and lineage hashes.

Exit codes:

- `0`: report passes and `ready_for_rel01_execution_simulation` is true.
- `1`: script error or invalid input report.
- `2`: report was readable, but one or more gate checks failed.

## Output

The gate writes `reports/sim/fill_slippage_calibration_gate.json`, including:

- `calibration_gate_report_schema_version`
- `source_report_hash`
- source lineage fields from SIM-03
- per-residual check results
- top-level `status`
- top-level `ready_for_rel01_execution_simulation`

