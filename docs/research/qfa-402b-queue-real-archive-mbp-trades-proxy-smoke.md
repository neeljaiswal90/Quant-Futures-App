# QFA-402b - Real-archive queue fidelity smoke (`mbp_trades_proxy`)

Ticket: QFA-402b - Real-archive queue fidelity smoke (`mbp_trades_proxy`)

## Summary

QFA-402b reran the real-archive queue-fidelity smoke with QFA-105's new `mbp_trades_proxy` mode.

Strict result:

- Feb full-session baseline still fails the locked `800,000` ppm threshold.
- Clean Mar 360-second prefix passes the locked threshold, but it is an operational characterization only, not a full-session fidelity claim.
- Aggregate remains below threshold because the full Feb session dominates probe count.

Interpretation:

`mbp_trades_proxy` closed most of the original QFA-402-h1 baseline gap. The clean Feb full-session result moved from `123,760` ppm to `745,341` ppm, a `+621,581` ppm improvement that closes `91.9%` of the original `676,240` ppm gap. The remaining `54,659` ppm gap should be treated as residual model imprecision or threshold-calibration pressure, not as evidence that trades were irrelevant.

## Inputs

Archive path:

```text
D:/qfa-cache/databento/tier-a-feb-mar-2026/
```

Manifest hashes verified:

| Month | Manifest content hash | Manifest file sha256 | Verified file sha256 |
|---|---|---|---|
| Feb | `0ac2e673aee2acee8949b9d4b73dad62a3c12e4eda0676a1b74351bdbf802409` | `05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c` | `9ca2b49b423303f115ed3ae39d86cfbad7f8231b89de6db91c9cb75856168af6` |
| Mar | `dd873dc9ea3556b1c6cbd399fac465cd1168c9b6501f72d947cc7d71810aa6bd` | `cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f` | `a72e662519cf7cfa30db251675b2f609b8b3e4ee081813a06637c1723b52c701` |

Policy:

```text
mode:                            mbp_trades_proxy
sample_interval:                 1s
fill_horizon_ns:                 5,000,000,000
order_quantity:                  1
tolerance_ppm:                   100,000
min_within_tolerance_share_ppm:  800,000
```

Heap config:

```text
NODE_OPTIONS=--max-old-space-size=12288
```

The heap cap was raised from 8 GB to 12 GB because Mar 2026-03-02 has materially more MBP-1 volume than Feb 2026-02-25. The bounded successful run peaked at `7,648` MB RSS.

## Session selection

| Session | Scope | Rationale |
|---|---|---|
| `2026-02-25-rth` | Full RTH | Clean Feb baseline and direct delta point against QFA-402-h1. |
| `2026-03-02-rth` | First 360 seconds of RTH, plus 5-second horizon pad | Clean early-March alternate-month session, outside the documented 2026-03-17 to 2026-03-20 expiry-thinning zone. Volatility regime is not pre-classified. |

Mar 2026-03-02 should not be read as a VIX-labelled stress regime. It is a clean alternate-month data point selected to avoid the known H-cycle expiry-thinning anomaly zone.

## Results

| Session | Scope | Total probes | Comparable probes | Within tolerance | within_tolerance_share_ppm | Threshold | Status |
|---|---:|---:|---:|---:|---:|---:|---|
| `2026-02-25-rth` | Full RTH | 46,800 | 46,800 | 34,882 | 745,341 | 800,000 | FAIL |
| `2026-03-02-rth` | 360s prefix | 720 | 720 | 634 | 880,555 | 800,000 | PASS |
| Aggregate | Mixed scope | 47,520 | 47,520 | 35,516 | 747,390 | 800,000 | FAIL |

## Delta vs QFA-402-h1

Feb 2026-02-25 is the valid full-session delta point.

| Mode | within_tolerance_share_ppm | Threshold | Margin |
|---|---:|---:|---:|
| `mbp_proxy` (QFA-402-h1) | 123,760 | 800,000 | -676,240 |
| `mbp_trades_proxy` (QFA-402b) | 745,341 | 800,000 | -54,659 |
| Delta | +621,581 | n/a | +621,581 |

Gap closure:

```text
original gap: 800,000 - 123,760 = 676,240 ppm
residual gap: 800,000 - 745,341 = 54,659 ppm
gap closed:   621,581 / 676,240 = 91.9%
```

This is strong empirical evidence that the original QFA-402 failure was mostly trades-absence. The strict locked-threshold result remains FAIL.

## Runtime

| Session | Load MBP-1 | Load trades | Generate probes | Synthesize | MBO reference | Compare | Total |
|---|---:|---:|---:|---:|---:|---:|---:|
| `2026-02-25-rth` | 20.303s | 0.570s | 1.299s | 43.982s | 59.573s | 0.010s | 125.739s |
| `2026-03-02-rth` 360s prefix | 1.186s | 0.062s | 0.083s | 2.810s | 1.771s | 0.000s | 5.970s |
| Total run | n/a | n/a | n/a | n/a | n/a | n/a | 131.717s |

Record counts:

| Session | MBP-1 records loaded | MBP-1 probe-source records | Trades records loaded | Source mode counts |
|---|---:|---:|---:|---|
| `2026-02-25-rth` | 13,718,048 | 13,718,048 | 473,009 | `mbp_trades_proxy: 46,800` |
| `2026-03-02-rth` 360s prefix | 892,804 | 876,577 | 41,937 | `mbp_trades_proxy: 720` |

Unavailable synthesized probes: `0` for both sessions.

## Full-session Mar OOM note

A full-session attempt for Mar 2026-03-02 was attempted first under:

```text
NODE_OPTIONS=--max-old-space-size=12288
```

The process loaded the full MBP-1 stream and full trades stream, reached probe generation after `24,657,989` MBP-1 records, and then failed before synthesis/reference with:

```text
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
```

This is a memory-scaling finding. Mar 2026-03-02 has roughly 1.8x the MBP-1 volume of Feb 2026-02-25, and whole-session materialization is not reliable for large MNQ RTH days even at a 12 GB heap cap.

The bounded Mar prefix result is therefore a deterministic operational characterization, not a full-session fidelity claim and not directly comparable to the Feb full-session result.

## Cache notes

The smoke used direct DBN loader paths. No parquet cache artifacts were built or read.

QFA-103b / streaming-throughput carry-forward: QFA-401-h1 and QFA-402b both exposed memory pressure from whole-window record materialization. Future large-session fidelity runs should use bounded windows or streaming/incremental aggregation rather than collecting full sessions in memory.

## Recommendation

QFA-402b should land as evidence, not as a threshold or formula change.

Recommended next tickets:

1. `QFA-402-threshold-walkthrough`: locked-decision walkthrough for whether the `800,000` ppm threshold and `100,000` ppm tolerance remain appropriate given the clean Feb empirical floor of `745,341` ppm and 91.9% gap closure.
2. `QFA-402c residual-gap probe analysis`: conditional on the walkthrough preserving the threshold; inspect the 25.5% of Feb probes outside tolerance for systematic miss patterns.
3. `QFA-105-streaming-throughput` or QFA-103b extension: characterize and reduce whole-session memory pressure before large Phase 4 runs.

## Scope control

No QFA-105 code changed.

No QFA-402 contract, threshold, or formula changed.

No manifests changed.

No CI dependency on `D:/qfa-cache` was added.
