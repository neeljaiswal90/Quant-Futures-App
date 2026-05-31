# SENSITIVITY-AUDIT-FIDELITY-COVERAGE-01 artifact

## Source anchors

| Artifact | SHA-256 |
| --- | --- |
| v2 corrected-engine held-out | c9a29e1d6cdb6cc39d07976c2930153342c16ceb59c3145c0e981dd611fde927 |
| qfa-402c fidelity cells | fe17a87886ad7282292d4e1ed9e99fb51bb6c0e8a572475364568715614b8866 |

## qfa-611 sensitivity thresholds

| Threshold | Value |
| --- | --- |
| low_fidelity_share_ppm | 750000 |
| concentration_fraction | 0.3 |

## Fidelity inventory

| Regime | Total cells | Zero-probe cells | Nonzero cells | Low-fidelity nonzero cells |
| --- | --- | --- | --- | --- |
| high | 9 | 0 | 9 | 3 |
| low | 9 | 9 | 0 | 0 |
| mid | 9 | 9 | 0 | 0 |

## Category summary

| Category | Trades | Fraction | Net PnL | PF | Win rate | Exit reasons |
| --- | --- | --- | --- | --- | --- | --- |
| clean | 607 | 55.282% | $1,842.00 | 1.389141 | 49.918% | fail_safe:17, session_close:2, stop_loss:414, target:174 |
| low_fidelity | 0 | 0.000% | $0.00 | undefined_no_pnl | 0.000% | none |
| unknown_missing_cell | 0 | 0.000% | $0.00 | undefined_no_pnl | 0.000% | none |
| unknown_total | 491 | 44.718% | $0.00 | 1.000000 | 44.603% | session_close:4, stop_loss:353, target:134 |
| unknown_zero_probe | 491 | 44.718% | $0.00 | 1.000000 | 44.603% | session_close:4, stop_loss:353, target:134 |

## Top flagged cells

| Category | Regime | Spread | Queue | Trades | Fraction | Probe count | Share ppm | Net PnL |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| unknown_zero_probe | low | 2-tick | 6-20 | 231 | 21.038% | 0 | 0 | $34.50 |
| unknown_zero_probe | low | 2-tick | 1-5 | 109 | 9.927% | 0 | 0 | -$183.00 |
| unknown_zero_probe | low | 1-tick | 1-5 | 95 | 8.652% | 0 | 0 | $249.50 |
| unknown_zero_probe | low | 3+ ticks | 6-20 | 24 | 2.186% | 0 | 0 | -$95.00 |
| unknown_zero_probe | low | 3+ ticks | 1-5 | 21 | 1.913% | 0 | 0 | $27.00 |
| unknown_zero_probe | low | 1-tick | 6-20 | 10 | 0.911% | 0 | 0 | -$50.00 |
| unknown_zero_probe | low | 2-tick | 21+ | 1 | 0.091% | 0 | 0 | $17.00 |

## Determination

Route: `FIDELITY_COVERAGE_GAP_DOMINANT`. qfa-611 canonical reason remains `missing_cell_concentration`.

Recommended next ticket: `QFA-402C-FIDELITY-COVERAGE-EXTEND-01`.
