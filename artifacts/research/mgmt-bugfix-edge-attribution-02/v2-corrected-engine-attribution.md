# MGMT-BUGFIX-EDGE-ATTRIBUTION-02 v2 corrected-engine attribution

## Summary

- Post-correction v2 PF: `1.241954`
- Post-correction net PnL: `184200` cents ($1,842.00)
- Routing code: `SIZING_RESEARCH_JUSTIFIED`
- Gate pass count: `7/9`
- Effective trial count: `1`
- PROCESS-03 classification: `no_drift_same_worktree_fixture`
- final_chain_hash: `169bd863874f91bb769561b8f5710277da8da322742c8a2016f22abea5b52673`
- final_phase2_hash: `dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b`
- final_phase4_hash: `ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090`

## Artifact anchors

| artifact | sha256 | trades | net_pnl_cents | pf |
|---|---|---|---|---|
| pre_fix | ef268a431980b326a138707f632470b641004243a47bc2634888fad09e928703 | 528 | 199650 | 1.39515 |
| pre_correction_post_fix | b86b147aa5d3d3f7e43f0e5f7153f6516ff30125175f89660cc689c7469daed9 | 572 | -18300 | 0.973182 |
| post_correction | c9a29e1d6cdb6cc39d07976c2930153342c16ceb59c3145c0e981dd611fde927 | 1098 | 184200 | 1.241954 |

## Matched-pair availability

| comparison | matched | pre_only | post_only | total_delta_cents |
|---|---|---|---|---|
| pre -> pre_correction | 474 | 54 | 98 | -217950 |
| pre -> post_correction | 474 | 54 | 624 | -15450 |
| pre_correction -> post_correction | 572 | 0 | 526 | 202500 |

## Largest transition deltas: pre-fix -> post-correction

| pre_reason | post_reason | count | pre_net_pnl_cents | post_net_pnl_cents | delta_cents |
|---|---|---|---|---|---|
| stop_loss | stop_loss | 276 | -444850 | -352100 | 92750 |
| target | stop_loss | 23 | 70200 | 1150 | -69050 |
| stop_loss | fail_safe | 8 | -13300 | 13900 | 27200 |
| target | fail_safe | 6 | 20000 | 25900 | 5900 |
| session_close | stop_loss | 1 | -200 | 50 | 250 |
| session_close | session_close | 2 | 200 | 200 | 0 |
| target | target | 158 | 550100 | 550100 | 0 |

## Fail-safe subtype split

| reason | count | net_pnl_cents | average_net_pnl_cents |
|---|---|---|---|
| fail_safe:max_spread_ticks_exceeded | 17 | 47650 | 2802.9411764705883 |

## Threshold results

| gate | pass |
|---|---|
| drawdown_pass | true |
| dsr_pass | true |
| hurdle_pass | true |
| pf_pass | false |
| psr_zero_pass | true |
| regime_trade_pass | true |
| sensitivity_audit_pass | false |
| sharpe_pass | true |
| trade_count_pass | true |

## Authority caveat

This artifact reports corrected-engine v2 evidence only. It does not emit a verdict, mutate the roster, authorize paper/live/broker dispatch, or reopen ADR-0024 LD-024-3 Step 4.
