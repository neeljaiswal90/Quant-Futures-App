# QFA-402c - Queue fidelity residual analysis

## Status

QFA-402c is an evidence/calibration ticket. It does not change queue-fidelity formulas, QFA-105, QFA-402, thresholds, tolerance bands, validation policy, RunSpec, journal events, or CI archive dependencies.

Final verdict: `probe_policy_adjustment_candidate`.

Reason: the upgraded `mbp_trades_proxy` evidence is not a structural miss, but the remaining failures concentrate in specific probe/model strata: wider 2-tick spreads, visible queue-ahead `6-20` and `21+`, mid-session/last-session windows, and low/mid synthesized-probability buckets that strongly underpredict realized MBO fill fraction. The next ticket should test probe policy and calibration choices before revisiting ADR-0011's locked threshold.

## Policy reference

ADR-0011 (`docs/adr/ADR-0011-qfa-402-queue-fidelity-threshold.md`) is the controlling policy document for this analysis.

Locked posture:

- Threshold remains `within_tolerance_share_ppm >= 800_000`.
- Tolerance remains `+/-100_000 ppm`.
- The original `800_000 / +/-100_000` posture was directional, not empirically calibrated.
- The proposed `720_000` relaxation is rescinded as post-hoc fitting.
- QFA-402c must analyze a second clean Feb full-RTH session.
- Mar analysis must attempt a deterministic 1800s prefix first and must not retry full RTH at 16 GB heap.

## Baseline from QFA-402b

| Session | Scope | Mode | within_tolerance_share_ppm | Threshold | Result | Notes |
|---|---|---|---:|---:|---|---|
| 2026-02-25-rth | full RTH | `mbp_trades_proxy` | 745,341 | 800,000 | FAIL | Direct clean Feb baseline, full session. |
| 2026-03-02-rth | 360s prefix | `mbp_trades_proxy` | 880,555 | 800,000 | PASS | Clean alternate-month prefix only. |
| aggregate | mixed | `mbp_trades_proxy` | 747,390 | 800,000 | FAIL | Feb full RTH dominates aggregate. |

QFA-402b also recorded the original QFA-402-h1 Feb baseline with `mbp_proxy` at `123,760 ppm`, so `mbp_trades_proxy` closed `621,581 ppm` of the empirical gap on 2026-02-25-rth.

## Session selection

| Label | Session | Scope | Rationale | MBO bytes | MBP-1 bytes | Trades bytes |
|---|---|---|---|---:|---:|---:|
| Feb baseline 1 | 2026-02-25-rth | full RTH | Required direct comparison against QFA-402b. | 320,413,947 | 260,716,753 | 7,574,875 |
| Feb baseline 2 | 2026-02-24-rth | full RTH | First preferred second clean Feb session with MBO + MBP-1 + trades present. | 533,946,832 | 421,540,003 | 10,829,515 |
| Mar clean prefix | 2026-03-02-rth | first 1800s | Clean early-March session outside the 2026-03-17..20 expiry-thinning zone. | 600,528,269 | 468,458,848 | 12,165,235 |

Avoided anomaly-zone sessions: `2026-03-17-rth`, `2026-03-18-rth`, `2026-03-19-rth`, `2026-03-20-rth`.

## Runtime and memory notes

The QFA-402c helper uses streaming DBN processing for probe generation and synthesis inputs. This intentionally avoids the QFA-402b whole-session materialization pattern that OOMed on full Mar 2026-03-02 under a 12 GB heap.

Heap setting used:

```powershell
$env:NODE_OPTIONS='--max-old-space-size=8192'
```

| Session | Probe generation | Synthesis | MBO reference replay | Compare/analyze | Total runtime | Peak RSS |
|---|---:|---:|---:|---:|---:|---:|
| 2026-02-25-rth | 19.3s | 125.1s | 58.1s | 0.3s | 202.8s | 609 MB |
| 2026-02-24-rth | 41.3s | 163.6s | 87.7s | 0.3s | 292.9s | 646 MB |
| 2026-03-02-rth 1800s | 6.6s | 29.4s | 12.9s | 0.0s | 48.9s | 646 MB |
| total | - | - | - | - | 544.6s | 646 MB |

Record counts consumed:

| Session | Probe-source MBP-1 | Synthesis MBP-1 | Synthesis trades | MBO replay records |
|---|---:|---:|---:|---:|
| 2026-02-25-rth | 13,718,048 | 13,718,048 | 473,009 | 19,799,241 |
| 2026-02-24-rth | 22,313,170 | 22,313,170 | 666,458 | 32,918,260 |
| 2026-03-02-rth 1800s | 3,761,448 | 3,772,894 | 140,978 | 5,850,986 |

## Headline results

