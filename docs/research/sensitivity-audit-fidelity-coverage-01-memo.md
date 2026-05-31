# SENSITIVITY-AUDIT-FIDELITY-COVERAGE-01 memo

## 1. Context

PR #281 corrected-engine v2 evidence failed two Stage 1 gates: `pf_pass` and `sensitivity_audit_pass`. PR #282 showed sizing evidence is positive but cannot fix PF. This memo classifies the sensitivity-audit failure before PF-improvement research.

## 2. Source artifacts

| Artifact | Path | SHA-256 |
| --- | --- | --- |
| v2 corrected-engine held-out | artifacts/held-out-validation/mgmt-bugfix-edge-attribution-02/regime_shock_reversion_short_v2-feb-mar-apr-2026.json | c9a29e1d6cdb6cc39d07976c2930153342c16ceb59c3145c0e981dd611fde927 |
| qfa-402c fidelity cells | artifacts/regime-fidelity/qfa-402c-stratified-cells-v1.json | fe17a87886ad7282292d4e1ed9e99fb51bb6c0e8a572475364568715614b8866 |

## 3. qfa-611 sensitivity audit mechanism

Canonical qfa-611 uses cell key `(regime, spread_bucket, queue_ahead_bucket)`. Unknown means a missing fidelity cell or a defined cell with `probe_count == 0`. Low-fidelity means a nonzero-probe cell with `share_ppm < 750000`. Either unknown or low-fidelity concentration at or above `0.30` flags the audit.

The extractor reproduced the canonical Python qfa-611 helper exactly: parity = `true`, flag = `true`, reason = `missing_cell_concentration`. If both missing and low-fidelity flags were true, qfa-611 reason precedence would still report missing first; this diagnostic route is separate from that canonical reason.

## 4. Fidelity cell inventory

| Regime | Total cells | Zero-probe cells | Nonzero cells | Low-fidelity nonzero cells |
| --- | --- | --- | --- | --- |
| high | 9 | 0 | 9 | 3 |
| low | 9 | 9 | 0 | 0 |
| mid | 9 | 9 | 0 | 0 |

## 5. V2 occupancy by cell

v2 occupies 13 fidelity cells across 1098 trades. The top flagged cells are tabled in the companion Markdown artifact.

## 6. Unknown vs low-fidelity attribution

| Category | Trades | Fraction | Net PnL | PF |
| --- | --- | --- | --- | --- |
| unknown_missing_cell | 0 | 0.000% | $0.00 | undefined_no_pnl |
| unknown_zero_probe | 491 | 44.718% | $0.00 | 1.000000 |
| low_fidelity | 0 | 0.000% | $0.00 | undefined_no_pnl |
| clean | 607 | 55.282% | $1,842.00 | 1.389141 |

## 7. PnL/exit-reason by category

| Category | Exit reasons |
| --- | --- |
| clean | fail_safe:17, session_close:2, stop_loss:414, target:174 |
| low_fidelity | none |
| unknown_missing_cell | none |
| unknown_total | session_close:4, stop_loss:353, target:134 |
| unknown_zero_probe | session_close:4, stop_loss:353, target:134 |

## 8. Determination

Route: `FIDELITY_COVERAGE_GAP_DOMINANT`. Unknown cell concentration is 44.718%; low-fidelity concentration is 0.000%. The failure is a fidelity-substrate coverage gap, not observed low-fidelity execution fragility. The qfa-611 gate remains failed until the fidelity substrate is extended and qfa-611 is rerun.

## 9. Recommended next ticket

Recommended next ticket: `QFA-402C-FIDELITY-COVERAGE-EXTEND-01`, scoped to extend or refresh qfa-402c coverage for the zero-probe cells currently occupied by v2 trades. PF-improvement research should not treat the sensitivity-audit failure as execution fragility until coverage is repaired and canonical qfa-611 is rerun.

## 10. Verification

The deterministic extractor writes JSON, Markdown, memo, and backlog outputs; reproduces canonical qfa-611 sensitivity helper output; and preserves source artifact anchors. Required command results are reported in the worker PENDING-REVIEW note.

## 11. Authority caveat

`regime_shock_reversion_short_v2` remains REGISTERED_INACTIVE. This work does not change qfa-611, qfa-402c, strategy code, strategy roster, risk/sizing config, held-out artifacts, ADRs, paper observation, broker/live dispatch, or Phase 6 authority.
