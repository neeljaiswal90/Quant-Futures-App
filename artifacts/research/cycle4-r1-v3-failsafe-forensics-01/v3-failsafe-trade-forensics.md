# v3 Fail-Safe Trade Forensics

Data-oriented companion artifact for `CYCLE4-R1-V3-FAILSAFE-FORENSICS-01`.

## Source

| Item | Value |
|---|---|
| Source artifact | `D:\Quant-futures-app-cycle4-r1-v3-pairwise-replay-01\artifacts\held-out-validation\cycle4-r1-v3-pairwise-replay-01\regime_shock_reversion_short_v3-feb-mar-apr-2026.json` |
| Source SHA-256 | `40c3941a3351fd915da9c40835268eaa076caac4e23f92fc985b47f69d6f83c2` |
| Trades | 889 |
| Exit reason integrity | `pass` |

## Exit reason breakdown

| Exit reason | Count | Net PnL | Avg | Median | P10 | P90 | Median hold sec | Avg MFE | Avg MAE |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `stop_loss` | 363 | -$3,131.50 | -$8.63 | -$10.00 | -$18.50 | $0.50 | 119.7 | $12.55 | -$14.90 |
| `target` | 259 | $7,420.00 | $28.65 | $23.00 | $18.00 | $47.20 | 120.0 | $41.14 | -$4.92 |
| `fail_safe` | 262 | -$5,324.50 | -$20.32 | -$18.25 | -$37.95 | -$9.55 | 60.2 | $10.31 | -$29.80 |
| `session_close` | 5 | $10.00 | $2.00 | $2.00 | $0.50 | $3.70 | 60.0 | $4.20 | -$2.90 |

## Window concentration

| Window | Trades | Fail-safe | Fail-safe net | Targets | Target net | Net PnL | Fail-safe fraction |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 106 | 41 | -$481.50 | 41 | $1,934.00 | $1,152.00 | 38.68% |
| 2 | 117 | 32 | -$1,277.00 | 39 | $1,610.00 | -$341.00 | 27.35% |
| 3 | 54 | 10 | -$171.50 | 12 | $276.00 | -$168.50 | 18.52% |
| 4 | 121 | 42 | -$922.00 | 33 | $769.00 | -$470.50 | 34.71% |
| 5 | 214 | 55 | -$977.50 | 68 | $1,448.00 | -$178.00 | 25.70% |
| 6 | 277 | 82 | -$1,495.00 | 66 | $1,383.00 | -$1,020.00 | 29.60% |

## Top fail-safe sessions by loss

| Session | Trades | Fail-safe | Fail-safe net | Total net | Primary pct | VXN pct |
|---|---:|---:|---:|---:|---:|---:|
| `2026-03-31-rth` | 92 | 28 | -$1,139.50 | -$473.00 | 0.983333 | 0.983333 |
| `2026-04-09-rth` | 121 | 42 | -$922.00 | -$470.50 | 0.533333 | 0.483333 |
| `2026-04-24-rth` | 119 | 35 | -$753.00 | -$525.00 | 0.35 | 0.233333 |
| `2026-04-22-rth` | 74 | 25 | -$400.50 | -$286.50 | 0.383333 | 0.35 |
| `2026-04-28-rth` | 58 | 21 | -$351.00 | -$293.00 | 0.166667 | 0.166667 |
| `2026-04-16-rth` | 41 | 15 | -$335.50 | -$41.00 | 0.266667 | 0.183333 |
| `2026-04-27-rth` | 83 | 23 | -$310.00 | -$156.50 | 0.25 | 0.233333 |
| `2026-03-24-rth` | 35 | 7 | -$241.00 | $337.00 | 0.933333 | 0.916667 |
| `2026-04-20-rth` | 74 | 13 | -$217.00 | -$67.50 | 0.15 | 0.133333 |
| `2026-04-08-rth` | 54 | 10 | -$171.50 | -$168.50 | 0.85 | 0.85 |
| `2026-03-23-rth` | 21 | 3 | -$135.50 | $395.00 | 0.95 | 0.95 |
| `2026-03-19-rth` | 49 | 31 | -$105.00 | $419.50 | 0.933333 | 0.933333 |
| `2026-03-25-rth` | 12 | 3 | -$89.50 | -$61.50 | 0.95 | 0.916667 |
| `2026-04-23-rth` | 17 | 3 | -$81.00 | -$45.50 | 0.3 | 0.316667 |
| `2026-03-30-rth` | 7 | 1 | -$48.00 | $59.00 | 1.0 | 1.0 |

## Regime

| Regime | Trades | Fail-safe | Fail-safe fraction | Net PnL | Fail-safe net |
|---|---:|---:|---:|---:|---:|
| `high` | 398 | 125 | 31.41% | $172.00 | -$2,852.00 |
| `low` | 491 | 137 | 27.90% | -$1,198.00 | -$2,472.50 |

