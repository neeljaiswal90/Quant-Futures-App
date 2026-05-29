# CYCLE4-R1-V3-MAX-ADVERSE-R-DIAGNOSTIC-01 Artifact

## Class summaries
| class | count | net_pnl_cents | avg_net_pnl_cents | avg_hold_minutes | avg_mae_cents |
| --- | --- | --- | --- | --- | --- |
| max_adverse_r | 245 | -580100 | -2367.76 | 1.67 | -3074.9 |
| target | 259 | 742000 | 2864.86 | 2.28 | -491.89 |
| stop_loss | 363 | -313150 | -862.67 | 2.06 | -1489.94 |
| spread_fail_safe | 17 | 47650 | 2802.94 | 1.47 | -1617.65 |

## Candidate separators
| feature | observed_separation | likely_usefulness | evidence_confidence | risk_of_filtering_winners |
| --- | --- | --- | --- | --- |
| hold_time_lt_2_minutes | max_adverse=70.2%, target=51.74% | high diagnostic value | medium | material |
| max_adverse_excursion_cents | max_adverse median MAE=-2400, target median MAE=-400 | high diagnostic value | high | depends on whether pre-entry proxy can predict MAE |
| vix_prior_close_percentile_ge_0_85 | max_adverse=26.94%, target=35.52% | mixed | medium | high because targets also cluster in high VIX bucket |
| spread_fail_safe_comparison | spread fail-safes net=47650 cents across 17 trades | avoid relaxing spread guard | high | relaxing guard could leak captured profit |
| stop_loss_comparison | stop_loss avg=-862.67, max_adverse avg=-2367.76 | management-threshold diagnostic value | high | requires threshold sensitivity replay before any change |

## Worst max-adverse-R trades
| trade_id | session_id | net_pnl_cents | hold_minutes | mae_cents | vix_prior_close_percentile | spread_bucket | queue_ahead_bucket |
| --- | --- | --- | --- | --- | --- | --- | --- |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-6-2026-03-10-rth-2026-04-08-rth-2026-04-08-rth-2026-04-22-rth-2026-04-22-rth-2026-04-29-rth-108 | 2026-04-24-rth | -11800 | 2.0011 | -13000 | 0.35 | 2-tick | 6-20 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-4-2026-02-24-rth-2026-03-24-rth-2026-03-24-rth-2026-04-08-rth-2026-04-08-rth-2026-04-15-rth-70 | 2026-04-09-rth | -11700 | 1.0026 | -15300 | 0.533333 | 2-tick | 6-20 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-3-2026-02-17-rth-2026-03-17-rth-2026-03-17-rth-2026-03-31-rth-2026-03-31-rth-2026-04-08-rth-20 | 2026-03-31-rth | -11000 | 1 | -15050 | 0.983333 | 2-tick | 6-20 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-3-2026-02-17-rth-2026-03-17-rth-2026-03-17-rth-2026-03-31-rth-2026-03-31-rth-2026-04-08-rth-19 | 2026-03-31-rth | -9850 | 1.0008 | -10300 | 0.983333 | 3+ ticks | 6-20 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-1-2026-02-02-rth-2026-03-03-rth-2026-03-03-rth-2026-03-17-rth-2026-03-17-rth-2026-03-24-rth-26 | 2026-03-19-rth | -7450 | 0.9972 | -7450 | 0.933333 | 3+ ticks | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-3-2026-02-17-rth-2026-03-17-rth-2026-03-17-rth-2026-03-31-rth-2026-03-31-rth-2026-04-08-rth-25 | 2026-03-31-rth | -7000 | 1.0003 | -12550 | 0.983333 | 2-tick | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-1-2026-02-02-rth-2026-03-03-rth-2026-03-03-rth-2026-03-17-rth-2026-03-17-rth-2026-03-24-rth-32 | 2026-03-19-rth | -6700 | 0.994 | -7000 | 0.933333 | 3+ ticks | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-6-2026-03-10-rth-2026-04-08-rth-2026-04-08-rth-2026-04-22-rth-2026-04-22-rth-2026-04-29-rth-111 | 2026-04-24-rth | -6350 | 1.0008 | -7750 | 0.35 | 2-tick | 6-20 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-1-2026-02-02-rth-2026-03-03-rth-2026-03-03-rth-2026-03-17-rth-2026-03-17-rth-2026-03-24-rth-3 | 2026-03-19-rth | -6100 | 1.0118 | -7350 | 0.933333 | 3+ ticks | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-3-2026-02-17-rth-2026-03-17-rth-2026-03-17-rth-2026-03-31-rth-2026-03-31-rth-2026-04-08-rth-15 | 2026-03-31-rth | -5950 | 1.0015 | -6150 | 0.983333 | 2-tick | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-1-2026-02-02-rth-2026-03-03-rth-2026-03-03-rth-2026-03-17-rth-2026-03-17-rth-2026-03-24-rth-28 | 2026-03-19-rth | -5800 | 1.0401 | -6650 | 0.933333 | 3+ ticks | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-1-2026-02-02-rth-2026-03-03-rth-2026-03-03-rth-2026-03-17-rth-2026-03-17-rth-2026-03-24-rth-64 | 2026-03-23-rth | -5800 | 1.0011 | -6300 | 0.95 | 2-tick | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-3-2026-02-17-rth-2026-03-17-rth-2026-03-17-rth-2026-03-31-rth-2026-03-31-rth-2026-04-08-rth-30 | 2026-03-31-rth | -5300 | 1 | -6350 | 0.983333 | 1-tick | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-5-2026-03-03-rth-2026-03-31-rth-2026-03-31-rth-2026-04-15-rth-2026-04-15-rth-2026-04-22-rth-124 | 2026-04-20-rth | -5300 | 1.0075 | -5650 | 0.15 | 2-tick | 6-20 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-2-2026-02-09-rth-2026-03-10-rth-2026-03-10-rth-2026-03-24-rth-2026-03-24-rth-2026-03-31-rth-18 | 2026-03-24-rth | -5200 | 1.0001 | -5800 | 0.933333 | 3+ ticks | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-1-2026-02-02-rth-2026-03-03-rth-2026-03-03-rth-2026-03-17-rth-2026-03-17-rth-2026-03-24-rth-55 | 2026-03-23-rth | -5000 | 1.9998 | -5350 | 0.95 | 2-tick | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-3-2026-02-17-rth-2026-03-17-rth-2026-03-17-rth-2026-03-31-rth-2026-03-31-rth-2026-04-08-rth-34 | 2026-03-31-rth | -4850 | 1.003 | -6250 | 0.983333 | 2-tick | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-2-2026-02-09-rth-2026-03-10-rth-2026-03-10-rth-2026-03-24-rth-2026-03-24-rth-2026-03-31-rth-58 | 2026-03-30-rth | -4800 | 2.0057 | -5250 | 1 | 2-tick | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-1-2026-02-02-rth-2026-03-03-rth-2026-03-03-rth-2026-03-17-rth-2026-03-17-rth-2026-03-24-rth-9 | 2026-03-19-rth | -4600 | 1.0005 | -4600 | 0.933333 | 3+ ticks | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-1-2026-02-02-rth-2026-03-03-rth-2026-03-03-rth-2026-03-17-rth-2026-03-17-rth-2026-03-24-rth-5 | 2026-03-19-rth | -4500 | 1.0017 | -5650 | 0.933333 | 3+ ticks | 1-5 |

