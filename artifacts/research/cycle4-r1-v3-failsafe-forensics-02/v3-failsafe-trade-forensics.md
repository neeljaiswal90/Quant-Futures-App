# CYCLE4-R1-V3-FAILSAFE-FORENSICS-02 Artifact

Source artifact: `artifacts/held-out-validation/cycle4-r1-v3-failsafe-forensics-02/regime_shock_reversion_short_v3-feb-mar-apr-2026.json`

## Anchor reconciliation

| Metric | Value |
|---|---:|
| Total trades | 889 |
| Fail-safe exits | 262 |
| Net PnL cents | -102600 |

## Exit reason breakdown
| key | count | net_pnl_cents | avg_net_pnl_cents |
| --- | --- | --- | --- |
| stop_loss | 363 | -313150 | -862.67 |
| fail_safe | 262 | -532450 | -2032.25 |
| target | 259 | 742000 | 2864.86 |
| session_close | 5 | 1000 | 200 |

## Fail-safe reason breakdown
| key | count | net_pnl_cents | avg_net_pnl_cents |
| --- | --- | --- | --- |
| fail_safe:max_adverse_r_exceeded | 245 | -580100 | -2367.76 |
| fail_safe:max_spread_ticks_exceeded | 17 | 47650 | 2802.94 |

## Fail-safe market authority breakdown
| key | count | net_pnl_cents |
| --- | --- | --- |
| authoritative | 262 | -532450 |

## Window breakdown
| window_id | artifact_total_trades | fail_safe_trades | net_pnl_cents | note |
| --- | --- | --- | --- | --- |
| wf-1-1-2026-02-02-rth-2026-03-03-rth-2026-03-03-rth-2026-03-17-rth-2026-03-17-rth-2026-03-24-rth | 71 |  | 81500 | per-trade window_id is not serialized; overlapping walk-forward windows make session-range assignment ambiguous |
| wf-1-2-2026-02-09-rth-2026-03-10-rth-2026-03-10-rth-2026-03-24-rth-2026-03-24-rth-2026-03-31-rth | 60 |  | 46900 | per-trade window_id is not serialized; overlapping walk-forward windows make session-range assignment ambiguous |
| wf-1-3-2026-02-17-rth-2026-03-17-rth-2026-03-17-rth-2026-03-31-rth-2026-03-31-rth-2026-04-08-rth | 92 |  | -47300 | per-trade window_id is not serialized; overlapping walk-forward windows make session-range assignment ambiguous |
| wf-1-4-2026-02-24-rth-2026-03-24-rth-2026-03-24-rth-2026-04-08-rth-2026-04-08-rth-2026-04-15-rth | 175 |  | -63900 | per-trade window_id is not serialized; overlapping walk-forward windows make session-range assignment ambiguous |
| wf-1-5-2026-03-03-rth-2026-03-31-rth-2026-03-31-rth-2026-04-15-rth-2026-04-15-rth-2026-04-22-rth | 140 |  | 10850 | per-trade window_id is not serialized; overlapping walk-forward windows make session-range assignment ambiguous |
| wf-1-6-2026-03-10-rth-2026-04-08-rth-2026-04-08-rth-2026-04-22-rth-2026-04-22-rth-2026-04-29-rth | 351 |  | -130650 | per-trade window_id is not serialized; overlapping walk-forward windows make session-range assignment ambiguous |

