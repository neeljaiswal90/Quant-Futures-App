# CYCLE4-R1-V3-MAX-ADVERSE-R-DIAGNOSTIC-01

## 1. Context

This memo records a diagnostic-only analysis of `regime_shock_reversion_short_v3` max-adverse-R fail-safe exits after PR #270 isolated the fail-safe subtype problem.

The strategy remains registered inactive. This work does not change strategy code, management code, strategy YAMLs, registries, qfa tooling, artifacts from prior tickets, ADRs, or any roster authority.

## 2. Source artifact provenance

Primary source artifact:

| Field | Value |
|---|---|
| Path | `artifacts/held-out-validation/cycle4-r1-v3-failsafe-forensics-02/regime_shock_reversion_short_v3-feb-mar-apr-2026.json` |
| SHA-256 | `30383348fbf6d3f014a1df09b05120e14f63fdedb832fb2ea053f9651a8a2329` |
| Strategy | `regime_shock_reversion_short_v3` |
| Prior forensics JSON SHA-256 | `735653bd460e8b206f53299bb41e1335c1ad1fda7ac40572bb5aef047188a676` |

Generated outputs:

| Output | SHA-256 |
|---|---|
| `artifacts/research/cycle4-r1-v3-max-adverse-r-diagnostic-01/v3-max-adverse-r-diagnostic.json` | `23483e4d7fa5672dd3180cd7e7603255398335e10c018ca61da7a1be29ed378f` |
| `artifacts/research/cycle4-r1-v3-max-adverse-r-diagnostic-01/v3-max-adverse-r-diagnostic.md` | `8109b20b04f6550a5cb129410ba05cf4a55b6d14633af0664e8085ba2b846777` |

The extractor generated JSON and Markdown twice from the same committed source artifact. Both outputs were byte-identical across runs.

## 3. Anchor reconciliation

| Anchor | Expected | Observed | Status |
|---|---:|---:|---|
| Total trades | 889 | 889 | pass |
| Fail-safe exits | 262 | 262 | pass |
| Max-adverse-R fail-safes | 245 | 245 | pass |
| Max-adverse-R net PnL cents | -580100 | -580100 | pass |
| Spread fail-safes | 17 | 17 | pass |
| Spread fail-safe net PnL cents | 47650 | 47650 | pass |
| Total net PnL cents | -102600 | -102600 | pass |
| Single-contract replay | true | true | pass |

All 889 trades have `entry_quantity = 1`, `exit_quantity = 1`, and one serialized exit, so `exits[].management_action_reason` is unambiguous for this diagnostic.

Zero-count non-implicated fail-safe classes:

| Reason class | Count |
|---|---:|
| `fail_safe:stale_market` | 0 |
| `fail_safe:profile_mismatch` | 0 |
| `fail_safe:invalid_market_price` | 0 |
| `fail_safe:missing_stop` | 0 |
| `fail_safe:invalid_quantity` | 0 |
| `fail_safe:invalid_target_position:*` | 0 |

## 4. Class definitions

Primary negative class:

```text
exit_reason = fail_safe
exits[].management_action_reason = fail_safe:max_adverse_r_exceeded
```

Comparison classes:

| Class | Definition |
|---|---|
| Target | `exit_reason = target` |
| Stop loss | `exit_reason = stop_loss` |
| Spread fail-safe | `exits[].management_action_reason = fail_safe:max_spread_ticks_exceeded` |

The v3 management profile's `fail_safe.max_adverse_r` threshold is `1.0`. The primary class contains trades that crossed that adverse-R guard.

## 5. Max-adverse-R loss anatomy

| Class | Trades | Net PnL cents | Avg PnL cents | Median PnL cents | Median hold min | Median MAE cents | Median MFE cents |
|---|---:|---:|---:|---:|---:|---:|---:|
| Max-adverse-R | 245 | -580100 | -2367.76 | -1900 | 1.0028 | -2400 | 650 |
| Target | 259 | 742000 | 2864.86 | 2300 | 1.9998 | -400 | 3450 |
| Stop loss | 363 | -313150 | -862.67 | -1000 | 1.9956 | -1300 | 1000 |
| Spread fail-safe | 17 | 47650 | 2802.94 | 2100 | 1.0047 | -1200 | 3550 |

The loss driver is not generic fail-safe behavior. It is specifically `fail_safe:max_adverse_r_exceeded`: 245 trades lose -$5,801.00, averaging -$23.68 per trade.

The max-adverse-R class is much worse than ordinary stop losses. Its median MAE is -$24.00 versus -$13.00 for stop losses and -$4.00 for targets.

## 6. Comparison against target / stop-loss / spread fail-safe

The target comparison shows a strong early-adverse-movement split: target winners have materially larger favorable excursion and limited adverse excursion, while max-adverse-R trades reach poor MAE quickly.