| Session | Scope | Total probes | Comparable probes | Within tolerance | within_tolerance_share_ppm | Threshold | Result | Margin |
|---|---|---:|---:|---:|---:|---:|---|---:|
| 2026-02-25-rth | full RTH | 46,800 | 46,800 | 34,882 | 745,341 | 800,000 | FAIL | -54,659 |
| 2026-02-24-rth | full RTH | 46,798 | 46,798 | 37,005 | 790,738 | 800,000 | FAIL | -9,262 |
| 2026-03-02-rth | first 1800s | 3,598 | 3,598 | 3,188 | 886,047 | 800,000 | PASS | +86,047 |

Interpretation:

- Feb 2026-02-25 reproduces QFA-402b exactly at `745,341 ppm`.
- The second clean Feb full-RTH session lands much closer to the locked threshold at `790,738 ppm`, but still strictly fails.
- Clean Mar 1800s prefix passes at `886,047 ppm`, extending QFA-402b's 360s Mar-prefix pass from `880,555 ppm` to a wider deterministic window.
- The evidence argues against a structural queue-fidelity failure, but it also does not justify declaring Phase 3 pass under ADR-0011.

## Error distribution

`mean_squared_error_ppm2` is computed against realized fractional fill ppm targets, not a binary fill/no-fill conversion. It is Brier-style squared error over fractional realized-fill targets, with no attached gate threshold.

| Session | MAE ppm | Median abs error | p90 abs error | p95 abs error | Max abs error | Mean signed error | Median signed error | mean_squared_error_ppm2 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2026-02-25-rth | 190,773 | 0 | 1,000,000 | 1,000,000 | 1,000,000 | +22,883 | 0 | 163,828,693,784 |
| 2026-02-24-rth | 168,361 | 0 | 1,000,000 | 1,000,000 | 1,000,000 | +50,907 | 0 | 151,131,293,271 |
| 2026-03-02-rth 1800s | 104,550 | 0 | 600,000 | 1,000,000 | 1,000,000 | +67,601 | 0 | 100,680,615,160 |

Notes:

- Median absolute error is `0` for all windows because most probes are exact or near-exact full-fill matches.
- Tail error is severe (`p90`/`p95` often maxed at `1,000,000`) because remaining misses are concentrated in full miss/full fill disagreements.
- Mean signed error is positive in all windows, meaning the proxy is net overconfident, but the calibration table shows simultaneous underprediction in low/mid predicted buckets and overprediction in the high predicted bucket.

## Side stratification

| Session | Side | Comparable | within_tolerance_share_ppm | MAE ppm | Mean signed error |
|---|---|---:|---:|---:|---:|
| 2026-02-25-rth | buy | 23,400 | 746,410 | 191,337 | +30,659 |
| 2026-02-25-rth | sell | 23,400 | 744,273 | 190,210 | +15,106 |
| 2026-02-24-rth | buy | 23,399 | 788,537 | 169,661 | +46,829 |
| 2026-02-24-rth | sell | 23,399 | 792,939 | 167,062 | +54,986 |
| 2026-03-02-rth 1800s | buy | 1,799 | 886,047 | 107,662 | +79,109 |
| 2026-03-02-rth 1800s | sell | 1,799 | 886,047 | 101,439 | +56,093 |

Side is not the primary failure discriminator. Buy/sell shares are nearly symmetric.

## Spread stratification

| Session | Spread bucket | Comparable | within_tolerance_share_ppm | MAE ppm |
|---|---|---:|---:|---:|
| 2026-02-25-rth | 1 tick | 23,754 | 799,570 | 156,520 |
| 2026-02-25-rth | 2 ticks | 22,948 | 688,861 | 226,336 |
| 2026-02-25-rth | 3+ ticks | 98 | 826,530 | 165,954 |
| 2026-02-24-rth | 1 tick | 18,352 | 830,154 | 143,600 |
| 2026-02-24-rth | 2 ticks | 27,904 | 763,367 | 185,513 |
| 2026-02-24-rth | 3+ ticks | 542 | 865,313 | 123,755 |
| 2026-03-02-rth 1800s | 1 tick | 36 | 861,111 | 125,000 |
| 2026-03-02-rth 1800s | 2 ticks | 1,348 | 911,721 | 80,607 |
| 2026-03-02-rth 1800s | 3+ ticks | 2,214 | 870,822 | 118,795 |

Spread is a load-bearing discriminator in Feb full-RTH. The Feb failures are concentrated around 2-tick spread states, especially Feb 2026-02-25.

## Queue-ahead stratification

Queue-ahead here is a visible MBP-1 queue-ahead proxy captured at probe generation time: passive buy uses visible best-bid size, passive sell uses visible best-ask size. It is not a new QFA-402 contract field.

