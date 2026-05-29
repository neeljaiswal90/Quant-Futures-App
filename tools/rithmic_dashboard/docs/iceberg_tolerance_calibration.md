# Iceberg `match_tolerance_ms` + priority-channel calibration (RA-066)

## Why

Two open questions after RA-059/RA-065/RA-069:

1. Was RA-059's ~0 iceberg yield caused by a mis-tuned `match_tolerance_ms`
   (the OBS-trade-tail confirmation window)?
2. What would flipping `IcebergDetectorConfig.admit_priority_confirmation`
   (the RA-069 gate on RA-065's priority channel) actually do?

## Method (Part A — runnable on local Rithmic captures)

`rithmic_dashboard/cli/calibrate_iceberg_tolerance.py` sweeps
`match_tolerance_ms ∈ {5,10,25,50,100,150,250}` over the local MBO/OBS capture
pairs (priority is 100%-populated post-RA-065). At each tolerance it records, on
the **OBS-only** path (production default) and the **with-priority** path:

- iceberg count (via `detect_icebergs`), and
- raw consumption confirmations split by source (`obs*` vs `priority_queue`).

Run: `python -m rithmic_dashboard.cli.calibrate_iceberg_tolerance --lookback-sessions 14`.
Output: `data/live_analysis/iceberg_tolerance_sweep.json`.

## Results (14 sessions × 20 MB tails, 2026-05-29)

| tolerance | OBS icebergs | with-priority | Δ priority | raw OBS consumptions | raw priority-only |
|---:|---:|---:|---:|---:|---:|
| 5 ms | **9** | 9 | +0 | 96,177 | 21,560 |
| 10 ms | 9 | 10 | +1 | 96,461 | 22,166 |
| 25 ms | 6 | 6 | +0 | 96,708 | 23,039 |
| 50 ms *(default)* | 5 | 7 | +2 | 96,941 | 23,757 |
| 100 ms | 4 | 6 | +2 | 97,043 | 24,283 |
| 150 ms | 4 | 6 | +2 | 97,023 | 24,647 |
| 250 ms | 3 | 5 | +2 | 97,101 | 24,953 |

## Interpretation

- **`match_tolerance_ms` is a real lever, and tighter is higher yield** — 9
  icebergs at 5 ms vs 5 at the 50 ms default vs 3 at 250 ms. Mechanism: a wider
  window lets an early delete consume a larger slice of the shared trade volume
  (`_TradeIndex.consume_matching_volume` decrements `quantity_remaining`),
  starving later deletes at the same price and breaking refill runs. So widening
  *reduces* run formation here.
- **Yield is not correctness.** The extra detections at 5 ms may be true
  icebergs or false positives from over-tight matching. Yield-maximization alone
  cannot decide the default — that needs ground truth (Part B).
- **The priority channel adds little at the iceberg level** (+0–2 events) despite
  ~22–26 % extra *raw* consumption confirmations. Most priority-only
  confirmations do not cluster into threshold-passing runs.
- An earlier 2-session / 5 MB smoke showed OBS ≈ 0 at every tolerance — a
  small-tail artifact (too few refill runs in 5 MB), corrected by the full run.

## Decision

- **Hold `match_tolerance_ms` at 50 ms.** 5 ms is recorded as the
  yield-maximizing *candidate* to validate, not an auto-applied default.
- **Keep `admit_priority_confirmation = False`** (RA-069). Both the tolerance
  move and the gate flip are blocked on Part B.

## Part B — split into direction (B-a, done) and fill-precision (B-b, blocked)

The priority-channel flip rests on two separable questions.

### B-a — FIFO direction (VALIDATED 2026-05-29, no databento needed)

`cli/verify_fifo_direction.py` checks, within each (price-bucket, side) level,
whether `depth_order_priority` rises with arrival time across consecutive ADDs.
Result on the 2 priority-bearing sessions (the only captures normalized
post-RA-065 — older siblings predate the priority plumbing): **88,191 within-level
adjacent ADD pairs, increasing_fraction = 1.0000** — zero decreasing, zero equal,
zero counterexamples. The token rises strictly with arrival, so the oldest order
at a level (FIFO front, fills first) carries the lowest token → `min == front` →
**`FIFO_ASCENDING_IS_FRONT=True` is confirmed correct.** Two sessions suffice
because the pair count is enormous and the result is exact (no violations).

### B-b — fill precision (BLOCKED on paired data)

Whether a front-of-queue delete is a real FILL (vs a cancel) needs F/T ground
truth, which Rithmic lacks (RA-064). databento has F/T but **does not overlap our
captures**: corpus = 2026-02-02 → 04-30 (92 sessions), Rithmic captures =
05-19 → 05-29 — **zero paired sessions**. So the date-matched cross-feed
precision/recall is not runnable today. Options: acquire databento for the May
capture dates (definitive), forward-capture paired sessions, or a databento-alone
concept check (validates front→fill in principle, not the Rithmic token mapping).
Until B-b clears, `admit_priority_confirmation` stays False and
`match_tolerance_ms` stays 50 ms.

#### Rithmic-only precision proxy (no databento) — channel is mostly signal

Before buying databento, `cli/estimate_priority_fill_proxy.py` bounds precision
using only Rithmic: for each priority-only confirmation, is there a trade at the
same price + expected aggressor within a wide window? Result over **23,757
confirmations** (2 priority-bearing sessions):

| window | trade present |
|---|---:|
| +/- 50 ms | 55.2 % |
| +/- 250 ms | 71.8 % |
| +/- 500 ms | 78.3 % |
| +/- 1000 ms | 83.8 % |
| +/- 2000 ms | 87.4 % |
| **none within 2 s** | **12.6 %** |

- **Precision UPPER bound ~87.4 %** — optimistic; presence ≠ this order's volume,
  so a coincidental print at the price inflates it.
- **Cancel LOWER bound ~12.6 %** — robust; no print at all at price+side within 2 s.
- **55 % land within a tight 50 ms** — almost certainly the fill OBS's
  volume-accounting already claimed for an earlier order at the level.

Verdict: the channel is **mostly real signal, not noise** — only ~1 in 8 is a
near-certain cancel — so a gold-standard databento number is worth buying (not
chasing noise). It is NOT clean enough to flip on the proxy alone (12.6 % cancels
+ a wide ambiguous 50 ms–2 s band). No-databento middle path: a **hybrid gate**
admitting a priority-only confirmation only when a tight-window (≤250 ms) print
exists would capture the high-confidence ~72 % and drop the orphans — a defensible
cautious flip if the signal is wanted before paired data is acquired.
