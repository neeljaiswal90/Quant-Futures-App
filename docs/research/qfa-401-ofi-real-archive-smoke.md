# QFA-401 Real-Archive OFI Smoke

Generated: 2026-05-07 07:51 PDT / 2026-05-07T14:51Z

Scope: QFA-401-housekeeping-1 real Tier A archive smoke against
`D:/qfa-cache/databento/tier-a-feb-mar-2026`.

## Summary

This is a bounded partial-session smoke, not a full-session fidelity claim.

A larger `2026-02-25-rth` 30-minute prefix attempt exhausted the default Node heap after
about 16.5 seconds while using the existing QFA-401 OFI series builder. The builder
collects decoded records in memory before sorting and bucketing, so the run was reduced
to 6-minute RTH prefixes to preserve real-archive evidence without changing QFA-401
formulas or schemas.

## Locked Manifest Verification

| Artifact | SHA-256 | Expected | Status |
| --- | --- | --- | --- |
| `manifest-feb-2026.json` | `05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c` | `05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c` | pass |
| `manifest-mar-2026.json` | `cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f` | `cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f` | pass |

Both current manifests report event schemas `mbo`, `mbp-1`, `mbp-10`, `tbbo`, `trades`. QFA-401 uses only `mbp-10`, `mbp-1`, and `trades`; `tbbo` is present but out of scope for this smoke.

Verified report hashes captured for traceability:

| Artifact | SHA-256 |
| --- | --- |
| `verified-feb-2026.json` | `9ca2b49b423303f115ed3ae39d86cfbad7f8231b89de6db91c9cb75856168af6` |
| `verified-mar-2026.json` | `a72e662519cf7cfa30db251675b2f609b8b3e4ee081813a06637c1723b52c701` |

## Method

Operational helper:
`scripts/backtester/qfa-401-ofi-real-archive-smoke.mts`

Existing modules used:

| Purpose | Module |
| --- | --- |
| OFI reference/proxy series and fidelity stats | `apps/backtester/src/fidelity/ofi/index.ts` |
| Real DBN/ZSTD decode | `apps/strategy_runtime/src/data/dbn-loader.ts` |

The runtime-too-large probe was run with the same helper before its `.mts`
build-scope rename:

```powershell
npx tsx scripts/backtester/qfa-401-ofi-real-archive-smoke.ts --session 2026-02-25-rth --max-seconds 1800
```

Completed commands using the final helper path:

```powershell
npx tsx scripts/backtester/qfa-401-ofi-real-archive-smoke.mts --session 2026-02-25-rth --max-seconds 360
npx tsx scripts/backtester/qfa-401-ofi-real-archive-smoke.mts --session 2026-03-19-rth --max-seconds 360
```

The 1,800-second probe failed with `JavaScript heap out of memory`; the two
360-second commands completed.

## Results

Threshold: `pearson_r_ppm >= 850_000`.

| Session | Symbol | Split | Scope | Window seconds | MBP-10 records | MBP-1 records | Trades records | Reference buckets | Synthesized buckets | Aligned buckets | pearson_r_ppm | Status | Runtime |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| `2026-02-25-rth` | `MNQH6` | calibration | partial RTH prefix | 360 | 1,082,115 | 822,446 | 34,350 | 360 | 360 | 360 | 896,600 | pass | 5,478 ms |
| `2026-03-19-rth` | `MNQH6` | calibration | partial RTH prefix | 360 | 304,781 | 200,827 | 3,668 | 360 | 360 | 360 | 690,691 | fail | 1,517 ms |

Both completed runs reported:

| Session | Missing depth levels | Unknown trade sides |
| --- | ---: | ---: |
| `2026-02-25-rth` | 0 | 0 |
| `2026-03-19-rth` | 0 | 0 |

Source compressed byte counts for selected sessions:

| Session | MBP-10 bytes | MBP-1 bytes | Trades bytes |
| --- | ---: | ---: | ---: |
| `2026-02-25-rth` | 432,015,808 | 260,716,753 | 7,574,875 |
| `2026-03-19-rth` | 210,358,612 | 101,354,421 | 1,001,906 |

## Cache and Build Notes

The default QFA parquet cache root, `D:/qfa-cache/parquet`, was missing during the smoke.
The helper therefore used the direct DBN loader path and did not populate parquet cache
artifacts.

QFA-103b cache characterization issue encountered:

The current QFA parquet cache is full-file content-hash keyed. For a bounded operational
smoke, a cold cache would still require hashing and/or building full-file cache artifacts
for every selected session/schema before any small time-window result is available. The
existing QFA-401 OFI series builder also collects records in memory before bucketing,
which is why the 30-minute February prefix exhausted the default Node heap. A future
cache characterization pass should separate full-session cache build performance from
bounded-window smoke-read performance.

No changes were made to OFI formulas, manifests, schemas, validation gates,
strategy runtime contracts, RunSpec, journal events, or GitHub workflows.
