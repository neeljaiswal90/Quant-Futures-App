# CYCLE4-R1-V3-FIRST-MINUTE-MANAGEMENT-DIAGNOSTIC-01 Memo

## 1. Context

PR #274 reran v3 early-adverse diagnostics with the extended PR #273 evidence surface. It found no clean pre-entry separator, while the strongest causal early-post-entry signal was `first_minute_close_pnl_cents <= -400`.

This diagnostic tests whether a first-minute management rule remains strong under full counterfactual accounting across all exit classes. It is not a backtest and does not mutate v3, management profiles, strategy code, or any authority surface.

## 2. Source artifact provenance

| Item | Value |
|---|---|
| Source artifact | `artifacts/held-out-validation/cycle4-r1-v3-early-adverse-diagnostic-02/regime_shock_reversion_short_v3-feb-mar-apr-2026.json` |
| Source SHA-256 | `acc2ee2f27e08fab09bf0c21cbce5f409b86633a4df51782357a07b565e3476f` |
| Source schema | `schema_version: 1` |
| Strategy | `regime_shock_reversion_short_v3` |

The source artifact is the only evidence source for the diagnostic outputs.

## 3. Counterfactual accounting formula

Affected trades are trades with:

- `first_minute_observed = true`
- finite `first_minute_close_pnl_cents`
- `first_minute_close_pnl_cents <= threshold`

For affected trades, the diagnostic proxy uses:

```text
counterfactual_pnl_cents = first_minute_close_pnl_cents
delta_cents = counterfactual_pnl_cents - actual_net_pnl_cents
```

This is a diagnostic proxy only. It is not executable net PnL, not qfa-611 verdict evidence, and not a production backtest.

## 4. Anchor reconciliation

| Anchor | Expected | Actual | Status |
|---|---:|---:|---|
| Total trades | 889 | 889 | matched |
| Max-adverse-R fail-safes | 245 | 245 | matched |
| Spread fail-safes | 17 | 17 | matched |
| Targets | 259 | 259 | matched |
| Stop-loss exits | 363 | 363 | matched |
| Session-close exits | 5 | 5 | matched |
| Net PnL cents | -102600 | -102600 | matched |

All trades remain single-contract with `entry_quantity = 1` and `exit_quantity = 1`.

## 5. First-minute coverage

| Class | Total | Finite first-minute close | Coverage |
|---|---:|---:|---:|
| All trades | 889 | 438 | 49.27% |
| Max-adverse-R fail-safe | 245 | 114 | 46.53% |
| Target | 259 | 132 | 50.97% |
| Stop-loss | 363 | 181 | 49.86% |
| Spread fail-safe | 17 | 9 | 52.94% |
| Session close | 5 | 2 | 40.00% |

Trades without finite first-minute scalar fields were reported as non-observed and were not treated as pass, fail, zero PnL, or affected evidence.

## 6. Threshold sweep

| Threshold | Affected | Net delta cents | PF proxy | Target damage cents | Max-adverse delta cents | Stop-loss delta cents | Top1 session contribution |
|---:|---:|---:|---:|---:|---:|---:|---:|
| -100 | 203 | 41950 | 0.925829 | 48650 | 44800 | 45800 | 21.57% |
| -200 | 184 | 32400 | 0.915898 | 41000 | 32700 | 40700 | 27.57% |
| -300 | 171 | 27850 | 0.911570 | 34300 | 29300 | 32850 | 28.59% |
| -400 | 158 | 18400 | 0.901750 | 31800 | 21100 | 29100 | 31.66% |
| -500 | 136 | 12300 | 0.896326 | 22150 | 15100 | 19350 | 23.42% |
| -600 | 128 | 10900 | 0.894906 | 22150 | 15100 | 17950 | 23.15% |
| -800 | 104 | -4550 | 0.879336 | 22150 | 11200 | 6400 | 22.96% |
| -1000 | 79 | -3200 | 0.881755 | 12450 | 5300 | 3950 | 34.43% |

The best threshold is `<= -100`, but its estimated improvement is only `+41950` cents.

## 7. Best threshold full accounting

For `first_minute_close_pnl_cents <= -100`:

| Component | Value |
|---|---:|
| Affected trades | 203 |
| Actual net PnL cents | -102600 |
| Counterfactual proxy net PnL cents | -60650 |
| Net delta cents | 41950 |
| Break-even gap coverage | 40.89% |
| PF-pass gap coverage | 13.55% |
| PF proxy | 0.925829 |
| Target damage cents | 48650 |
| Max-adverse delta cents | 44800 |
| Stop-loss delta cents | 45800 |
| Session-close effect cents | 0 |

The rule helps max-adverse and stop-loss classes, but it does not cover the break-even gap once target damage is included.

## 8. Concentration

The best threshold is not top-one-session dominated:

| Session | Delta cents | Share of positive improvement |
|---|---:|---:|
| `2026-04-24-rth` | 11850 | 21.57% |
| `2026-03-31-rth` | 9250 | 16.83% |
| `2026-04-08-rth` | 7950 | 14.47% |

Top three sessions account for `52.87%` of positive improvement. This is not a top-one-session failure, but concentration is still material enough that any future work would need replay validation.

## 9. PF / break-even framing

PF near `1.0` is break-even only. It is not an ADR-0016 passing verdict.

Known targets from prior evidence:

| Target | Required improvement |
|---|---:|
| Break-even PF ≈ 1.0 | +102600 cents |
| PF pass threshold 1.35 | +309593 cents if gross profit unchanged |

The best threshold reaches only `+41950` cents, below both thresholds.

## 10. Decision output

Decision:

```text
NO_VARIANT_JUSTIFIED
```

Basis:

The best threshold does not clear break-even after full exit-class accounting. Target damage is large enough to blunt the max-adverse and stop-loss improvement.

## 11. Recommended next ticket

No immediate registered-inactive management variant is justified from this diagnostic.

If the operator wants to continue v3 research, the next ticket should be a narrower evidence/hypothesis ticket rather than implementation. Candidate direction:

```text
CYCLE4-R1-V3-FIRST-MINUTE-PATH-QUALITY-REVIEW-01
```

Purpose: inspect why first-minute close/adverse paths are only partially observed and whether a more complete causal path surface would materially alter the conclusion.

## 12. Verification

The JSON and Markdown diagnostic outputs were generated twice from clean paths and byte-compared.

Commands run:

```powershell
npx tsx scripts/research/cycle4-r1-v3-first-minute-management-diagnostic-01.mts
npx tsc -b tsconfig.json
npm run lint --if-present
npx tsx scripts/backtester/check-determinism.mts
```

PROCESS-03 classification: no runtime or journal drift expected. This ticket adds diagnostic research artifacts and a deterministic extractor only.

## 13. Authority caveat

This PR does not activate any strategy, does not authorize paper observation, does not authorize broker/live dispatch, does not authorize Phase 6, and does not mutate `ACTIVE_STRATEGY_IDS`.
