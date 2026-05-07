# QFA-119b TBBO Corpus Integrity Threshold

Ticket: QFA-119b-housekeeping - Add TBBO corpus integrity thresholds

Scope: add a conservative `tbbo` byte-floor entry for the current Tier A Feb/Mar corpus and document the TBBO-enhanced manifest hashes.

## Manifest hashes

| Month | Manifest file | SHA-256 |
| --- | --- | --- |
| Feb 2026 | `D:/qfa-cache/databento/tier-a-feb-mar-2026/manifest-feb-2026.json` | `05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c` |
| Mar 2026 | `D:/qfa-cache/databento/tier-a-feb-mar-2026/manifest-mar-2026.json` | `cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f` |

## TBBO threshold

| Field | Value |
| --- | ---: |
| TBBO files observed | 41 |
| Observed minimum byte count | 109 |
| Minimum session | `2026-03-20-rth` |
| Configured floor | 54 |

The threshold intentionally includes the known `2026-03-20-rth` expiry/activity-migration anomaly, whose TBBO file is only 109 bytes. Excluding that session, the observed minimum TBBO byte count is 1,366,669 bytes on `2026-03-19-rth`.

## Anomalies

| Session | Note |
| --- | --- |
| `2026-03-20-rth` | Tiny TBBO file due to expiry/activity migration. Included in the conservative v1 floor. |
| `2026-03-16-rth` | Previously documented Databento degraded-quality session; keep visible for Phase 3/4 interpretation. |
| `2026-02-23-rth` | Retry succeeded during corpus expansion; no threshold exception required. |

## Scope notes

No data fetch was performed in this housekeeping ticket. QFA-401 and QFA-402 continue to avoid TBBO in their current fidelity computations; this update only keeps corpus-integrity checks and real-archive inventory tests aligned with the current TBBO-enhanced corpus.

## Verification note

The updated `tbbo` byte floor verified TBBO files successfully in both Feb and Mar manifests. The standalone `verify-corpus` command still exits nonzero on the current real archive for broader pre-existing corpus readiness reasons:

| Manifest | Exit | Reason |
| --- | ---: | --- |
| Feb 2026 | 2 | 19 verified sessions is below the existing `min_verified_sessions = 20`. |
| Mar 2026 | 2 | Existing non-TBBO byte floors fail around expiry/thinning sessions (`2026-03-17-rth` through `2026-03-20-rth`), leaving 18 verified sessions below the existing 20-session minimum. |

Those broader readiness thresholds were not changed in QFA-119b. The normal repository gates pass with the TBBO-enhanced manifest expectations.