| Session | Queue-ahead bucket | Comparable | within_tolerance_share_ppm | MAE ppm |
|---|---|---:|---:|---:|
| 2026-02-25-rth | 1-5 | 18,347 | 863,519 | 116,444 |
| 2026-02-25-rth | 6-20 | 28,186 | 673,135 | 235,405 |
| 2026-02-25-rth | 21+ | 267 | 247,191 | 586,810 |
| 2026-02-24-rth | 1-5 | 19,943 | 861,756 | 121,494 |
| 2026-02-24-rth | 6-20 | 26,760 | 739,424 | 201,848 |
| 2026-02-24-rth | 21+ | 95 | 336,842 | 574,181 |
| 2026-03-02-rth 1800s | 1-5 | 3,231 | 891,364 | 100,361 |
| 2026-03-02-rth 1800s | 6-20 | 366 | 838,797 | 141,816 |
| 2026-03-02-rth 1800s | 21+ | 1 | 1,000,000 | 0 |

Queue-ahead is the clearest residual failure axis. The `1-5` queue-ahead bucket passes in both full Feb sessions; `6-20` misses, and `21+` is poor but sparse.

## Time-of-day stratification

| Session | Time bucket | Comparable | within_tolerance_share_ppm | MAE ppm |
|---|---|---:|---:|---:|
| 2026-02-25-rth | first 30m | 3,598 | 906,892 | 82,511 |
| 2026-02-25-rth | mid session | 39,602 | 727,715 | 202,048 |
| 2026-02-25-rth | last 30m | 3,600 | 777,777 | 174,951 |
| 2026-02-24-rth | first 30m | 3,598 | 905,780 | 84,061 |
| 2026-02-24-rth | mid session | 39,600 | 784,393 | 173,176 |
| 2026-02-24-rth | last 30m | 3,600 | 745,555 | 199,646 |
| 2026-03-02-rth 1800s | bounded prefix | 3,598 | 886,047 | 104,550 |

First 30 minutes are strong in both full Feb sessions. The full-session misses are dominated by mid-session and, for Feb24, last-30-minute behavior.

## Probability distributions

Reference probability distribution:

| Session | 0 | 1-100k | 100k-300k | 300k-700k | 700k-900k | 900k-1000k |
|---|---:|---:|---:|---:|---:|---:|
| 2026-02-25-rth | 5,792 | 0 | 0 | 0 | 0 | 41,008 |
| 2026-02-24-rth | 5,532 | 0 | 0 | 0 | 0 | 41,266 |
| 2026-03-02-rth 1800s | 312 | 0 | 0 | 0 | 0 | 3,286 |

Synthesized probability distribution:

| Session | 0 | 1-100k | 100k-300k | 300k-700k | 700k-900k | 900k-1000k |
|---|---:|---:|---:|---:|---:|---:|
| 2026-02-25-rth | 1,160 | 496 | 1,566 | 3,137 | 1,379 | 39,062 |
| 2026-02-24-rth | 863 | 299 | 1,071 | 1,944 | 901 | 41,720 |
| 2026-03-02-rth 1800s | 36 | 0 | 12 | 42 | 12 | 3,496 |

The MBO realized-fill target is effectively bimodal under the current passive probe policy: most reference outcomes are either `0` or `900k-1000k`. The synthesized path emits more graded low/mid probabilities. That mismatch drives many out-of-tolerance probes even when the qualitative direction is plausible.

## Reliability / calibration table

### 2026-02-25-rth full RTH

| Synthesized bucket | Count | Mean synthesized ppm | Mean reference ppm | Mean signed error ppm | within_tolerance_share_ppm |
|---|---:|---:|---:|---:|---:|
| 0 | 1,160 | 0 | 856,034 | -856,034 | 143,965 |
| 1-100k | 496 | 74,382 | 824,597 | -750,214 | 175,403 |
| 100k-300k | 1,566 | 205,681 | 828,863 | -623,182 | 0 |
| 300k-700k | 3,137 | 501,764 | 819,254 | -317,490 | 0 |
| 700k-900k | 1,379 | 801,784 | 844,815 | -43,031 | 39,883 |
| 900k-1000k | 39,062 | 999,443 | 885,080 | +114,363 | 885,080 |

### 2026-02-24-rth full RTH

| Synthesized bucket | Count | Mean synthesized ppm | Mean reference ppm | Mean signed error ppm | within_tolerance_share_ppm |
|---|---:|---:|---:|---:|---:|
| 0 | 863 | 0 | 888,760 | -888,760 | 111,239 |
| 1-100k | 299 | 78,736 | 892,977 | -814,240 | 107,023 |
| 100k-300k | 1,071 | 205,141 | 859,944 | -654,803 | 0 |
| 300k-700k | 1,944 | 503,128 | 873,457 | -370,329 | 0 |
| 700k-900k | 901 | 801,715 | 847,947 | -46,232 | 31,076 |
| 900k-1000k | 41,720 | 999,633 | 883,245 | +116,388 | 883,245 |

