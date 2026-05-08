# QFA-402d - Probe-policy calibration sweep

## Status

QFA-402d is an evidence/calibration ticket. It does not change QFA-105, QFA-402, queue-fidelity formulas, thresholds, tolerance bands, validation policy, RunSpec, journal events, or CI archive dependencies.

Final verdict: `probe_policy_pass`.

Reason: at least one swept probe-policy cell clears `within_tolerance_share_ppm >= 800_000` on both clean Feb full-RTH sessions. The best cell by highest minimum session share is:

```text
fill_horizon_ns       = 15_000_000_000  (15s)
depletion_lookback_ns = 60_000_000_000  (60s)
```

Best-cell results:

| Session | within_tolerance_share_ppm | Threshold | Result | MAE ppm | Mean signed error ppm |
|---|---:|---:|---|---:|---:|
| 2026-02-25-rth | 889,636 | 800,000 | PASS | 90,048 | +30,926 |
| 2026-02-24-rth | 902,218 | 800,000 | PASS | 83,400 | +42,668 |

Recommended next ticket: `QFA-402-walkthrough-2` to lock the new probe-policy values, followed by `QFA-402-housekeeping-3` to update the QFA-402 queue-fidelity default path to `mbp_trades_proxy` plus the locked probe policy.

## ADR-0011 reference

ADR-0011 (`docs/adr/ADR-0011-qfa-402-queue-fidelity-threshold.md`) remains controlling policy.

Preserved posture:

- Threshold remains `within_tolerance_share_ppm >= 800_000`.
- Tolerance remains `+/-100_000 ppm`.
- No post-hoc `720_000` relaxation.
- No target-metric redefinition.
- No QFA-105 model change.
- No QFA-402 formula change.

## QFA-402c baseline

QFA-402c showed the current default policy (`fill_horizon_ns=5s`, `depletion_lookback_ns=30s`) failed both clean Feb sessions, but the failures were concentrated in probe-policy-sensitive strata.

| Session | Scope | Fill horizon | Lookback | within_tolerance_share_ppm | Threshold | Result |
|---|---|---:|---:|---:|---:|---|
| 2026-02-25-rth | full RTH | 5s | 30s | 745,341 | 800,000 | FAIL |
| 2026-02-24-rth | full RTH | 5s | 30s | 790,738 | 800,000 | FAIL |
| 2026-03-02-rth | 1800s prefix | 5s | 30s | 886,047 | 800,000 | PASS |

QFA-402d only sweeps the two clean Feb full-RTH sessions because Mar already passes and the dispatch explicitly excludes Mar sweeps.

## Sweep grid

Grid values:

| Parameter | Values | Rationale |
|---|---|---|
| `fill_horizon_ns` | 2.5s, 5s, 10s, 15s | Tests whether the 5s realized-fill target was too short for a near-binary MBO outcome. |
| `depletion_lookback_ns` | 15s, 30s, 60s | Tests whether the synthesis path benefits from shorter/longer recent depletion memory. |

Execution shape:

- 4 fill horizons x 3 depletion lookbacks = 12 grid cells.
- 2 clean Feb full-RTH sessions per cell = 24 data points.
- All 24 data points completed.
- Per-cell JSON was written incrementally under `scratch/qfa-402d/{session}/{fill_horizon_ns}-{depletion_lookback_ns}.json`.
- `scratch/` outputs are not committed.

## Per-cell results

Pass/fail is evaluated against `800,000 ppm` independently for both Feb sessions.

| Fill horizon | Lookback | Feb25 share | Feb25 MAE | Feb25 bias | Feb24 share | Feb24 MAE | Feb24 bias | Min share | Verdict |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 2.5s | 15s | 591,217 | 289,707 | -20,262 | 670,862 | 249,076 | +34,839 | 591,217 | fail_both |
| 2.5s | 30s | 601,495 | 280,417 | -2,285 | 681,610 | 244,120 | +46,440 | 601,495 | fail_both |
| 2.5s | 60s | 612,158 | 272,659 | +12,136 | 691,204 | 238,632 | +57,221 | 612,158 | fail_both |
| 5s | 15s | 730,448 | 202,799 | +6,613 | 783,131 | 173,283 | +42,480 | 730,448 | fail_both |
| 5s | 30s | 745,341 | 190,773 | +22,883 | 790,738 | 168,361 | +50,907 | 745,341 | fail_both |
| 5s | 60s | 757,628 | 182,503 | +35,124 | 799,158 | 162,869 | +58,447 | 757,628 | fail_both |
| 10s | 15s | 827,264 | 138,019 | +11,126 | 857,750 | 118,926 | +36,304 | 827,264 | pass_both |
| 10s | 30s | 841,196 | 125,224 | +26,604 | 865,442 | 112,631 | +44,017 | 841,196 | pass_both |
| 10s | 60s | 850,897 | 118,378 | +35,299 | 871,938 | 107,556 | +49,888 | 850,897 | pass_both |
| 15s | 15s | 867,307 | 107,753 | +10,657 | 890,892 | 93,277 | +31,266 | 867,307 | pass_both |
| 15s | 30s | 881,239 | 96,339 | +23,514 | 896,982 | 88,007 | +37,468 | 881,239 | pass_both |
| 15s | 60s | 889,636 | 90,048 | +30,926 | 902,218 | 83,400 | +42,668 | 889,636 | pass_both |

