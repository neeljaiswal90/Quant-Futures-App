# V2-PF-C-LATE-AM-FIDELITY-COVERAGE-RECHECK-01 memo

## 1. Context

`regime_shock_reversion_short_v2_utc_16_18_exclusion` reached qfa-611 `RESEARCH_FURTHER` in PR #286. It passed PF and the other stage-1 thresholds except sensitivity, which remained flagged by missing-cell concentration.

## 2. Source artifact provenance

| Source | Hash convention | SHA-256 |
| --- | --- | --- |
| PR #286 held-out | raw | e77e7eef8b0dc588029fbb4318de399253dd64f1277ed4f0c05c5ba9b5192817 |
| PR #286 qfa-611 selection | raw | 97b2e5dd1bbbfd6faa48762a755b9fe023321096572ac6449034a8c4b3a32e15 |
| PR #283 fidelity coverage audit | raw | 15c1bb01e4a0f7402dbd882178400922c805f0d1f6dfe6723b46aa666380c007 |
| PR #283 fidelity coverage audit | LF-canonical | df20ca571747372a9bf8069ee59f207e73ab0bfb5452310e1a874937c96714ac |
| qfa-402c fidelity cells | raw | fe17a87886ad7282292d4e1ed9e99fb51bb6c0e8a572475364568715614b8866 |

## 3. PR #286 sensitivity failure recap

| Field | Value |
| --- | --- |
| verdict | RESEARCH_FURTHER |
| verdict reason | one_or_two_thresholds_failed_within_20pct |
| sensitivity audit pass | false |
| qfa-611 reason | missing_cell_concentration |
| unknown-cell trades | 351 |
| unknown-cell fraction | 47.497% |
| low-fidelity trades | 0 |
| low-fidelity fraction | 0.000% |

## 4. Category-parity method

Each PR #286 held-out trade was mapped to qfa-611 sensitivity cell dimensions: `regime`, `spread_bucket`, and `queue_ahead_bucket`. The script then applied the qfa-402c cell rules used by qfa-611: missing cell or `probe_count == 0` is unknown; nonzero-probe `share_ppm < 750000` is low-fidelity; otherwise clean.

The reproduced category counts match the PR #286 selection JSON exactly: `351` unknown-cell trades and `0` low-fidelity trades.

## 5. Unknown-cell concentration findings

All unknown-cell trades are zero-probe qfa-402c cells, not missing cell keys. They are concentrated in low-regime cells and remain above the qfa-611 concentration threshold.

## 6. Clean vs unknown-cell performance

| Category | Trades | Fraction | Net PnL | PF | Win rate | Exit reasons |
| --- | --- | --- | --- | --- | --- | --- |
| clean | 388 | 52.503% | $1,637.00 | 1.529431 | 50.258% | fail_safe:17, session_close:2, stop_loss:254, target:115 |
| unknown_total | 351 | 47.497% | $147.00 | 1.075891 | 46.439% | session_close:4, stop_loss:248, target:99 |
| unknown_zero_probe | 351 | 47.497% | $147.00 | 1.075891 | 46.439% | session_close:4, stop_loss:248, target:99 |
| unknown_missing_cell | 0 | 0.000% | $0.00 | undefined_no_pnl | 0.000% | none |
| low_fidelity | 0 | 0.000% | $0.00 | undefined_no_pnl | 0.000% | none |

## 7. Comparison against PR #283 base-v2 coverage audit

| Metric | PR #283 base v2 | PR #286 variant | Delta |
| --- | --- | --- | --- |
| total trades | 1098 | 739 | -359 |
| unknown trades | 491 | 351 | -140 |
| unknown fraction | 44.718% | 47.497% | 2.779% |
| low-fidelity trades | 0 | 0 | 0 |

The UTC 16-18 exclusion reduces unknown-cell count, but not enough to clear qfa-611 sensitivity coverage. The remaining failure is still missing/zero-probe coverage, not observed low-fidelity fragility.

## 8. Determination

Determination: `FIDELITY_COVERAGE_GAP_REMAINS_DOMINANT`.

The standing qfa-611 verdict remains `RESEARCH_FURTHER`; this diagnostic does not override qfa-611.

## 9. Recommended next ticket

Recommended next ticket: `QFA-402C-FIDELITY-COVERAGE-EXTEND-01`.

## 10. Authority caveat

This is evidence-only. It changes no strategy code, strategy config/YAML, strategy registry, management profile, qfa-410b, qfa-611, qfa-402c, active roster, candidate roster, held-out artifact, selection artifact, ADR, paper/live/broker, or Phase 6 authority.