### 2026-03-02-rth first 1800s

| Synthesized bucket | Count | Mean synthesized ppm | Mean reference ppm | Mean signed error ppm | within_tolerance_share_ppm |
|---|---:|---:|---:|---:|---:|
| 0 | 36 | 0 | 972,222 | -972,222 | 27,777 |
| 1-100k | 0 | - | - | - | - |
| 100k-300k | 12 | 194,676 | 916,667 | -721,991 | 0 |
| 300k-700k | 42 | 511,186 | 976,190 | -465,004 | 0 |
| 700k-900k | 12 | 785,218 | 1,000,000 | -214,782 | 0 |
| 900k-1000k | 3,496 | 1,000,000 | 911,613 | +88,387 | 911,613 |

Reliability interpretation:

- High synthesized probabilities (`900k-1000k`) dominate probe volume and clear the 800k share in all analyzed windows.
- Low/mid synthesized buckets are sparse but highly miscalibrated under the current reference target. They usually correspond to realized MBO full-fill outcomes, so they fail tolerance by construction.
- This points toward a probe-policy/model-calibration question: the realized fill target is much more binary than the synthesized probability continuum.

## Comparison across clean Feb sessions

| Dimension | 2026-02-25-rth | 2026-02-24-rth | Interpretation |
|---|---:|---:|---|
| Full-RTH within share | 745,341 | 790,738 | Both strict FAIL; second clean Feb is near threshold. |
| Margin to threshold | -54,659 | -9,262 | Evidence is near-threshold, not a QFA-402-h1-style structural miss. |
| 1-tick spread share | 799,570 | 830,154 | 1-tick states are at or above threshold. |
| 2-tick spread share | 688,861 | 763,367 | 2-tick states drive much of the failure. |
| queue ahead 1-5 share | 863,519 | 861,756 | Small visible queue ahead passes consistently. |
| queue ahead 6-20 share | 673,135 | 739,424 | Medium visible queue ahead is the main residual gap. |
| first 30m share | 906,892 | 905,780 | Opening window passes strongly. |
| mid-session share | 727,715 | 784,393 | Mid-session drives Feb25 failure and nearly drives Feb24 failure. |

## Mar bounded-window result

Mar 2026-03-02 1800s prefix passes at `886,047 ppm`, widening QFA-402b's 360s prefix evidence (`880,555 ppm`) without attempting a full-RTH run. Full-RTH Mar remains a streaming/runtime question because QFA-402b already showed whole-session materialization can OOM on this session.

This Mar result is clean alternate-month evidence, not VIX-stratified stress evidence.

## Diagnosis

Likely findings:

- Structural failure: unlikely. `mbp_trades_proxy` remains a major improvement over `mbp_proxy`, and a second clean Feb full-RTH session misses the threshold by only `9,262 ppm`.
- Threshold-only failure: not proven. The failures are not uniformly distributed; they concentrate in visible queue-ahead and spread strata.
- Model/probe-policy issue: likely. The reference target is near-binary while the synthesized proxy emits graded probabilities, and low/mid predicted buckets systematically underpredict realized fill fraction.
- Runtime issue: partly resolved for analysis. Streaming helper kept peak RSS below 1 GB for this ticket. Production/full-Mar smoke still needs streaming-throughput work if full-RTH Mar evidence becomes required.

## Recommendation

Recommended next ticket: `QFA-402d-probe-policy-calibration`.

Proposed scope:

- Keep ADR-0011 threshold/tolerance unchanged while testing calibration knobs.
- Run deterministic sweeps over fill horizon and depletion lookback on the two clean Feb full-RTH sessions.
- Preserve `mbp_trades_proxy`; do not change QFA-105 model in the first pass.
- Evaluate whether failures in `6-20` queue-ahead and 2-tick spread strata are sensitive to probe policy.
- If probe-policy sweeps do not recover the gap, escalate to `model_improvement_required` with a focused QFA-105 calibration/model ticket.
- Only after those results should a threshold re-derivation walkthrough be reconsidered.

QFA-402c final verdict remains `probe_policy_adjustment_candidate`, not `phase3_pass`.

## Source and contract confirmation

- QFA-105 model source changes: none.
- QFA-402 formula/source changes: none.
- Threshold/tolerance changes: none.
- RunSpec changes: none.
- Journal event changes: none.
- CI archive dependency: none.
- Research artifact only, plus standalone helper script under `scripts/backtester/`.
