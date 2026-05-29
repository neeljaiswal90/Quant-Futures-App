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

## Part B (the flip-gate — pending)

Ground truth requires F/T, which Rithmic lacks (RA-064). Use the RA-053 databento
corpus (`.dbn.zst`, carries F/T fills): on dates with both a databento session
and a Rithmic capture, label which Rithmic deletes were real fills (databento
F/T at matching price/time), then measure **precision/recall per tolerance** and
the precision of priority-only `at_queue_front` confirmations (validating the
`FIFO_ASCENDING_IS_FRONT` direction). Caveat: databento encodes queue position
implicitly (FIFO by arrival), not as Rithmic's explicit `depth_order_priority` —
a genuine cross-feed alignment task. Outcome: a measured go/no-go on the 5 ms
default and on flipping the priority channel on.