Best cell definition:

```text
highest min(Feb25_share, Feb24_share)
tie-breaker 1: lower average MAE
tie-breaker 2: closer-to-zero average signed bias
```

Best cell: `15s / 60s`.

## Best-cell ranking

| Fill horizon | Lookback | Feb25 share | Feb24 share | Min share | Avg MAE | Avg absolute bias |
|---:|---:|---:|---:|---:|---:|---:|
| 15s | 60s | 889,636 | 902,218 | 889,636 | 86,724 | 36,797 |
| 15s | 30s | 881,239 | 896,982 | 881,239 | 92,173 | 30,491 |
| 15s | 15s | 867,307 | 890,892 | 867,307 | 100,515 | 20,962 |
| 10s | 60s | 850,897 | 871,938 | 850,897 | 112,967 | 42,594 |
| 10s | 30s | 841,196 | 865,442 | 841,196 | 118,928 | 35,310 |
| 10s | 15s | 827,264 | 857,750 | 827,264 | 128,472 | 23,715 |
| 5s | 60s | 757,628 | 799,158 | 757,628 | 172,686 | 46,786 |
| 5s | 30s | 745,341 | 790,738 | 745,341 | 179,567 | 36,895 |
| 5s | 15s | 730,448 | 783,131 | 730,448 | 188,041 | 24,546 |
| 2.5s | 60s | 612,158 | 691,204 | 612,158 | 255,646 | 34,678 |
| 2.5s | 30s | 601,495 | 681,610 | 601,495 | 262,268 | 24,362 |
| 2.5s | 15s | 591,217 | 670,862 | 591,217 | 269,392 | 27,550 |

## Stratified breakdown for best cell

Best cell: `fill_horizon_ns=15_000_000_000`, `depletion_lookback_ns=60_000_000_000`.

Comparison baseline: current QFA-402c default policy (`5s / 30s`).

### Side

| Session | Side | Best-cell share | Current-policy share | Best-cell MAE | Current-policy MAE |
|---|---|---:|---:|---:|---:|
| 2026-02-25-rth | buy | 891,324 | 746,410 | 89,499 | 191,337 |
| 2026-02-25-rth | sell | 887,948 | 744,273 | 90,598 | 190,210 |
| 2026-02-24-rth | buy | 901,406 | 788,537 | 83,950 | 169,661 |
| 2026-02-24-rth | sell | 903,030 | 792,939 | 82,849 | 167,062 |

Side remains balanced; the improvement is not side-specific.

### Spread

| Session | Spread bucket | Best-cell share | Current-policy share | Best-cell MAE | Current-policy MAE |
|---|---|---:|---:|---:|---:|
| 2026-02-25-rth | 1 tick | 913,404 | 799,570 | 71,856 | 156,520 |
| 2026-02-25-rth | 2 ticks | 865,217 | 688,861 | 108,666 | 226,336 |
| 2026-02-25-rth | 3+ ticks | 846,938 | 826,530 | 140,281 | 165,954 |
| 2026-02-24-rth | 1 tick | 922,079 | 830,154 | 68,321 | 143,600 |
| 2026-02-24-rth | 2 ticks | 888,868 | 763,367 | 93,478 | 185,513 |
| 2026-02-24-rth | 3+ ticks | 916,974 | 865,313 | 75,072 | 123,755 |

The 2-tick spread gap from QFA-402c closes under the best policy.

### Queue-ahead

Queue-ahead is the visible MBP-1 queue-ahead proxy captured at probe generation time. It is not a new QFA-402 contract field.

| Session | Queue-ahead bucket | Best-cell share | Current-policy share | Best-cell MAE | Current-policy MAE |
|---|---|---:|---:|---:|---:|
| 2026-02-25-rth | 1-5 | 940,971 | 863,519 | 53,220 | 116,444 |
| 2026-02-25-rth | 6-20 | 860,178 | 673,135 | 110,693 | 235,405 |
| 2026-02-25-rth | 21+ | 471,910 | 247,191 | 441,311 | 586,810 |
| 2026-02-24-rth | 1-5 | 935,516 | 861,756 | 58,724 | 121,494 |
| 2026-02-24-rth | 6-20 | 878,811 | 739,424 | 100,562 | 201,848 |
| 2026-02-24-rth | 21+ | 505,263 | 336,842 | 429,128 | 574,181 |

