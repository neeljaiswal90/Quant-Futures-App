# Databento Corpus Inventory

QFA-100 records the Databento corpora that downstream backtester tickets should
consume instead of refetching. The Python SIM-03A scripts remain the canonical fetch,
verify, and decode path. This inventory is descriptive and does not create or mutate
corpus files.

## Common Contract

- Dataset: `GLBX.MDP3`
- Critical RTH schemas: `mbo`, `mbp-1`, `mbp-10`, `trades`
- Reference schema: `definition`, fetched on UTC-midnight-aligned snapshot windows
- Threshold source of truth: `config/sim03/corpus-integrity-thresholds.json`
- Threshold config sha256: `86925e4519fa7b581caf6fb39a787588278b5e6a83eea8a21ea93d2011ad00a1`
- Tier rule: corpora containing both `mbo` and `mbp-10` are Tier A
- Cache invalidation key for downstream derived artifacts: source manifest content hash

## Manifest Hash vs Verified Report Hash

The manifest content hash from `computeManifestHash` identifies the corpus structure:
which sessions, schemas, byte counts, fetch windows, split assignments, and DBN paths
were emitted by the Python fetcher. It is stable across JSON formatting, whitespace,
and object key ordering. A manifest file-bytes sha256 identifies one exact file
snapshot and can change if the same manifest is reserialized.

The verified report file-bytes sha256 identifies the content evidence for that corpus:
per-file sha256s, byte-count floor checks, source-manifest hash, and threshold-config
lineage. For full content lineage, downstream tickets such as QFA-103 and QFA-115
should embed both the manifest content hash and the verified report file-bytes sha256.
Verified reports are first-class lineage artifacts, not just diagnostics.

## SIM-03 Calibration Corpus

