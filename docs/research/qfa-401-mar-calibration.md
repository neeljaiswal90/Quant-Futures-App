# QFA-401-mar-calibration - OFI Mar calibration

Ticket: QFA-401-mar-calibration - OFI Mar stress-regime calibration

## Summary

QFA-401-mar-calibration reran the existing QFA-401 OFI fidelity machinery on wider bounded windows for a clean March session outside the documented expiry-thinning anomaly zone.

Result:

- Feb baseline `2026-02-25-rth` passes the locked `850,000` ppm threshold at 6, 15, and 30 minutes.
- Clean Mar alternate-month `2026-03-02-rth` also passes at 6, 15, and 30 minutes.
- The prior QFA-401-housekeeping-1 Mar failure on `2026-03-19-rth` is therefore best classified as anomaly-zone/session-specific evidence, not a clean-Mar formula or threshold failure.

This ticket changes no QFA-401 formulas, no thresholds, and no source contracts.

## Inputs

Archive path:

```text
D:/qfa-cache/databento/tier-a-feb-mar-2026/
```

Manifest file hashes verified during Step 0:

| Month | Manifest | SHA-256 | Expected | Status |
|---|---|---|---|---|
| Feb | `manifest-feb-2026.json` | `05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c` | `05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c` | pass |
| Mar | `manifest-mar-2026.json` | `cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f` | `cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f` | pass |

QFA-401 formula and policy used unchanged:

```text
reference:   MBP-10 unweighted depth-aware OFI
synthesized: MBP-1 top-of-book OFI + trades imbalance
bucket:      1s
alignment:   bucket intersection only
metric:      z-score + Pearson ppm
threshold:   850,000 ppm
```

Runtime configuration:

```powershell
$env:NODE_OPTIONS='--max-old-space-size=8192'
```

Existing helper used:

```text
scripts/backtester/qfa-401-ofi-real-archive-smoke.mts
```

## Session selection

| Session | Role | Schemas | Source byte counts | Rationale |
|---|---|---|---|---|
| `2026-02-25-rth` | Feb baseline | `mbp-10`, `mbp-1`, `trades` | MBP-10 432,015,808; MBP-1 260,716,753; trades 7,574,875 | Same clean Feb baseline as QFA-401-h1. |
| `2026-03-02-rth` | Clean Mar alternate-month | `mbp-10`, `mbp-1`, `trades` | MBP-10 827,028,696; MBP-1 468,458,848; trades 12,165,235 | First complete early-March candidate outside the documented 2026-03-17 through 2026-03-20 expiry-thinning zone. |

Avoided anomaly-zone sessions:

```text
2026-03-17-rth
2026-03-18-rth
2026-03-19-rth
2026-03-20-rth
```

Mar `2026-03-02-rth` should be read as a clean alternate-month sample, not as a VIX-labelled stress regime.

## Results

| Regime | Session | Window | Reference buckets | Synthesized buckets | Aligned buckets | pearson_r_ppm | Threshold | Result | Runtime | Notes |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---|
| baseline | `2026-02-25-rth` | 360s | 360 | 360 | 360 | 896,600 | 850,000 | PASS | 5.234s | Reproduces QFA-401-h1 Feb pass. |
| clean alternate-month | `2026-03-02-rth` | 360s | 360 | 360 | 360 | 903,437 | 850,000 | PASS | 5.890s | Clean Mar prefix passes. |
| baseline | `2026-02-25-rth` | 900s | 900 | 900 | 900 | 872,315 | 850,000 | PASS | 11.806s | Wider than original smoke. |
| clean alternate-month | `2026-03-02-rth` | 900s | 900 | 900 | 900 | 917,329 | 850,000 | PASS | 13.577s | Wider clean Mar evidence. |
| baseline | `2026-02-25-rth` | 1800s | 1,800 | 1,800 | 1,800 | 885,302 | 850,000 | PASS | 21.017s | Largest attempted Feb window. |
| clean alternate-month | `2026-03-02-rth` | 1800s | 1,800 | 1,800 | 1,800 | 919,052 | 850,000 | PASS | 36.228s | Largest attempted Mar window. |

