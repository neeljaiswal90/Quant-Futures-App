# MGMT-BUGFIX-EDGE-ATTRIBUTION-01

## Source anchors

- Pre-fix SHA: `ef268a431980b326a138707f632470b641004243a47bc2634888fad09e928703`
- Post-fix SHA: `b86b147aa5d3d3f7e43f0e5f7153f6516ff30125175f89660cc689c7469daed9`

## Trade availability

| Bucket | Count | Pre net | Post net | Delta |
|---|---:|---:|---:|---:|
| matched | 474 | 182150 | 44700 | -137450 |
| pre_only | 54 | 17500 | n/a | -17500 |
| post_only | 98 | n/a | -63000 | -63000 |

## Exit-reason transition matrix

| Pre | Post | Count | Pre net | Post net | Delta |
|---|---|---:|---:|---:|---:|
| session_close | session_close | 2 | 200 | 200 | 0 |
| session_close | stop_loss | 1 | -200 | 50 | 250 |
| stop_loss | fail_safe | 118 | -195850 | -344950 | -149100 |
| stop_loss | stop_loss | 166 | -262300 | -187750 | 74550 |
| target | fail_safe | 6 | 20000 | 25900 | 5900 |
| target | stop_loss | 23 | 70200 | 1150 | -69050 |
| target | target | 158 | 550100 | 550100 | 0 |

## Winner conversion

- target -> fail_safe count: `6`
- target -> fail_safe delta cents: `5900`
- target -> any loss count: `29`
- target -> any loss delta cents: `-63150`

## Path-quality proxy

- Classification: `MFE_MAE_SEVERITY_PROXY_ONLY`
- Exact guard-threshold classification: `UNAVAILABLE_IN_BASE_V1_ARTIFACT`
- Reason: base v1 artifact lacks per-trade risk, fail_safe subtype, adverse_r_at_exit, active_stop, and fail_safe_context; premature_cut cannot be proven or disproven from these fields

## Delta waterfall

| Step | Delta | Running net |
|---|---:|---:|
| pre_fix_net_pnl_cents | 0 | 199650 |
| matched_target_to_fail_safe | 5900 | 205550 |
| matched_target_to_stop_loss | -69050 | 136500 |
| matched_stop_loss_to_fail_safe | -149100 | -12600 |
| all_other_matched_transitions | 74800 | 62200 |
| remove_pre_only_entries | -17500 | 44700 |
| add_post_only_entries | -63000 | -18300 |

## Determination

- Code: `EVIDENCE_INSUFFICIENT`
- Basis: Base v1 artifacts cannot support exact guard subtype/path-quality classification, and winner conversion is not dominant enough for proxy determination.

## Authority caveat

This ticket changes no engine, strategy, parameter, roster, or authority. It attributes an already-merged verdict flip and does not re-open ADR-0024 LD-024-3 Step 4 verdict reconciliation, which remains coord+operator authority.
