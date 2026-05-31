# SIZING-R1-POST-FIX-KELLY-TIERED-REDERIVATION-01 memo

## 1. Context

This memo re-derives Kelly and tiered-sizing evidence for `regime_shock_reversion_short_v2` using the corrected-engine PR #281 artifact. It is evidence only: no sizing policy, risk configuration, strategy code, roster state, paper observation, broker/live dispatch, Phase 6, ADR-0016, or ADR-0024 authority changes are made.

## 2. Source artifact

| Field | Value |
| --- | --- |
| Substrate | origin/main@10aee46cb1818366fb1785cb15da7cffb80db3bb |
| Artifact | artifacts/held-out-validation/mgmt-bugfix-edge-attribution-02/regime_shock_reversion_short_v2-feb-mar-apr-2026.json |
| SHA-256 | c9a29e1d6cdb6cc39d07976c2930153342c16ceb59c3145c0e981dd611fde927 |
| Trades | 1098 |
| Net PnL | $1,842.00 |
| PF | 1.241954 |

All trades are standard single-contract replay trades: every parsed trade has `entry_quantity = 1` and `exit_quantity = 1`.

## 3. Why prior sizing memo is stale

The prior sizing memo used the older 571-trade Cycle3 post-fix substrate. PR #281 regenerated the corrected-engine v2 evidence with 1098 trades, PF 1.241954, and +$1,842.00 net PnL. The older memo is retained as historical context only; this ticket uses the PR #281 artifact as the authoritative source.

## 4. Distribution summary

| Metric | Value |
| --- | --- |
| Trades | 1098 |
| Wins / losses / zero | 522 / 576 / 0 |
| Gross profit | $9,455.00 |
| Gross loss | -$7,613.00 |
| Average trade | $1.68 |
| Average win | $18.11 |
| Average loss unit | $13.22 |
| Win rate | 47.541% |

The field inventory was sufficient for this diagnostic: UTC entry hour, net PnL, quantities, session id, and chronological order are available. A native R-multiple field is not serialized, so generalized Kelly uses the fixed empirical average absolute losing-trade net loss as the declared return denominator.

## 5. Generalized Kelly result

The generalized log-utility Kelly point estimate is **6.215%**. The optimizer maximizes `mean(log(1 + f * r_i))`, where `r_i` is net PnL cents divided by the fixed loss-unit denominator of 1321.701389 cents.

Classic binary Kelly is intentionally not used as a recommendation basis because it ignores distribution shape and variance.

## 6. Bootstrap robustness

Bootstrap is deterministic: seed 611281, 10000 iterations, i.i.d. trade resampling plus session-block resampling that preserves chronological trades within sampled sessions.

| Mode | Kelly p05 | Kelly p50 | Kelly p95 | P(K<0) | P(K<2.5%) | P(K<5%) |
| --- | --- | --- | --- | --- | --- | --- |
| i.i.d. | 2.613% | 6.184% | 9.925% | 0.310% | 4.610% | 29.970% |
| session-block | 1.010% | 6.016% | 11.069% | 2.410% | 12.680% | 36.560% |

Both bootstrap modes keep the 5th percentile above zero, supporting continued sizing research as evidence. This is not sizing-policy authority.

## 7. Time-of-day tier analysis

| Tier | UTC hours | n | PF | Kelly | Warning |
| --- | --- | --- | --- | --- | --- |
| A_open | 13,14 | 63 | 2.840593 | 20.189% | unstable: n=63 below predeclared floor 100 |
| B_morning | 15 | 150 | 1.109381 | 2.731% | acceptable_for_diagnostic_only |
| C_late_am | 16,17 | 362 | 1.017030 | 0.514% | acceptable_for_diagnostic_only |
| D_afternoon | 18,19 | 389 | 1.245961 | 6.891% | acceptable_for_diagnostic_only |
| E_close | 20 | 134 | 1.074301 | 2.937% | acceptable_for_diagnostic_only |

The tiers are pre-specified from the packet and were not re-bucketed after observing results. Any tier-level interpretation remains diagnostic and sample-size-bounded.

## 8. Sizing simulations

Simulations compound from a fixed $50,000 diagnostic account basis. Each trade scales linearly from the empirical single-contract net PnL distribution using the same fixed loss-unit denominator. Drawdown is peak-to-trough equity drawdown; the ruin proxy trips if equity falls to zero or max drawdown reaches 50%.

| Simulation | Final equity | Return | Max DD | Ruin proxy |
| --- | --- | --- | --- | --- |
| flat_0_5pct | $97,322.69 | 94.645% | 17.231% | no |
| flat_1_0pct | $178,251.07 | 256.502% | 31.984% | no |
| flat_2_0pct | $500,402.06 | 900.804% | 56.583% | yes |
| generalized_quarter_kelly | $324,956.71 | 549.913% | 45.758% | no |
| generalized_half_kelly | $1,199,306.06 | 2298.612% | 78.067% | yes |
| tier_tilted_1_0pct_baseline | $1,809,478.52 | 3518.957% | 32.381% | no |
| tier_tilted_2_0pct_baseline | $23,275,890.04 | 46451.780% | 58.228% | yes |

These simulations illustrate dollars, drawdown, and geometric growth sensitivity. They do not authorize a deployable sizing policy.

## 9. What sizing can and cannot fix

Sizing can change dollars, drawdown, and geometric growth. It does not change the underlying profit factor of the trade distribution. PR #281 left v2 below the ADR-0016 PF gate at PF 1.241954.

The resulting route is `SIZING_RESEARCH_EVIDENCE_SUPPORTED_BUT_NO_VERDICT_AUTHORITY`: generalized Kelly is positive and the conservative bootstrap 5th percentile is positive, but the PF gate remains failed.

## 10. Recommended next ticket

Sizing research remains justified as evidence, but no sizing policy should be proposed from this memo alone. A future ticket, if desired, should be an explicit sizing-methodology scoping packet that separates evidence-supported capacity from ADR-authorized sizing policy.

## 11. Verification

The deterministic extractor regenerates the JSON artifact, Markdown artifact, memo, and backlog row. Required verification commands and determinism hashes are reported in the worker PENDING-REVIEW note.

## 12. Authority caveat

`regime_shock_reversion_short_v2` remains REGISTERED_INACTIVE. This PR does not activate any strategy, does not authorize paper observation, does not authorize broker/live dispatch, does not create Phase 6 authority, does not change ADR-0016/ADR-0024 authority, and does not set any sizing policy.
