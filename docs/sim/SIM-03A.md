# SIM-03A - Databento Calibration Corpus Readiness

Status: SIM-03A-0 implemented; SIM-03A-1 corpus manifest tooling implemented

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

## SIM-03A-1: Corpus Fetch + Manifest

`scripts/sim/fetch-databento-sim03-corpus.py` fetches a sessioned MNQ calibration
corpus and writes a structured manifest. It performs data acquisition only; it does not
fit SIM-02 constants, score residuals, generate strategy datasets, or advance REL gates.

Input is an operator-selected session list. Use at least 20 eligible RTH sessions for
SIM-03, and prefer around 30 sessions to leave room for exclusions and the held-out
validation split.

Example session list:

```yaml
sessions:
  - session_id: 2026-04-27-rth
    start: 2026-04-27T13:30:00Z
    end: 2026-04-27T20:00:00Z
```

Run:

```powershell
npm run sim:03a:fetch-corpus -- `
  --session-list config/sim03/session-list.yaml `
  --out-dir data/databento/sim03_corpus `
  --manifest reports/sim/sim03_calibration_corpus_manifest.json
```

Per eligible session, the tool fetches:

- `trades`, `mbp-1`, `mbp-10`, and `mbo` over the RTH event window.
- `definition` as a UTC-midnight snapshot from `00:00:00Z` to `00:00:01Z` for the
  session date.

The UTC-midnight definition window is intentional. Instrument definitions behave like
session snapshots rather than RTH event streams, so probing only the RTH window can miss
the definition row even when the schema is available.

Corpus DBN files are written under `data/databento/sim03_corpus/{session_id}/` and are
gitignored. The manifest under `reports/sim/` is also local operational evidence and
should not be committed.

The manifest records:

- `manifest_schema_version`
- requested, complete, excluded, and partial session counts
- schema file paths and byte counts
- RTH window and definition snapshot window per session
- exclusion reasons for weekends, short or half-day sessions, and maintenance-spanning
  windows
- retry policy and per-schema attempt counts
- deterministic `calibration` / `validation` split labels based on `session_id` hashes

The fetcher is idempotent. Re-running it skips existing non-empty DBN files and refetches
zero-byte partial files. Each schema fetch uses up to three attempts with exponential
backoff by default.

SIM-03A-1 exit codes:

- `0`: corpus has at least the requested complete-session count and no partial sessions.
- `1`: script or argument error.
- `2`: structured partial result, such as missing API key, unavailable schema, excluded
  sessions, or too few complete sessions.

## Boundary With SIM-03

SIM-03A-0 does not fetch a 20-session corpus and does not fit fill/slippage constants.
SIM-03A-1 fetches the corpus and writes the manifest, but still does not fit model
constants.

Next steps:

- SIM-03A-2 verifies corpus integrity and per-session checksums.
- SIM-03 fits SIM-02 calibration constants and evaluates plan section 11.1 residuals.

If this preflight returns exit code `2`, route the blocker to data availability or
procurement before writing calibration model code.
