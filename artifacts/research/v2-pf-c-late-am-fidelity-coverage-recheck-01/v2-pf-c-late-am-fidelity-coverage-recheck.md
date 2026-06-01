# V2-PF-C-LATE-AM-FIDELITY-COVERAGE-RECHECK-01 artifact

## Source artifact hashes

| Source | Hash convention | SHA-256 |
| --- | --- | --- |
| PR #286 held-out | raw | e77e7eef8b0dc588029fbb4318de399253dd64f1277ed4f0c05c5ba9b5192817 |
| PR #286 qfa-611 selection | raw | 97b2e5dd1bbbfd6faa48762a755b9fe023321096572ac6449034a8c4b3a32e15 |
| PR #283 fidelity coverage audit | raw | 15c1bb01e4a0f7402dbd882178400922c805f0d1f6dfe6723b46aa666380c007 |
| PR #283 fidelity coverage audit | LF-canonical | df20ca571747372a9bf8069ee59f207e73ab0bfb5452310e1a874937c96714ac |
| qfa-402c fidelity cells | raw | fe17a87886ad7282292d4e1ed9e99fb51bb6c0e8a572475364568715614b8866 |

## Clean vs unknown-cell performance

| Category | Trades | Fraction | Net PnL | PF | Win rate | Exit reasons |
| --- | --- | --- | --- | --- | --- | --- |
| clean | 388 | 52.503% | $1,637.00 | 1.529431 | 50.258% | fail_safe:17, session_close:2, stop_loss:254, target:115 |
| unknown_total | 351 | 47.497% | $147.00 | 1.075891 | 46.439% | session_close:4, stop_loss:248, target:99 |
| unknown_zero_probe | 351 | 47.497% | $147.00 | 1.075891 | 46.439% | session_close:4, stop_loss:248, target:99 |
| unknown_missing_cell | 0 | 0.000% | $0.00 | undefined_no_pnl | 0.000% | none |
| low_fidelity | 0 | 0.000% | $0.00 | undefined_no_pnl | 0.000% | none |

## PR #283 base-v2 comparison

| Metric | PR #283 base v2 | PR #286 variant | Delta |
| --- | --- | --- | --- |
| total trades | 1098 | 739 | -359 |
| unknown trades | 491 | 351 | -140 |
| unknown fraction | 44.718% | 47.497% | 2.779% |
| low-fidelity trades | 0 | 0 | 0 |
| low-fidelity fraction | 0.000% | 0.000% | 0.000% |

## Unknown-cell concentration

### Regime

| Value | Trades | Fraction | Net PnL | PF |
| --- | --- | --- | --- | --- |
| low | 351 | 47.497% | $147.00 | 1.075891 |

### Spread bucket

| Value | Trades | Fraction | Net PnL | PF |
| --- | --- | --- | --- | --- |
| 2-tick | 241 | 32.612% | -$58.50 | 0.958110 |
| 1-tick | 68 | 9.202% | $238.00 | 1.785479 |
| 3+ ticks | 42 | 5.683% | -$32.50 | 0.863158 |

### Queue-ahead bucket

| Value | Trades | Fraction | Net PnL | PF |
| --- | --- | --- | --- | --- |
| 6-20 | 184 | 24.899% | -$86.00 | 0.920260 |
| 1-5 | 166 | 22.463% | $216.00 | 1.251602 |
| 21+ | 1 | 0.135% | $17.00 | infinite_no_losses |

### UTC entry hour

| Value | Trades | Fraction | Net PnL | PF |
| --- | --- | --- | --- | --- |
| 18 | 98 | 13.261% | -$2.50 | 0.995602 |
| 19 | 98 | 13.261% | $145.00 | 1.298354 |
| 20 | 90 | 12.179% | -$8.50 | 0.981400 |
| 15 | 61 | 8.254% | -$33.50 | 0.918788 |
| 14 | 4 | 0.541% | $46.50 | 4.576923 |

### VIX percentile band

| Value | Trades | Fraction | Net PnL | PF |
| --- | --- | --- | --- | --- |
| 0.25-0.50 | 237 | 32.070% | $83.00 | 1.062359 |
| <0.25 | 114 | 15.426% | $64.00 | 1.105611 |

## Flagged cells

| Regime | Spread | Queue | Status | Trades | Fraction | Net PnL | PF |
| --- | --- | --- | --- | --- | --- | --- | --- |
| low | 1-tick | 1-5 | unknown | 62 | 8.390% | $259.00 | 1.990440 |
| low | 1-tick | 6-20 | unknown | 6 | 0.812% | -$21.00 | 0.493976 |
| low | 2-tick | 1-5 | unknown | 84 | 11.367% | -$82.00 | 0.841239 |
| low | 2-tick | 21+ | unknown | 1 | 0.135% | $17.00 | infinite_no_losses |
| low | 2-tick | 6-20 | unknown | 156 | 21.110% | $6.50 | 1.007386 |
| low | 3+ ticks | 1-5 | unknown | 20 | 2.706% | $39.00 | 1.484472 |
| low | 3+ ticks | 6-20 | unknown | 22 | 2.977% | -$71.50 | 0.544586 |

## Determination

Determination: `FIDELITY_COVERAGE_GAP_REMAINS_DOMINANT`.

Recommended next ticket: `QFA-402C-FIDELITY-COVERAGE-EXTEND-01`.