| Field | Value |
| --- | --- |
| Corpus path on disk | `D:\Quant-futures-app\data\databento\sim03_corpus\` |
| Manifest-recorded path | `A:\Quant-futures-app-data\databento\sim03_corpus` (stale, pre-move) |
| Path translation | Replace `A:\Quant-futures-app-data\databento\sim03_corpus` with `D:\Quant-futures-app\data\databento\sim03_corpus` at consumer read time |
| Local QFA-100/QFA-101 audit state | Manifest and verified report are present under `reports/sim/`; DBN corpus files are present on `D:` at the post-move path |
| Manifest path | `D:\Quant-futures-app\reports\sim\sim03_calibration_corpus_manifest.json` |
| Manifest content hash (loader, format-stable) | `bca748bfb227c5f886cf6d1fcda01381206c941dbdcee6d42e81830e418f9c1d` |
| Manifest file-bytes sha256 (current snapshot) | `9209037b4a68b828dd46932c0ec67d3270b5e7c0911821400e1b68a27fc2ce3a` |
| Verified report path | `D:\Quant-futures-app\reports\sim\sim03_calibration_corpus_verified_report.json` |
| Verified report file-bytes sha256 | `5efb98f32314be4907650c20c6964ae9d515024dda756c7f7618fda5575106fc` |
| Session count | 30 sessions from `config/sim03/session-list.yaml` |
| Date range | 2026-03-16 through 2026-04-27 |
| Symbol(s) | `MNQM6` by default |
| Schemas captured | `definition`, `mbo`, `mbp-1`, `mbp-10`, `trades` |
| Disk size | 39.869 GiB observed locally, 150 files |
| Tier classification | Tier A, because the manifest contains both `mbo` and `mbp-10` |
| Quality exclusions in effect | `2026-04-10-rth`: `databento_condition_degraded_warning` |
| Intended use | SIM-03 fill/slippage calibration and benign-regime baseline work |
| Coexistence rule | Use this corpus for calibration baselines. Apply the documented A: to D: path translation rather than refetching or substituting the Tier A trial archive |

The SIM-03 calibration manifest confirms the corpus structure and 30-session scope, and
the verified report records `status: "verified"`, 29 verified sessions, and no failed
sessions. The underlying DBN files are present on `D:` at the post-move location;
downstream loaders should apply the documented path translation and keep the manifest
content hash as the lineage anchor.

## Tier A Trial Archive

| Field | Value |
| --- | --- |
| Corpus path | `D:\qfa-cache\databento\tier-a-feb-mar-2026\` |
| Manifest path | `D:\qfa-cache\databento\tier-a-feb-mar-2026\manifest-feb-2026.json`; `D:\qfa-cache\databento\tier-a-feb-mar-2026\manifest-mar-2026.json` |
| Manifest content hash (loader, format-stable) | Feb: `c16122c2b28a06b0f59fafff6f2081995433827ec2acd3867bbaf8306f021c6f`; Mar: `c2e2e77be004053694a99eec892c39b8503e97b0e214178b8d3716040bc5c92e` |
| Manifest file-bytes sha256 (current snapshot) | Feb: `ba24ce7ab4fdd964a97e960eab0d8e89b5298f2bb4986d8afc332c5682d58dbe`; Mar: `a2c65f2bd8afbb3567a132cd7a26d4c13c4b4345dbcb62ec471f1a46ee78606a` |
| Verified report path | `D:\qfa-cache\databento\tier-a-feb-mar-2026\verified-feb-2026.json`; `D:\qfa-cache\databento\tier-a-feb-mar-2026\verified-mar-2026.json` |
| Verified report file-bytes sha256 | Feb: `2fb89dcd871a4c4bb2bee335bf415be72a4a91a2ce8b35def89d504d1e87205c`; Mar: `c8402682c8d375571a9a17e251dda67947f8b1cdfb9bfd9ff5bf5cd0fc2750f5` |
| Session count | 41 sessions total: 19 in February, 22 in March |
| Date range | 2026-02-02 through 2026-03-31 |
| Symbol(s) | `MNQH6` in February; `MNQH6` through 2026-03-20; `MNQM6` from 2026-03-23 |
| Schemas captured | `definition`, `mbo`, `mbp-1`, `mbp-10`, `trades` |
| Disk size | 66.19 GiB observed locally, 209 files |
| Tier classification | Tier A, because it contains both `mbo` and `mbp-10` |
| Quality exclusions in effect | `2026-03-17-rth`, `2026-03-18-rth`, `2026-03-19-rth`: `h_cycle_expiry_thinning`; `2026-03-20-rth`: `h_cycle_expiry_no_rth_volume` |
| Intended use | Stress-regime research, H-cycle roll/expiry analysis, future Phase 4 model training and fill-model recalibration research |
| Coexistence rule | Keep separate from SIM-03 calibration. Use this archive for stress-regime research or explicit cross-regime validation keyed by the Feb/Mar manifest content hashes |

The February verified report records `status: "verified"` with 19 verified sessions.
The March verified report records 18 verified sessions and 4 failed H-cycle expiry
sessions; the threshold config documents those expiry-week sessions as quality
exclusions for research interpretation. Do not refetch or modify this archive from
QFA-100 work.

## Downstream Notes

- QFA-101 should make TypeScript manifest types compatible with the existing Python
  manifest shape: top-level dataset/symbol/status fields, session entries, per-session
  `definition_snapshot_window`, `rth_window`, per-schema DBN paths, byte counts, and
  lower-case sha256 lineage in verified reports.
- QFA-102 should load the DBN files at the paths recorded by these manifests.
- QFA-102 should apply the SIM-03 A: to D: path translation documented above before
  deciding that calibration DBN files are missing.
- QFA-103 should key parquet-cache invalidation on the manifest content hash recorded
  here, not on wall-clock fetch time or file formatting.
- QFA-104 and QFA-105 should prefer the SIM-03 calibration corpus for baseline work
  and the Tier A archive only when their ticket explicitly calls for stress-regime data.