## Worst fail-safe trades
| trade_id | session_id | net_pnl_cents | reason | market_authority | mark_price | active_stop_price |
| --- | --- | --- | --- | --- | --- | --- |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-6-2026-03-10-rth-2026-04-08-rth-2026-04-08-rth-2026-04-22-rth-2026-04-22-rth-2026-04-29-rth-108 | 2026-04-24-rth | -11800 | fail_safe:max_adverse_r_exceeded | authoritative | 27386.25 | 27327 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-4-2026-02-24-rth-2026-03-24-rth-2026-03-24-rth-2026-04-08-rth-2026-04-08-rth-2026-04-15-rth-70 | 2026-04-09-rth | -11700 | fail_safe:max_adverse_r_exceeded | authoritative | 25126.25 | 25073.5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-3-2026-02-17-rth-2026-03-17-rth-2026-03-17-rth-2026-03-31-rth-2026-03-31-rth-2026-04-08-rth-20 | 2026-03-31-rth | -11000 | fail_safe:max_adverse_r_exceeded | authoritative | 23723 | 23677 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-3-2026-02-17-rth-2026-03-17-rth-2026-03-17-rth-2026-03-31-rth-2026-03-31-rth-2026-04-08-rth-19 | 2026-03-31-rth | -9850 | fail_safe:max_adverse_r_exceeded | authoritative | 23614.75 | 23574.5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-1-2026-02-02-rth-2026-03-03-rth-2026-03-03-rth-2026-03-17-rth-2026-03-17-rth-2026-03-24-rth-26 | 2026-03-19-rth | -7450 | fail_safe:max_adverse_r_exceeded | authoritative | 24360 | 24330.75 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-3-2026-02-17-rth-2026-03-17-rth-2026-03-17-rth-2026-03-31-rth-2026-03-31-rth-2026-04-08-rth-25 | 2026-03-31-rth | -7000 | fail_safe:max_adverse_r_exceeded | authoritative | 23794.75 | 23769.75 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-1-2026-02-02-rth-2026-03-03-rth-2026-03-03-rth-2026-03-17-rth-2026-03-17-rth-2026-03-24-rth-32 | 2026-03-19-rth | -6700 | fail_safe:max_adverse_r_exceeded | authoritative | 24442.5 | 24417.25 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-6-2026-03-10-rth-2026-04-08-rth-2026-04-08-rth-2026-04-22-rth-2026-04-22-rth-2026-04-29-rth-111 | 2026-04-24-rth | -6350 | fail_safe:max_adverse_r_exceeded | authoritative | 27404 | 27379.25 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-1-2026-02-02-rth-2026-03-03-rth-2026-03-03-rth-2026-03-17-rth-2026-03-17-rth-2026-03-24-rth-3 | 2026-03-19-rth | -6100 | fail_safe:max_adverse_r_exceeded | authoritative | 24302.25 | 24286.25 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-3-2026-02-17-rth-2026-03-17-rth-2026-03-17-rth-2026-03-31-rth-2026-03-31-rth-2026-04-08-rth-15 | 2026-03-31-rth | -5950 | fail_safe:max_adverse_r_exceeded | authoritative | 23563 | 23542.25 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-1-2026-02-02-rth-2026-03-03-rth-2026-03-03-rth-2026-03-17-rth-2026-03-17-rth-2026-03-24-rth-28 | 2026-03-19-rth | -5800 | fail_safe:max_adverse_r_exceeded | authoritative | 24399 | 24378 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-1-2026-02-02-rth-2026-03-03-rth-2026-03-03-rth-2026-03-17-rth-2026-03-17-rth-2026-03-24-rth-64 | 2026-03-23-rth | -5800 | fail_safe:max_adverse_r_exceeded | authoritative | 24675.5 | 24658.75 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-3-2026-02-17-rth-2026-03-17-rth-2026-03-17-rth-2026-03-31-rth-2026-03-31-rth-2026-04-08-rth-30 | 2026-03-31-rth | -5300 | fail_safe:max_adverse_r_exceeded | authoritative | 23832 | 23815.75 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-5-2026-03-03-rth-2026-03-31-rth-2026-03-31-rth-2026-04-15-rth-2026-04-15-rth-2026-04-22-rth-124 | 2026-04-20-rth | -5300 | fail_safe:max_adverse_r_exceeded | authoritative | 26784.5 | 26762.5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-2-2026-02-09-rth-2026-03-10-rth-2026-03-10-rth-2026-03-24-rth-2026-03-24-rth-2026-03-31-rth-18 | 2026-03-24-rth | -5200 | fail_safe:max_adverse_r_exceeded | authoritative | 24326.75 | 24312 |

## Evidence gaps
- vix_value remains unavailable per trade
- vix_fresh remains unavailable per trade
- signed_shock_vwap remains unavailable per trade
- signed_shock_vwap_recent_values remains unavailable per trade
- primary_percentile and vxn_percentile remain unavailable per trade
- window_id remains unavailable per trade; artifact window totals are available, but fail-safe concentration by window cannot be assigned without ambiguity
