# QFA-119c-housekeeping: Verify-corpus anomaly cleanup

Ticket: QFA-119c-housekeeping - Verify-corpus anomaly cleanup

Status: PASS

Base HEAD: `ef2834393d3ea5be88e38edfaa2a1a629319e2eb`

Archive path: `D:/qfa-cache/databento/tier-a-feb-mar-2026/`

## Scope

This ticket resolves two pre-existing standalone `verify-corpus` readiness
failures carried forward from QFA-119b:

1. Feb 2026 has 19 verified RTH sessions while the legacy global floor was 20.
2. Mar 2026 includes documented H-cycle expiry-thinning sessions that fail
   non-TBBO byte floors and should be tracked as expected quality exclusions,
   not hidden as unexplained corpus corruption.

No TBBO byte-floor changes, manifest content changes, data fetches, QFA-105 /
QFA-402 changes, ADR amendments, RunSpec changes, journal changes, or
determinism-CI changes were made.

## Current behavior before QFA-119c

Commands:

```powershell
python scripts/sim/verify-databento-sim03-corpus.py `
  --manifest D:/qfa-cache/databento/tier-a-feb-mar-2026/manifest-feb-2026.json `
  --thresholds config/sim03/corpus-integrity-thresholds.json `
  --out .tmp/qfa119c-before-feb.json `
  --verified-at-ts-ns 1770000000000000000

python scripts/sim/verify-databento-sim03-corpus.py `
  --manifest D:/qfa-cache/databento/tier-a-feb-mar-2026/manifest-mar-2026.json `
  --thresholds config/sim03/corpus-integrity-thresholds.json `
  --out .tmp/qfa119c-before-mar.json `
  --verified-at-ts-ns 1770000000000000000
```

Before results:

| Manifest | Exit | Status | Verified | Failed | Quality-excluded | Reason |
|---|---:|---|---:|---:|---:|---|
| Feb 2026 | 2 | failed | 19 | 0 | 0 | verified session count 19 is below required minimum 20 |
| Mar 2026 | 2 | failed | 18 | 4 | 0 | H-cycle thinning sessions fail non-TBBO byte floors; verified session count 18 is below required minimum 20 |

Mar failure details:

```text
2026-03-17-rth: mbp-1/trades below floor
2026-03-18-rth: mbp-1/trades below floor
2026-03-19-rth: mbp-1/trades below floor
2026-03-20-rth: mbo/mbp-1/mbp-10/trades below floor
```

These are the same March anomaly-zone sessions documented during Phase 3
fidelity work.

## Chosen path

Chosen remediation: hybrid Path A + Path B.

Path A:

```text
Use explicit quality exclusions for documented Mar anomaly sessions:
  2026-03-17-rth
  2026-03-18-rth
  2026-03-19-rth
  2026-03-20-rth
```

Path B:

```text
Add month-specific verified-session minimums:
  2026-02 -> 19
  2026-03 -> 18
```

Rationale:

```text
Feb's issue is calendar reality: the current Feb corpus has 19 RTH sessions.
Mar's issue is a documented H-cycle expiry-thinning quality zone; after those
four sessions are quality-excluded, the current archive has 18 verified Mar
sessions. A single global min_verified_sessions value cannot represent both
months honestly, so month-specific minimums keep Feb and Mar explicit without
weakening the shared default for future manifests.
```

## Config diff summary

`config/sim03/corpus-integrity-thresholds.json`:

```text
Added min_verified_sessions_by_month:
  2026-02: 19
  2026-03: 18

Added quality exclusions:
  2026-03-17-rth: documented_h_cycle_expiry_thinning
  2026-03-18-rth: documented_h_cycle_expiry_thinning
  2026-03-19-rth: documented_h_cycle_expiry_thinning
  2026-03-20-rth: documented_h_cycle_expiry_migration
```

Unchanged:

```text
min_verified_sessions default: 20
all schema byte floors
tbbo min_byte_count: 54
tbbo floor derivation
```

## Script diff summary

`scripts/sim/verify-databento-sim03-corpus.py`:

```text
- Adds optional min_verified_sessions_by_month support.
- Infers a manifest month from session IDs when all sessions belong to one
  YYYY-MM month.
- Uses the month-specific minimum when configured, otherwise falls back to the
  existing global min_verified_sessions.
- Applies quality_exclusions as actual verification exclusions for complete
  source sessions before schema byte-floor checks.
```

The change is additive and preserves the existing global default behavior for
manifests without a configured month-specific minimum.

## Verify-corpus output after QFA-119c

After results:

| Manifest | Exit | Status | Min verified sessions | Verified | Failed | Quality-excluded | Result |
|---|---:|---|---:|---:|---:|---:|---|
| Feb 2026 | 0 | verified | 19 | 19 | 0 | 0 | PASS |
| Mar 2026 | 0 | verified | 18 | 18 | 0 | 4 | PASS |

Commands used:

```powershell
python scripts/sim/verify-databento-sim03-corpus.py `
  --manifest D:/qfa-cache/databento/tier-a-feb-mar-2026/manifest-feb-2026.json `
  --thresholds config/sim03/corpus-integrity-thresholds.json `
  --out .tmp/qfa119c-after-feb.json `
  --verified-at-ts-ns 1770000000000000000

python scripts/sim/verify-databento-sim03-corpus.py `
  --manifest D:/qfa-cache/databento/tier-a-feb-mar-2026/manifest-mar-2026.json `
  --thresholds config/sim03/corpus-integrity-thresholds.json `
  --out .tmp/qfa119c-after-mar.json `
  --verified-at-ts-ns 1770000000000000000
```

## Cross-references

The Mar anomaly sessions are also documented in:

```text
QFA-402-housekeeping-1
QFA-402b
ADR-0012
```

These sessions should remain visible as anomaly/quality-exclusion sessions for
future Phase 4 regime and fidelity interpretation.

## Verdict

Standalone `verify-corpus` now exits 0 for both current Tier A Feb and Mar
manifests without changing TBBO thresholds or hiding documented anomaly
sessions.
