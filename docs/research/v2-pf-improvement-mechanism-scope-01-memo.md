# V2-PF-IMPROVEMENT-MECHANISM-SCOPE-01 memo

## 1. Context

This diagnostic scopes whether corrected-engine v2 has a concrete pre-entry PF-improvement mechanism worth a future registered-inactive variant. It follows PR #281 corrected-engine evidence, PR #282 sizing evidence, and PR #283 sensitivity coverage attribution.

## 2. Source artifacts

| Artifact | Path | SHA-256 |
| --- | --- | --- |
| PR #281 v2 held-out | artifacts/held-out-validation/mgmt-bugfix-edge-attribution-02/regime_shock_reversion_short_v2-feb-mar-apr-2026.json | c9a29e1d6cdb6cc39d07976c2930153342c16ceb59c3145c0e981dd611fde927 |
| PR #283 sensitivity coverage | artifacts/research/sensitivity-audit-fidelity-coverage-01/v2-sensitivity-audit-fidelity-coverage.json | df20ca571747372a9bf8069ee59f207e73ab0bfb5452310e1a874937c96714ac |

## 3. Baseline PF gap

Baseline PF is 1.241954 on 1098 trades. Holding gross profit fixed, gross loss must fall by about $609.30 to reach PF 1.35. Holding gross loss fixed, gross profit must rise by about $822.55.

## 4. Feature inventory

| Field | Status | Timing |
| --- | --- | --- |
| regime | available | pre_entry |
| spread_bucket | available | pre_entry |
| queue_ahead_bucket | available | pre_entry |
| session_id | available | diagnostic_only |
| UTC entry hour / fixed time tier | derivable | pre_entry |
| vix_value | available | pre_entry |
| vix_fresh | available | pre_entry |
| vix_prior_close_percentile | available | pre_entry |
| signed_shock_vwap.value | available | pre_entry |
| signed_shock_vwap_recent_values | available | pre_entry |
| exit_reason / MAE / MFE / final PnL | available | outcome_only |
| first completed post-entry bar fields | partially_available | diagnostic_only |

## 5. Regime/fidelity/cell attribution

PR #283 category provenance is used as the authoritative fidelity source and was parity-checked against this trade set. Clean fidelity cells clear PF 1.35, while unknown zero-probe cells sit at PF 1.0. This is analytically useful but remains coverage-dependent.

## 6. Time/VIX/signed-shock attribution

The extractor evaluates only fixed packet-defined time tiers, VIX bands, and signed-shock buckets. It does not search arbitrary thresholds or combinations.

## 7. Candidate mechanism table

| Candidate | Timing | Remaining trades | Remaining PF | Removed fraction | LD-PF-5 pass | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| exclude_time_tier_C_late_am | pre_entry | 736 | 1.359500 | 32.969% | true | eligible |
| diagnostic_exit_stop_loss | outcome_only | 331 | 445.619048 | 69.854% | false | removes_more_than_50pct; not_ld_pf5_eligible_outcome_only |
| diagnostic_mae_le_minus_2000 | outcome_only | 802 | 2.616861 | 26.958% | false | not_ld_pf5_eligible_outcome_only |
| diagnostic_first_minute_close_le_minus_400 | diagnostic_only | 896 | 1.808672 | 18.397% | false | not_ld_pf5_eligible_diagnostic_only |
| exclude_signed_shock_3 | pre_entry | 180 | 1.472498 | 83.607% | false | remaining_trades_below_300; removes_more_than_50pct |
| exclude_regime_low | coverage_dependent | 607 | 1.389141 | 44.718% | false | not_ld_pf5_eligible_coverage_dependent |
| exclude_unknown_zero_probe | coverage_dependent | 607 | 1.389141 | 44.718% | false | not_ld_pf5_eligible_coverage_dependent |
| exclude_vix_0_67_0_85 | pre_entry | 889 | 1.321140 | 19.035% | false | pf_below_1_35 |
| exclude_vix_0_25_0_50 | pre_entry | 758 | 1.320989 | 30.965% | false | pf_below_1_35 |
| exclude_low_2_tick_1_5 | coverage_dependent | 989 | 1.293862 | 9.927% | false | pf_below_1_35; not_ld_pf5_eligible_coverage_dependent |
| exclude_low_2_tick_6_20 | coverage_dependent | 867 | 1.288439 | 21.038% | false | pf_below_1_35; not_ld_pf5_eligible_coverage_dependent |
| exclude_vix_0_25 | pre_entry | 947 | 1.279353 | 13.752% | false | pf_below_1_35 |

## 8. Diagnostic-only outcome findings

Outcome-only and early-post-entry fields were evaluated for explanation only. They do not justify a pre-entry variant and cannot satisfy LD-PF-5 in this ticket.

## 9. Determination

Determination: `REGISTERED_INACTIVE_VARIANT_SCOPE_JUSTIFIED`. The best non-coverage-dependent single pre-entry rule is `exclude_time_tier_C_late_am`, which passes LD-PF-5 with remaining PF 1.3595 on 736 trades. Coverage-dependent low-regime / zero-probe exclusions are explicitly not used as variant justification.

Best candidate fidelity-category proof:

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

## 10. Recommended next ticket

Recommended next ticket: `V2-PF-REGISTERED-INACTIVE-VARIANT-SCOPE-01`. If the operator wants to continue this lane, qfa-402c low-regime zero-probe coverage should be repaired before treating the PF drag as strategy logic.

## 11. Verification

The deterministic extractor writes the JSON artifact, Markdown artifact, memo, and backlog row. Required verification commands and hashes are reported in the worker PENDING-REVIEW note.

## 12. Authority caveat

`regime_shock_reversion_short_v2` remains REGISTERED_INACTIVE. This ticket does not implement a variant, mutate v2, change strategy/runtime/qfa/risk/sizing code, alter held-out artifacts, or create paper/live/broker/Phase 6/ADR authority.