Decoded record counts:

| Session | Window | MBP-10 records | MBP-1 records | Trades records | Missing depth levels | Unknown trade sides |
|---|---:|---:|---:|---:|---:|---:|
| `2026-02-25-rth` | 360s | 1,082,115 | 822,446 | 34,350 | 0 | 0 |
| `2026-03-02-rth` | 360s | 1,178,383 | 876,576 | 41,082 | 0 | 0 |
| `2026-02-25-rth` | 900s | 2,283,494 | 1,759,384 | 69,358 | 0 | 0 |
| `2026-03-02-rth` | 900s | 2,675,477 | 1,991,035 | 83,552 | 0 | 0 |
| `2026-02-25-rth` | 1800s | 3,878,489 | 3,038,105 | 123,633 | 0 | 0 |
| `2026-03-02-rth` | 1800s | 5,001,276 | 3,761,756 | 140,282 | 0 | 0 |

## Comparison to QFA-401-housekeeping-1

QFA-401-housekeeping-1 recorded:

| Session | Window | pearson_r_ppm | Threshold | Result | Caveat |
|---|---:|---:|---:|---|---|
| `2026-02-25-rth` | 360s | 896,600 | 850,000 | PASS | 6-minute prefix only. |
| `2026-03-19-rth` | 360s | 690,691 | 850,000 | FAIL | Expiry-thinning/anomaly-zone session; 6-minute prefix only. |

QFA-401-mar-calibration keeps the Feb baseline and replaces Mar 19 with clean Mar 2. Clean Mar 2 passes at every attempted window, including a 30-minute prefix.

## Runtime and memory notes

All attempted windows completed under the requested 8 GB heap cap.

Largest successful windows:

| Session | Largest successful window | Runtime | Result |
|---|---:|---:|---|
| `2026-02-25-rth` | 1800s | 21.017s | PASS |
| `2026-03-02-rth` | 1800s | 36.228s | PASS |

Full RTH was not attempted. The 30-minute windows satisfy the immediate requirement to widen beyond the original 6-minute smoke, while full RTH remains a known memory-risk shape for whole-session materialization across Phase 3 evidence scripts.

No parquet cache was required. The existing helper uses direct bounded DBN loader reads and feeds bounded records into the existing QFA-401 OFI builders.

## Diagnosis

Likely anomaly-zone/session-specific issue: yes.

The prior failing Mar session, `2026-03-19-rth`, is in the documented H-cycle expiry-thinning / activity-migration window. Clean Mar `2026-03-02-rth` passes at 360s, 900s, and 1800s.

Likely clean-Mar regime issue: not supported by this evidence.

The clean alternate-month Mar session passes with substantial margin, including `919,052` ppm over the 30-minute prefix.

Likely formula/reference issue: not supported by this evidence.

The unchanged MBP-10 reference formula and MBP-1+trades synthesized formula pass both Feb baseline and clean Mar alternate-month windows.

Likely window-size artifact: no.

The clean Mar result improves, rather than degrades, as the window widens from 360s to 1800s. The previous Mar 19 failure should not be generalized from a 6-minute anomaly-zone prefix to all Mar data.

## Recommendation

Reclassify the QFA-401 Mar failure as anomaly-zone/session-specific pending any future VIX-stratified analysis.

For Phase 3 exit-gate purposes, QFA-401 OFI fidelity is supported on:

```text
Feb clean baseline:        PASS at 30-minute prefix
Mar clean alternate-month: PASS at 30-minute prefix
```

Do not change the QFA-401 formula or the `850,000` ppm threshold based on the Mar 19 anomaly-zone prefix alone.

If future work needs a true stress-regime OFI conclusion, dispatch a VIX-labelled / regime-stratified ticket under QFA-212 / QFA-420 rather than using expiry-thinning sessions as the stress proxy.

## Scope control

No QFA-401 formulas changed.

No thresholds changed.

No RunSpec files changed.

No journal event types changed.

No CI dependency on `D:/qfa-cache` was added.
