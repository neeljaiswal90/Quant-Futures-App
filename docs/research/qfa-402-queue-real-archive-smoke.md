# QFA-402 Real Archive Queue Fidelity Smoke

Run scope: QFA-402-housekeeping-1, real Tier A archive queue-fidelity smoke.

Worktree: `D:\Quant-futures-app-qfa-402-smoke`

Branch: `feat/qfa-402-queue-real-archive-smoke`

Archive root: `D:/qfa-cache/databento/tier-a-feb-mar-2026/`

Helper: `scripts/backtester/qfa-402-real-archive-smoke.mts`

Command:

```powershell
$env:NODE_OPTIONS='--max-old-space-size=8192'; npx tsx scripts/backtester/qfa-402-real-archive-smoke.mts
```

## Method

- Verified the locked February and March manifest content hashes, manifest file-byte sha256s, and verified-report file-byte sha256s before running session probes.
- Selected one February session and one March session:
  - `2026-02-25-rth` as `baseline`.
  - `2026-03-17-rth` as `stress`; this session is part of the documented March H-cycle expiry thinning quality-exclusion set, so interpret it as stress-regime evidence.
- Used QFA-402 one-second top-of-book probes from `mbp-1`, with both buy and sell sides.
- Used the QFA-105 MBP-1-only synthesized path via `synthesizeQueue` in `mbp_proxy` mode.
- Used a batched MBO reference replay in the helper, matching the QFA-402 reference semantics while avoiding per-probe full-session replays.
- Summarized with `DEFAULT_QUEUE_FIDELITY_POLICY_V1`: tolerance `100000` ppm, minimum comparable probes `300`, threshold `800000` ppm.

## Locked hash verification

| Month | Manifest content hash | Manifest file sha256 | Verified report sha256 | Status |
| --- | --- | --- | --- | --- |
| Feb | `0ac2e673aee2acee8949b9d4b73dad62a3c12e4eda0676a1b74351bdbf802409` | `05e4ff4e2eb79586c64930e42ecc2a2dbdc5c1f281f0a5a24c6a7d5a87656f0c` | `9ca2b49b423303f115ed3ae39d86cfbad7f8231b89de6db91c9cb75856168af6` | match |
| Mar | `dd873dc9ea3556b1c6cbd399fac465cd1168c9b6501f72d947cc7d71810aa6bd` | `cf3b0ca57b43fd4c6aab57e44c3e9eca27de0902519c56922e474736dda3838f` | `a72e662519cf7cfa30db251675b2f609b8b3e4ee081813a06637c1723b52c701` | match |

## Session results

| Session | Regime | Symbol | MBP-1 records | Total probes | Comparable probes | Within tolerance probes | Share ppm | Threshold ppm | Status |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `2026-02-25-rth` | baseline | `MNQH6` | 13,718,048 | 46,800 | 46,800 | 5,792 | 123,760 | 800,000 | fail |
| `2026-03-17-rth` | stress | `MNQH6` | 5,420,860 | 46,798 | 46,798 | 22,326 | 477,071 | 800,000 | fail |
| Aggregate | selected Feb/Mar | mixed | 19,138,908 | 93,598 | 93,598 | 28,118 | 300,412 | 800,000 | fail |

All synthesized estimates reported source mode `mbp_proxy`; no synthesized probes were unavailable.

## Source file byte checks for selected sessions

| Session | MBO manifest bytes | MBO observed bytes | MBP-1 manifest bytes | MBP-1 observed bytes | Status |
| --- | ---: | ---: | ---: | ---: | --- |
| `2026-02-25-rth` | 320,413,947 | 320,413,947 | 260,716,753 | 260,716,753 | match |
| `2026-03-17-rth` | 153,658,716 | 153,658,716 | 108,651,375 | 108,651,375 | match |

## Runtime and build notes

| Scope | Load MBP-1 | Generate probes | Synthesize `mbp_proxy` | MBO reference replay | Compare/summarize | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `2026-02-25-rth` | 19.229 s | 1.345 s | 38.646 s | 55.289 s | 0.007 s | 114.517 s |
| `2026-03-17-rth` | 5.924 s | 0.620 s | 14.540 s | 13.457 s | 0.015 s | 34.556 s |
| Full smoke | n/a | n/a | n/a | n/a | n/a | 149.083 s |

Peak observed process RSS at final report: 7,305 MB. The smoke was run with `NODE_OPTIONS=--max-old-space-size=8192`.

An isolated-worktree `npm ci` was required before closeout gates because the new worktree initially had no local `node_modules/.bin` entries for `tsc`, `vitest`, or `tsx`.

## QFA-103b parquet/cache observation

The QFA-103b cache characterization issue was not encountered in this smoke. The helper intentionally used the direct QFA-102 DBN loader path and did not build or read QFA-103 parquet cache artifacts. This avoided materializing large real-session parquet files while preserving the requested QFA-402 MBO-reference vs QFA-105 `mbp_proxy` comparison.

## Closeout gates

After `npm ci` in the isolated worktree:

| Gate | Result |
| --- | --- |
| `npm run build` | pass |
| `npm run lint` | pass |
| `npm test` | pending rerun after TBBO manifest expectation housekeeping |
| `npm run check:python` | pass |
| `npm run check:determinism` | pass |

Determinism closeout hashes:

- `final_chain_hash`: pending rerun after TBBO manifest expectation housekeeping
- `final_phase2_hash`: pending rerun after TBBO manifest expectation housekeeping
