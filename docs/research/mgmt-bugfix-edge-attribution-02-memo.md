# MGMT-BUGFIX-EDGE-ATTRIBUTION-02 memo

## 1. Context

This ticket emits corrected-engine v2 evidence. It does NOT emit a verdict. It does NOT recommend activation, paper observation, or any roster mutation. Where the routing rules indicate operator escalation, the escalation is to coord+operator review of whether ADR-0024 LD-024-3 Step 4 reconciliation should be reopened, NOT to activation. v2 remains REGISTERED_INACTIVE regardless of the result.

Additionally: the corrected-engine selection metrics use `effective_trial_count=1` because the roster contains only v2. This is the correct metric for "does v2 individually pass thresholds" but is NOT equivalent to what v2 would receive under the canonical multi-strategy selection driver, which deflates DSR by the full roster trial count.

## 2. Substrate confirmation

- Base substrate: `origin/main@480bf1bcc2103911a2335a7a41abcccf0f505e55`.
- PR #280 corrected same-bar `max_adverse_r + stop` overlap before this regeneration.
- v2 remains registered-inactive; active/candidate rosters remain empty.

## 3. Artifact regeneration

- Strategy replayed explicitly: `regime_shock_reversion_short_v2`.
- Output path: `artifacts/held-out-validation/mgmt-bugfix-edge-attribution-02/regime_shock_reversion_short_v2-feb-mar-apr-2026.json`.
- Metadata path: `config/research/mgmt-bugfix-edge-attribution-02-metadata.json`.
- Parameter lock manifest: `artifacts/strategy-selection/qfa611-mgmt-bugfix-edge-attribution-02-parameter-locks.json`.

## 4. Byte-stability proof

| Output | SHA-256 |
|---|---|
| run A held-out artifact | `c9a29e1d6cdb6cc39d07976c2930153342c16ceb59c3145c0e981dd611fde927` |
| run B held-out artifact | `c9a29e1d6cdb6cc39d07976c2930153342c16ceb59c3145c0e981dd611fde927` |
| byte equal | `true` |

## 5. Anchor reconciliation

| Artifact | Trades | Net PnL cents | PF | SHA-256 |
|---|---:|---:|---:|---|
| pre-fix baseline (`e985b10`) | 528 | 199650 | 1.39515 | `ef268a431980b326a138707f632470b641004243a47bc2634888fad09e928703` |
| pre-correction post-fix (`origin/main` cycle3) | 572 | -18300 | 0.973182 | `b86b147aa5d3d3f7e43f0e5f7153f6516ff30125175f89660cc689c7469daed9` |
| post-correction regenerated | 1098 | 184200 | 1.241954 | `c9a29e1d6cdb6cc39d07976c2930153342c16ceb59c3145c0e981dd611fde927` |

## 6. Transition matrix highlights

- Pre-fix to post-correction matched pairs: `474` matched, `54` pre-only, `624` post-only.
- Total pre-fix to post-correction delta: `-15450` cents.
- Pre-correction to post-correction delta: `202500` cents.
- PR #277 identified `118` prior `stop_loss -> fail_safe` conversions; under the corrected engine, `110` route to `stop_loss` and `8` remain `fail_safe`.

## 7. Fail-safe subtype split

| Subtype | Trades | Net PnL cents | Avg net PnL cents |
|---|---:|---:|---:|
| `fail_safe:max_spread_ticks_exceeded` | 17 | 47650 | 2802.9411764706 |

## 8. MAE-severity proxy

The corrected artifact preserves only `17` fail-safe exits, all classified as `fail_safe:max_spread_ticks_exceeded`. The dominant PR #277 deterioration class was therefore not a persistent max-adverse fail-safe class under the corrected engine; most of that class returns to normal stop-loss handling.

## 9. Delta waterfall

| Step | Value |
|---|---:|
| `pre_fix_baseline` net | 199650 |
| `pre_correction_post_fix_delta` delta | -217950 |
| `pre_correction_post_fix` net | -18300 |
| `correction_recovery_vs_pre_correction` delta | 202500 |
| `post_correction` net | 184200 |
| `remaining_delta_vs_pre_fix` delta | -15450 |

## PROCESS-03 determinism

| Hash | Value |
|---|---|
| `final_chain_hash` | `169bd863874f91bb769561b8f5710277da8da322742c8a2016f22abea5b52673` |
| `final_phase2_hash` | `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b` |
| `final_phase4_hash` | `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090` |

Classification: `no_drift_same_worktree_fixture`. The regenerated research evidence is byte-stable, while the determinism fixture itself does not include the new attribution artifact tree; phase 2 and phase 4 remain pinned.

## 10. Authority caveat

This ticket emits corrected-engine v2 evidence. It does NOT emit a verdict. It does NOT recommend activation, paper observation, or any roster mutation. v2 remains REGISTERED_INACTIVE. ACTIVE and CANDIDATE rosters remain empty. ADR-0024 LD-024-3 Step 4 is not reopened by this ticket.

## 11. Corrected-engine selection metrics

| Metric | Value |
|---|---:|
| `total_trades` | 1098 |
| `gross_profit_cents` | 945500 |
| `gross_loss_cents` | -761300 |
| `net_pnl_cents` | 184200 |
| `profit_factor` | 1.241954 |
| `annualized_return` | 0.1497367742 |
| `annualized_sharpe` | 3.5850250121 |
| `dsr_statistic` | 2.6922904579 |
| `dsr_probability` | 0.9964518444 |
| `psr_zero_null` | 0.9964518444 |
| `max_drawdown` | 0.00982 |
| `win_rate` | 0.475409 |
| `effective_trial_count` | 1 |

## 12. Per-gate pass/fail

| Gate | Pass |
|---|---|
| `drawdown_pass` | `true` |
| `dsr_pass` | `true` |
| `hurdle_pass` | `true` |
| `pf_pass` | `false` |
| `psr_zero_pass` | `true` |
| `regime_trade_pass` | `true` |
| `sensitivity_audit_pass` | `false` |
| `sharpe_pass` | `true` |
| `trade_count_pass` | `true` |

Gate pass count: `7/9`; `gates_evaluated: 9`.
Sensitivity audit is evaluable and fails because low-regime fidelity cells are missing/concentrated in the existing fidelity substrate.

## 13. Routing determination

- Routing code: `SIZING_RESEARCH_JUSTIFIED`.
- Basis: 1.20 <= PF 1.241954 < 1.35.
- Recommended next ticket: `SIZING-R1-POST-FIX-KELLY-TIERED-REDERIVATION-01`.

## 14. Recommended next ticket

Proceed with `SIZING-R1-POST-FIX-KELLY-TIERED-REDERIVATION-01` if coord/operator want to continue this family. The corrected engine restores v2 to a positive but still PF-gate-failing surface, so the next rational lane is sizing research, not activation or entry tuning.

