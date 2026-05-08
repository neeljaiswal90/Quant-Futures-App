# QFA-119d archive forward extension

## Status

PASS. QFA-119d extended the Tier A archive with April 2026 RTH sessions and reran QFA-212 against the Feb-Mar-Apr substrate. The extended substrate now contains non-uniform VIX-primary regime labels and unblocks QFA-420 from the regime-variance perspective.

## Scope discipline

- Ticket: QFA-119d-archive-forward-extension.
- Scope: April 2026 Tier A archive extension plus QFA-212 v2 substrate confirmation.
- No ADR amendments.
- No QFA-105, QFA-402, RunSpec, journal, validation-policy, or determinism-gate changes.
- `regime-labels.json` remains research-tier per ADR-0013 / ADR-0014 until QFA-420 consumes it in a validated path.

## Phase 1 operational fetch

| Field | Value |
|---|---|
| Archive root | `D:/qfa-cache/databento/tier-a-feb-mar-2026/` |
| Manifest | `manifest-apr-2026.json` |
| Manifest hash | `e37d01b3a3976f2f2614c2a85171ce4cc8b6b5ad069bf782f55285b0e7721a2c` |
| Sessions requested | 21 |
| Complete sessions | 21 |
| Partial sessions | 0 |
| Total bytes | 21,049,281,454 |
| Symbol | `MNQM6` |
| Schemas | `trades`, `mbp-1`, `mbp-10`, `mbo`, `tbbo`, `definition` |
| Cost preflight | $10.2845 |

Good Friday 2026-04-03 was excluded from the RTH session list. Databento reported degraded quality for 2026-04-10; the existing QFA-119c `quality_exclusions` entry covers that session. No additional April expiry-thinning exclusion was added. All April sessions were fetched as `MNQM6`.

## Config and fixture updates

- Added `2026-04: 20` to `min_verified_sessions_by_month`.
- Preserved the existing `2026-04-10-rth` quality exclusion reason: `databento_condition_degraded_warning`.
- Added the April manifest hash to real-archive inventory smoke coverage.
- Updated corpus-manifest real-manifest tests from two manifests to three manifests.
- Updated QFA-212 validator manifest hash set to include April.
- Real-manifest tests now assert schema inventory as a sorted set because April's fetch-generated manifest preserves fetch helper order while Feb/Mar were post-sorted during TBBO backfill.

The April minimum is 20 because 21 source sessions are complete, but 2026-04-10 is intentionally quality-excluded and therefore not counted as verified.

## Verify-corpus results

| Month | Manifest hash | Verified sessions | Quality excluded | Min required | Failed sessions | Status |
|---|---|---:|---:|---:|---:|---|
| 2026-02 | `05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c` | 19 | 0 | 19 | 0 | verified |
| 2026-03 | `cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f` | 18 | 4 | 18 | 0 | verified |
| 2026-04 | `e37d01b3a3976f2f2614c2a85171ce4cc8b6b5ad069bf782f55285b0e7721a2c` | 20 | 1 | 20 | 0 | verified |

## QFA-212 v2 archive-native validation

QFA-212 was rerun on the extended 62-session Feb-Mar-Apr archive.

| Metric | QFA-212 v1 | QFA-212 v2 |
|---|---:|---:|
| Archive sessions | 41 | 62 |
| VIX vs MNQ-RV comparable sessions | 28 | 48 |
| VIX vs MNQ-RV agreement | 39.2857% | 56.2500% |
| VIX vs MNQ-RV bootstrap 95% CI | 10.71%-67.86% | 29.17%-75.00% |
| Public-proxy reference | 50.0000% | 50.0000% |
| ADR-0014 material divergence | no | no |
| VIX vs VXN agreement | 100.0000% | 92.9825% |

The QFA-212 v2 archive-native VIX vs MNQ-RV agreement is 6.25 percentage points above the public-proxy reference and remains within ADR-0014's 20 percentage-point bound.

## Regime distribution

| Period | High | Mid | Low | Total |
|---|---:|---:|---:|---:|
| Feb 2026 | 19 | 0 | 0 | 19 |
| Mar 2026 | 22 | 0 | 0 | 22 |
| Apr 2026 | 6 | 4 | 11 | 21 |
| Total | 47 | 4 | 11 | 62 |

Calibration-eligible distribution after quality exclusions:

| Period | High | Mid | Low | Total |
|---|---:|---:|---:|---:|
| Feb 2026 | 19 | 0 | 0 | 19 |
| Mar 2026 | 18 | 0 | 0 | 18 |
| Apr 2026 | 6 | 3 | 11 | 20 |
| Total | 43 | 3 | 11 | 57 |

## Verdict

QFA-119d satisfies the QFA-420 substrate requirement. The extended archive has at least two calibration-eligible sessions in each of `high`, `mid`, and `low` regimes:

- high: 43 calibration-eligible sessions
- mid: 3 calibration-eligible sessions
- low: 11 calibration-eligible sessions

QFA-420 cross-regime stratification is authorized with the caveat that mid-regime evidence is a screening floor, not a fine-effect battery. Fine mid-regime claims would require additional extension per ADR-0013 calibration-battery guidance.

## Runtime notes

- QFA-212 v2 label generation and archive-native validation runtime: about 936 seconds.
- Verify-corpus across Feb, Mar, and Apr runtime: about 70 seconds.
- QFA-212 used the Python Databento reader path introduced in QFA-212 v1.

## Recommendation

Dispatch QFA-420 next. Scope QFA-420 as tri-regime stratification with explicit power caveats:

- high and low have enough coverage for practical comparisons.
- mid has only 3 calibration-eligible sessions and should be treated as screening evidence unless additional archive extension is approved.