The stop-loss comparison suggests the max-adverse guard is catching a distinct severity class, not merely duplicating the ordinary stop-loss path. Max-adverse trades lose about 2.74x the average ordinary stop-loss trade.

The spread fail-safe comparison is especially important: spread fail-safes are profitable, with +$476.50 total and +$28.03 per trade average. The spread guard appears to protect captured profit during widened-spread moments. Relaxing the spread threshold would likely leak profit, not merely reduce fail-safe exits.

## 7. Candidate separator findings

| Feature | Observed separation | Usefulness | Confidence | Risk |
|---|---|---|---|---|
| Hold time under 2 minutes | Max-adverse 70.2%; target 51.74% | high diagnostic value | medium | material winner filtering risk |
| MAE severity | Max-adverse median MAE -2400 cents; target median MAE -400 cents | high diagnostic value | high | needs a pre-entry proxy |
| VIX percentile >= 0.85 | Max-adverse 26.94%; target 35.52% | mixed | medium | high winner filtering risk |
| Spread fail-safe comparison | Spread fail-safes are +47650 cents across 17 trades | avoid relaxing spread guard | high | relaxing guard could leak captured profit |
| Stop-loss comparison | Stop-loss avg -862.67 cents; max-adverse avg -2367.76 cents | management-threshold diagnostic value | high | needs threshold sensitivity replay before any change |

The high-VIX bucket is not a clean negative separator because targets also cluster there. A simple high-VIX exclusion would likely remove profitable trades.

## 8. Entry-quality vs management-threshold interpretation

The evidence supports an early adverse movement diagnosis, but it does not by itself prove whether the right next intervention is entry filtering or management-threshold tuning.

Entry-quality interpretation:

The max-adverse-R class is concentrated in short holds and much worse MAE. This aligns with the Cycle4 R2 chop-flip hypothesis, where sub-2-minute trades showed materially worse adverse excursion. If a future entry diagnostic can find a pre-entry proxy for this early adverse movement, the best next move may be a registered-inactive entry-quality variant.

Management-threshold interpretation:

The v3 threshold is `max_adverse_r = 1.0`, and 245 trades reach it. Because max-adverse exits are much worse than ordinary stop losses, threshold behavior may be acting as a severe-loss containment path. A future sensitivity replay could test whether changing this threshold improves realized PnL, but no threshold mutation is authorized by this diagnostic.

Current conclusion:

The best-supported next step is not immediate tuning. It is a narrow diagnostic that tests whether early adverse movement is predictable from serialized or newly extended pre-entry features.

## 9. Improvement target framing

Prior v3 evidence established:

| Target | Approx required improvement |
|---|---:|
| Break-even PF around 1.0 | +$1,026.00 |
| ADR-0016 PF pass threshold 1.35 | +$3,095.93 if gross profit is unchanged |

Break-even is not a passing verdict. A diagnostic or tuning idea must distinguish avoidable-loss feasibility, break-even feasibility, and actual ADR-0016 passing-verdict feasibility.

Avoiding roughly 43 average max-adverse-R losses would cover the break-even gap, but any candidate filter that also removes target winners needs an explicit tradeoff calculation.

## 10. Evidence gaps

Current evidence still lacks several useful fields for confident pre-entry attribution:

| Gap |
|---|
| Per-trade signed-shock value |
| Per-trade recent signed-shock values |
| Per-trade VIX value and VIX freshness |
| Per-trade primary percentile and VXN percentile |
| Unambiguous per-trade walk-forward `window_id` |
| Exact adverse-R scalar at exit |

The current artifact is strong enough to isolate the loss subtype and compare available outcomes. It is not yet strong enough to prove a specific entry filter before replaying or extending evidence.

## 11. Recommended next ticket

Recommended next ticket:

```text
CYCLE4-R1-V3-EARLY-ADVERSE-MOVEMENT-DIAGNOSTIC-01
```

Purpose:

Diagnose whether the max-adverse-R cohort is predictable before or immediately after entry using available feature context. If serialized context is insufficient, route a narrow evidence-surface extension for signed-shock, recent-shock, VIX freshness/value, regime percentiles, and exact adverse-R-at-exit.

Do not tune `max_adverse_r`, VIX bands, stop placement, or entry thresholds before that diagnostic.

## 12. Verification

Verification performed by the worker:

| Check | Result |
|---|---|
| Extractor run A/B byte equality for JSON | pass |
| Extractor run A/B byte equality for Markdown | pass |
| Source artifact SHA verified | pass |
| Anchor counts verified | pass |
| Single-contract replay verified | pass |
| Zero-count non-implicated fail-safe classes verified | pass |

Additional TypeScript and lint verification are reported in the worker Step 7 status.

## 13. Authority caveat

This PR does not activate any strategy, does not authorize paper observation, does not authorize broker/live dispatch, does not authorize Phase 6, and does not mutate `ACTIVE_STRATEGY_IDS`.

`regime_shock_reversion_short_v3` remains registered inactive and available only for explicit research replay.
