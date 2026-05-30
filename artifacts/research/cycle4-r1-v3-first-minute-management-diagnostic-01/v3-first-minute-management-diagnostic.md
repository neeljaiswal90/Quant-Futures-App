# CYCLE4-R1-V3-FIRST-MINUTE-MANAGEMENT-DIAGNOSTIC-01

## Source

- Source artifact: `artifacts/held-out-validation/cycle4-r1-v3-early-adverse-diagnostic-02/regime_shock_reversion_short_v3-feb-mar-apr-2026.json`
- SHA-256: `acc2ee2f27e08fab09bf0c21cbce5f409b86633a4df51782357a07b565e3476f`
- Counterfactual formula: affected trades use `first_minute_close_pnl_cents`; delta is proxy counterfactual minus actual net PnL.

## Anchor reconciliation

- Status: `matched`
- Total trades: `889`
- Net PnL cents: `-102600`

## Threshold sweep

| Threshold | Affected | Net delta | PF proxy | Target damage | Max-adverse delta | Top1 session concentration |
|---:|---:|---:|---:|---:|---:|---:|
| -100 | 203 | 41950 | 0.925829 | 48650 | 44800 | 21.57% |
| -200 | 184 | 32400 | 0.915898 | 41000 | 32700 | 27.57% |
| -300 | 171 | 27850 | 0.91157 | 34300 | 29300 | 28.59% |
| -400 | 158 | 18400 | 0.90175 | 31800 | 21100 | 31.66% |
| -500 | 136 | 12300 | 0.896326 | 22150 | 15100 | 23.42% |
| -600 | 128 | 10900 | 0.894906 | 22150 | 15100 | 23.15% |
| -800 | 104 | -4550 | 0.879336 | 22150 | 11200 | 22.96% |
| -1000 | 79 | -3200 | 0.881755 | 12450 | 5300 | 34.43% |

## Best threshold

- Threshold: `-100`
- Full-counterfactual proxy net delta: `41950` cents
- Target damage: `48650` cents
- Top one session concentration: `21.57%`

## Decision

- Decision: `NO_VARIANT_JUSTIFIED`
- Basis: best threshold does not clear break-even after full exit-class accounting, or target damage dominates

## Authority caveat

No activation, paper observation, broker/live dispatch, Phase 6 authority, ACTIVE roster mutation, strategy mutation, or management-profile mutation is authorized.
