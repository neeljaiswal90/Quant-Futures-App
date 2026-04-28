# SIM-03A - Databento Calibration Corpus Readiness

Status: SIM-03A-0 implemented

SIM-03A separates Databento data readiness from SIM-03 model fitting. This prevents
subscription, delay-window, or historical-depth issues from being reported as model
calibration failures.

## SIM-03A-0: Availability Preflight

`scripts/sim/check-databento-mnq-availability.py` checks whether a selected MNQ RTH
window is available from Databento for the schemas required by the SIM-03 calibration
corpus.

The tool probes:

- `trades`
- `mbp-1`
- `mbp-10`
- `mbo`
- `definition`

It records `databento_api_key_present: true | false`, but never writes the key or a
truncated key to output.

Example:

```powershell
npm run sim:03a:check-databento -- `
  --session-id 2026-04-27-rth `
  --start 2026-04-27T13:30:00Z `
  --end 2026-04-27T20:00:00Z `
  --out reports/sim/databento_mnq_availability.json
```

Generated reports under `reports/sim/` are local operational evidence and should not be
committed.

## Exit Codes

- `0`: all probed schemas returned sample records and the window is ready for corpus work.
- `1`: script or argument error.
- `2`: structured not-ready result, such as missing API key, unavailable schema, delay
  window, subscription block, or no records returned.

## Report Shape

The report includes:

- `availability_report_schema_version`
- `dataset`
- `dataset_range`
- `probed_window`
- per-schema availability and sample counts
- `ready_for_sim03_calibration_corpus`
- `blocked_reason`

The production report is intentionally snapshot-in-time. Databento historical range and
intraday availability can change, so reports from different dates may differ. Unit tests
use fixture-backed clients and perform no network calls.

## Boundary With SIM-03

SIM-03A-0 does not fetch a 20-session corpus and does not fit fill/slippage constants.

Next steps:

- SIM-03A-1 selects at least 20 eligible MNQ RTH sessions and writes a corpus manifest.
- SIM-03A-2 verifies corpus integrity and per-session checksums.
- SIM-03 fits SIM-02 calibration constants and evaluates plan section 11.1 residuals.

If this preflight returns exit code `2`, route the blocker to data availability or
procurement before writing calibration model code.