## Spread bucket

| Spread bucket | Trades | Fail-safe | Fail-safe fraction | Net PnL | Fail-safe net |
|---|---:|---:|---:|---:|---:|
| `1-tick` | 144 | 32 | 22.22% | $21.50 | -$609.50 |
| `2-tick` | 592 | 173 | 29.22% | -$1,444.00 | -$3,898.50 |
| `3+ ticks` | 153 | 57 | 37.25% | $396.50 | -$816.50 |

## Queue-ahead bucket

| Queue-ahead bucket | Trades | Fail-safe | Fail-safe fraction | Net PnL | Fail-safe net |
|---|---:|---:|---:|---:|---:|
| `1-5` | 484 | 140 | 28.93% | $371.50 | -$2,549.50 |
| `21+` | 1 | 0 | 0.00% | $17.00 | $0.00 |
| `6-20` | 404 | 122 | 30.20% | -$1,414.50 | -$2,775.00 |

## Worst fail-safe trades

| Row | Session | Window | Net | Hold sec | MFE | MAE | Regime | Spread | Queue | Primary pct |
|---:|---|---:|---:|---:|---:|---:|---|---|---|---:|
| 646 | `2026-04-24-rth` | 6 | -$118.00 | 120.1 | $23.00 | -$130.00 | `low` | `2-tick` | `6-20` | 0.35 |
| 293 | `2026-04-09-rth` | 4 | -$117.00 | 60.2 | $5.50 | -$153.00 | `high` | `2-tick` | `6-20` | 0.533333 |
| 151 | `2026-03-31-rth` | 2 | -$110.00 | 60.0 | $8.50 | -$150.50 | `high` | `2-tick` | `6-20` | 0.983333 |
| 150 | `2026-03-31-rth` | 2 | -$98.50 | 60.1 | $1.50 | -$103.00 | `high` | `3+ ticks` | `6-20` | 0.983333 |
| 26 | `2026-03-19-rth` | 1 | -$74.50 | 59.8 | $10.50 | -$74.50 | `high` | `3+ ticks` | `1-5` | 0.933333 |
| 156 | `2026-03-31-rth` | 2 | -$70.00 | 60.0 | $21.00 | -$125.50 | `high` | `2-tick` | `1-5` | 0.983333 |
| 32 | `2026-03-19-rth` | 1 | -$67.00 | 59.6 | $0.00 | -$70.00 | `high` | `3+ ticks` | `1-5` | 0.933333 |
| 649 | `2026-04-24-rth` | 6 | -$63.50 | 60.1 | $1.50 | -$77.50 | `low` | `2-tick` | `6-20` | 0.35 |
| 3 | `2026-03-19-rth` | 1 | -$61.00 | 60.7 | $2.00 | -$73.50 | `high` | `3+ ticks` | `1-5` | 0.933333 |
| 146 | `2026-03-31-rth` | 2 | -$59.50 | 60.1 | $0.00 | -$61.50 | `high` | `2-tick` | `1-5` | 0.983333 |
| 28 | `2026-03-19-rth` | 1 | -$58.00 | 62.4 | $0.00 | -$66.50 | `high` | `3+ ticks` | `1-5` | 0.933333 |
| 64 | `2026-03-23-rth` | 1 | -$58.00 | 60.1 | $14.00 | -$63.00 | `high` | `2-tick` | `1-5` | 0.95 |
| 161 | `2026-03-31-rth` | 2 | -$53.00 | 60.0 | $15.50 | -$63.50 | `high` | `1-tick` | `1-5` | 0.983333 |
| 522 | `2026-04-20-rth` | 5 | -$53.00 | 60.5 | $1.00 | -$56.50 | `low` | `2-tick` | `6-20` | 0.15 |
| 89 | `2026-03-24-rth` | 1 | -$52.00 | 60.0 | $1.50 | -$58.00 | `high` | `3+ ticks` | `1-5` | 0.933333 |

## Evidence gaps

| Field | Status | Recommended fix |
|---|---|---|
| `trade_id_or_execution_id` | unavailable in current artifact | extend held-out artifact evidence surface |
| `entry_price` | unavailable in current artifact | extend held-out artifact evidence surface |
| `exit_price` | unavailable in current artifact | extend held-out artifact evidence surface |
| `vix_freshness` | unavailable in current artifact | extend held-out artifact evidence surface |
| `signed_shock_value` | unavailable in current artifact | extend held-out artifact evidence surface |
| `recent_signed_shock_values` | unavailable in current artifact | extend held-out artifact evidence surface |

## Improvement target

| Item | Value |
|---|---:|
| Break-even improvement | $1,026.00 |
| Gross-loss reduction for break-even | 11.39% |
| Average fail-safe losses to avoid for break-even | 50.5 |
| Actual PF pass threshold | 1.35 |

PF near 1.0 is a break-even target, not an ADR-0016 passing-verdict target.
