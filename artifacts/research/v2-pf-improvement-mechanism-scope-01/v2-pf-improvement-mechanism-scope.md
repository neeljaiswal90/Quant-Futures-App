# V2-PF-IMPROVEMENT-MECHANISM-SCOPE-01 artifact

## Baseline PF gap

| Item | Value |
| --- | --- |
| Trades | 1098 |
| Gross profit | $9,455.00 |
| Gross loss | -$7,613.00 |
| Net PnL | $1,842.00 |
| Artifact PF | 1.241954 |
| Loss reduction to PF 1.35 | $609.30 |
| Profit increase to PF 1.35 | $822.55 |

## Candidate mechanism summary

| Candidate | Timing | Remaining trades | Remaining PF | Remaining net | Removed trades | Removed fraction | LD-PF-5 pass | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| exclude_time_tier_C_late_am | pre_entry | 736 | 1.359500 | $1,797.50 | 362 | 32.969% | true | eligible |
| diagnostic_exit_stop_loss | outcome_only | 331 | 445.619048 | $9,337.00 | 767 | 69.854% | false | removes_more_than_50pct; not_ld_pf5_eligible_outcome_only |
| diagnostic_mae_le_minus_2000 | outcome_only | 802 | 2.616861 | $5,686.50 | 296 | 26.958% | false | not_ld_pf5_eligible_outcome_only |
| diagnostic_first_minute_close_le_minus_400 | diagnostic_only | 896 | 1.808672 | $4,112.50 | 202 | 18.397% | false | not_ld_pf5_eligible_diagnostic_only |
| exclude_signed_shock_3 | pre_entry | 180 | 1.472498 | $713.00 | 918 | 83.607% | false | remaining_trades_below_300; removes_more_than_50pct |
| exclude_regime_low | coverage_dependent | 607 | 1.389141 | $1,842.00 | 491 | 44.718% | false | not_ld_pf5_eligible_coverage_dependent |
| exclude_unknown_zero_probe | coverage_dependent | 607 | 1.389141 | $1,842.00 | 491 | 44.718% | false | not_ld_pf5_eligible_coverage_dependent |
| exclude_vix_0_67_0_85 | pre_entry | 889 | 1.321140 | $1,944.50 | 209 | 19.035% | false | pf_below_1_35 |
| exclude_vix_0_25_0_50 | pre_entry | 758 | 1.320989 | $1,811.50 | 340 | 30.965% | false | pf_below_1_35 |
| exclude_low_2_tick_1_5 | coverage_dependent | 989 | 1.293862 | $2,025.00 | 109 | 9.927% | false | pf_below_1_35; not_ld_pf5_eligible_coverage_dependent |
| exclude_low_2_tick_6_20 | coverage_dependent | 867 | 1.288439 | $1,807.50 | 231 | 21.038% | false | pf_below_1_35; not_ld_pf5_eligible_coverage_dependent |
| exclude_vix_0_25 | pre_entry | 947 | 1.279353 | $1,872.50 | 151 | 13.752% | false | pf_below_1_35 |

## Best candidate fidelity-category proof

| Side | Fidelity category | Trades | PF | Net PnL |
| --- | --- | --- | --- | --- |
| removed | clean | 220 | 1.094125 | $157.00 |
| removed | unknown_zero_probe | 142 | 0.880952 | -$112.50 |
| removed | unknown_missing_cell | 0 | undefined_no_pnl | $0.00 |
| removed | low_fidelity | 0 | undefined_no_pnl | $0.00 |
| remaining | clean | 387 | 1.549666 | $1,685.00 |
| remaining | unknown_zero_probe | 349 | 1.058155 | $112.50 |
| remaining | unknown_missing_cell | 0 | undefined_no_pnl | $0.00 |
| remaining | low_fidelity | 0 | undefined_no_pnl | $0.00 |

## Regime summary

| Regime | Trades | PF | Net PnL |
| --- | --- | --- | --- |
| high | 607 | 1.389141 | $1,842.00 |
| low | 491 | 1.000000 | $0.00 |

## Fidelity category summary

| Category | Trades | PF | Net PnL |
| --- | --- | --- | --- |
| clean | 607 | 1.389141 | $1,842.00 |
| unknown_zero_probe | 491 | 1.000000 | $0.00 |

## Determination

Determination: `REGISTERED_INACTIVE_VARIANT_SCOPE_JUSTIFIED`. Recommended next ticket: `V2-PF-REGISTERED-INACTIVE-VARIANT-SCOPE-01`.