## Least-bad max-adverse-R trades
| trade_id | session_id | net_pnl_cents | hold_minutes | mae_cents | vix_prior_close_percentile | spread_bucket | queue_ahead_bucket |
| --- | --- | --- | --- | --- | --- | --- | --- |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-6-2026-03-10-rth-2026-04-08-rth-2026-04-08-rth-2026-04-22-rth-2026-04-22-rth-2026-04-29-rth-289 | 2026-04-27-rth | -800 | 0.9741 | -1350 | 0.25 | 2-tick | 6-20 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-6-2026-03-10-rth-2026-04-08-rth-2026-04-08-rth-2026-04-22-rth-2026-04-22-rth-2026-04-29-rth-66 | 2026-04-22-rth | -900 | 0.996 | -1000 | 0.383333 | 2-tick | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-6-2026-03-10-rth-2026-04-08-rth-2026-04-08-rth-2026-04-22-rth-2026-04-22-rth-2026-04-29-rth-71 | 2026-04-22-rth | -900 | 3.9941 | -950 | 0.383333 | 3+ ticks | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-6-2026-03-10-rth-2026-04-08-rth-2026-04-08-rth-2026-04-22-rth-2026-04-22-rth-2026-04-29-rth-262 | 2026-04-27-rth | -900 | 2.0011 | -1000 | 0.25 | 1-tick | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-5-2026-03-03-rth-2026-03-31-rth-2026-03-31-rth-2026-04-15-rth-2026-04-15-rth-2026-04-22-rth-110 | 2026-04-20-rth | -950 | 1.9965 | -1200 | 0.15 | 1-tick | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-5-2026-03-03-rth-2026-03-31-rth-2026-03-31-rth-2026-04-15-rth-2026-04-15-rth-2026-04-22-rth-117 | 2026-04-20-rth | -950 | 0.9955 | -1450 | 0.15 | 1-tick | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-5-2026-03-03-rth-2026-03-31-rth-2026-03-31-rth-2026-04-15-rth-2026-04-15-rth-2026-04-22-rth-130 | 2026-04-20-rth | -950 | 0.9965 | -1700 | 0.15 | 3+ ticks | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-6-2026-03-10-rth-2026-04-08-rth-2026-04-08-rth-2026-04-22-rth-2026-04-22-rth-2026-04-29-rth-28 | 2026-04-22-rth | -950 | 0.9947 | -1050 | 0.383333 | 2-tick | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-6-2026-03-10-rth-2026-04-08-rth-2026-04-08-rth-2026-04-22-rth-2026-04-22-rth-2026-04-29-rth-235 | 2026-04-27-rth | -950 | 1.9994 | -1250 | 0.25 | 1-tick | 6-20 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-6-2026-03-10-rth-2026-04-08-rth-2026-04-08-rth-2026-04-22-rth-2026-04-22-rth-2026-04-29-rth-263 | 2026-04-27-rth | -950 | 1.9991 | -1200 | 0.25 | 1-tick | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-5-2026-03-03-rth-2026-03-31-rth-2026-03-31-rth-2026-04-15-rth-2026-04-15-rth-2026-04-22-rth-106 | 2026-04-20-rth | -1000 | 2.0028 | -1350 | 0.15 | 2-tick | 6-20 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-6-2026-03-10-rth-2026-04-08-rth-2026-04-08-rth-2026-04-22-rth-2026-04-22-rth-2026-04-29-rth-65 | 2026-04-22-rth | -1000 | 2.9972 | -1350 | 0.383333 | 2-tick | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-6-2026-03-10-rth-2026-04-08-rth-2026-04-08-rth-2026-04-22-rth-2026-04-22-rth-2026-04-29-rth-242 | 2026-04-27-rth | -1000 | 1.0004 | -1350 | 0.25 | 2-tick | 6-20 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-6-2026-03-10-rth-2026-04-08-rth-2026-04-08-rth-2026-04-22-rth-2026-04-22-rth-2026-04-29-rth-258 | 2026-04-27-rth | -1000 | 1.9998 | -1100 | 0.25 | 2-tick | 6-20 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-4-2026-02-24-rth-2026-03-24-rth-2026-03-24-rth-2026-04-08-rth-2026-04-08-rth-2026-04-15-rth-154 | 2026-04-09-rth | -1050 | 1.0004 | -1900 | 0.533333 | 2-tick | 6-20 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-6-2026-03-10-rth-2026-04-08-rth-2026-04-08-rth-2026-04-22-rth-2026-04-22-rth-2026-04-29-rth-176 | 2026-04-24-rth | -1050 | 1.0035 | -1600 | 0.35 | 2-tick | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-6-2026-03-10-rth-2026-04-08-rth-2026-04-08-rth-2026-04-22-rth-2026-04-22-rth-2026-04-29-rth-177 | 2026-04-24-rth | -1050 | 4.0024 | -1150 | 0.35 | 1-tick | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-6-2026-03-10-rth-2026-04-08-rth-2026-04-08-rth-2026-04-22-rth-2026-04-22-rth-2026-04-29-rth-202 | 2026-04-24-rth | -1050 | 1.0018 | -1200 | 0.35 | 2-tick | 1-5 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-6-2026-03-10-rth-2026-04-08-rth-2026-04-08-rth-2026-04-22-rth-2026-04-22-rth-2026-04-29-rth-215 | 2026-04-27-rth | -1050 | 1.0023 | -1600 | 0.25 | 2-tick | 6-20 |
| trade-cycle4-r1-v3-failsafe-forensics-02-regime_shock_reversion_short_v3-wf-1-6-2026-03-10-rth-2026-04-08-rth-2026-04-08-rth-2026-04-22-rth-2026-04-22-rth-2026-04-29-rth-216 | 2026-04-27-rth | -1050 | 2.0037 | -1400 | 0.25 | 2-tick | 6-20 |

## Evidence gaps
- per-trade signed_shock_vwap remains unavailable
- per-trade signed_shock_vwap_recent_values remains unavailable
- per-trade vix_value and vix_fresh remain unavailable
- per-trade primary_percentile and vxn_percentile remain unavailable
- per-trade window_id remains unavailable; overlapping walk-forward windows prevent unambiguous fail-safe window attribution
- adverse-R at exit is inferred from reason/MAE context; exact adverse-R scalar is not serialized per trade