The dominant QFA-402c failure bucket (`6-20`) passes under the best policy. The `21+` bucket remains poor but sparse (`267` probes on Feb25, `95` probes on Feb24), so it no longer controls the session-level gate.

### Time of day

| Session | Time bucket | Best-cell share | Current-policy share | Best-cell MAE | Current-policy MAE |
|---|---|---:|---:|---:|---:|
| 2026-02-25-rth | first 30m | 949,972 | 906,892 | 44,306 | 82,511 |
| 2026-02-25-rth | mid session | 883,036 | 727,715 | 94,795 | 202,048 |
| 2026-02-25-rth | last 30m | 901,944 | 777,777 | 83,546 | 174,951 |
| 2026-02-24-rth | first 30m | 949,694 | 905,780 | 45,543 | 84,061 |
| 2026-02-24-rth | mid session | 899,722 | 784,393 | 85,516 | 173,176 |
| 2026-02-24-rth | last 30m | 882,222 | 745,555 | 97,955 | 199,646 |

The QFA-402c mid-session/last-30m weakness is substantially reduced.

## Sensitivity analysis

### Marginal fill-horizon effect

Averaged across both sessions and all lookbacks:

| Fill horizon | Avg share | Min share | Avg MAE |
|---:|---:|---:|---:|
| 2.5s | 641,424 | 591,217 | 262,435 |
| 5s | 767,741 | 730,448 | 180,098 |
| 10s | 852,414 | 827,264 | 120,122 |
| 15s | 888,046 | 867,307 | 93,137 |

Fill horizon is the dominant axis. Moving from 5s to 10s flips every cell from fail-both to pass-both, and 15s improves further.

### Marginal depletion-lookback effect

Averaged across both sessions and all fill horizons:

| Depletion lookback | Avg share | Min share | Avg MAE |
|---:|---:|---:|---:|
| 15s | 777,359 | 591,217 | 171,605 |
| 30s | 788,005 | 601,495 | 163,234 |
| 60s | 796,855 | 612,158 | 157,006 |

Depletion lookback has a positive but secondary effect. It improves all fill-horizon rows, but it does not by itself rescue the 2.5s or 5s horizons.

Dominant axis: `fill_horizon_ns`.

## Runtime and resilience

Heap setting used:

```powershell
$env:NODE_OPTIONS='--max-old-space-size=8192'
```

Runtime and memory:

| Metric | Value |
|---|---:|
| Grid cells | 24 session/cell executions |
| Total runtime | 4,678,989 ms (77.98 minutes) |
| Max single-cell runtime | 309,780 ms (5.16 minutes) |
| Max cell peak RSS | 783 MB |
| Final process RSS | 433 MB |
| Checkpoint triggers | none |

All cells stayed below the 10-minute per-cell checkpoint and far below the 4 GB RSS checkpoint.

## Verdict

Verdict: `probe_policy_pass`.

Definition: at least one grid cell reaches `within_tolerance_share_ppm >= 800_000` on both clean Feb full-RTH sessions.

Best cell:

```text
fill_horizon_ns       = 15_000_000_000
depletion_lookback_ns = 60_000_000_000
```

The default `5s / 30s` policy failed both sessions; the best `15s / 60s` policy passes both sessions with wide margins.

## Recommendation

Next ticket: `QFA-402-walkthrough-2`.

Recommended decision topic:

- Lock `fill_horizon_ns=15_000_000_000` and `depletion_lookback_ns=60_000_000_000` as the QFA-402 probe policy, subject to coordinator policy review.
- Confirm whether `15s / 60s` should replace QFA-402 defaults or become a Phase 3 real-archive fidelity policy override.
- After walkthrough approval, dispatch `QFA-402-housekeeping-3` to switch QFA-402 from the old `mbp_proxy + 5s/30s` baseline to `mbp_trades_proxy + locked probe policy` and rerun the queue-fidelity smoke.

Phase 3 is not declared passed by QFA-402d. QFA-402d supplies the evidence needed for the policy walkthrough.

## Source and contract confirmation

- QFA-105 model source changes: none.
- QFA-402 formula/source changes: none.
- QFA-402c helper modifications: none.
- Threshold/tolerance changes: none.
- Target metric redefinition: none.
- RunSpec changes: none.
- Journal event changes: none.
- Validation policy changes: none.
- CI archive dependency: none.
- Mar session sweeps: none.
- TBBO incorporation: none.
- Streaming-throughput optimization: none.
