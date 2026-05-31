# SIZING-R1-POST-FIX-KELLY-TIERED-REDERIVATION-01 sizing evidence artifact

## Source artifact anchors

| Field | Observed |
| --- | --- |
| SHA-256 | c9a29e1d6cdb6cc39d07976c2930153342c16ceb59c3145c0e981dd611fde927 |
| Trades | 1098 |
| Net PnL | $1,842.00 |
| PF | 1.241954 |
| Stop-loss exits | 767 |
| Target exits | 308 |
| Fail-safe exits | 17 |
| Session-close exits | 6 |

## Trade distribution

| Metric | Value |
| --- | --- |
| Gross profit | $9,455.00 |
| Gross loss | -$7,613.00 |
| Average trade | $1.68 |
| Average win | $18.11 |
| Average loss unit | $13.22 |
| Win rate | 47.541% |
| Single-contract max drawdown | $491.00 |

## Generalized Kelly

| Item | Value |
| --- | --- |
| Point estimate | 6.215% |
| Return denominator | 1321.701389 cents average absolute losing trade |
| Feasible lower | -14.289% |
| Feasible upper | 43.334% |
| Boundary | interior |

Classic binary Kelly is not used as a recommendation basis because it collapses the realized distribution shape.

## Bootstrap robustness

| Mode | PF p05/p50/p95 | Net PnL p05/p50/p95 | Kelly p05/p50/p95 | P(K<0) | P(K<2.5%) | P(K<5%) |
| --- | --- | --- | --- | --- | --- | --- |
| i.i.d. | 1.097320 / 1.240230 / 1.404097 | $770.50 / $1,830.25 / $2,946.00 | 2.613% / 6.184% / 9.925% | 0.310% | 4.610% | 29.970% |
| session-block | 1.032178 / 1.232720 / 1.498624 | $240.45 / $1,769.75 / $3,788.10 | 1.010% / 6.016% / 11.069% | 2.410% | 12.680% | 36.560% |

## Time-of-day tiers

| Tier | UTC hours | n | PF | Win rate | Kelly | Sample warning |
| --- | --- | --- | --- | --- | --- | --- |
| A_open | 13,14 | 63 | 2.840593 | 61.905% | 20.189% | unstable: n=63 below predeclared floor 100 |
| B_morning | 15 | 150 | 1.109381 | 48.000% | 2.731% | acceptable_for_diagnostic_only |
| C_late_am | 16,17 | 362 | 1.017030 | 45.856% | 0.514% | acceptable_for_diagnostic_only |
| D_afternoon | 18,19 | 389 | 1.245961 | 46.787% | 6.891% | acceptable_for_diagnostic_only |
| E_close | 20 | 134 | 1.074301 | 47.015% | 2.937% | acceptable_for_diagnostic_only |

## Sizing simulations

| Simulation | Final equity | Return | Max DD | Mean risk | Ruin proxy |
| --- | --- | --- | --- | --- | --- |
| flat_0_5pct | $97,322.69 | 94.645% | 17.231% | 0.500% | no |
| flat_1_0pct | $178,251.07 | 256.502% | 31.984% | 1.000% | no |
| flat_2_0pct | $500,402.06 | 900.804% | 56.583% | 2.000% | yes |
| generalized_quarter_kelly | $324,956.71 | 549.913% | 45.758% | 1.554% | no |
| generalized_half_kelly | $1,199,306.06 | 2298.612% | 78.067% | 3.107% | yes |
| tier_tilted_1_0pct_baseline | $1,809,478.52 | 3518.957% | 32.381% | 1.000% | no |
| tier_tilted_2_0pct_baseline | $23,275,890.04 | 46451.780% | 58.228% | 2.000% | yes |

## Routing

Routing code: `SIZING_RESEARCH_EVIDENCE_SUPPORTED_BUT_NO_VERDICT_AUTHORITY`.

Sizing can change dollars, drawdown, and geometric growth. It does not change the underlying profit factor of the trade distribution. PR #281 left v2 below the ADR-0016 PF gate at PF 1.241954.
