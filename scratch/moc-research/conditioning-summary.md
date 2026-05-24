# MOC-R5 conditioning summary

MOC-R5 recomputes R4 expectancy on bucket-restricted event subsets. It does not
filter R4's aggregate table directly; it joins R3 trigger cells to R1 calendar
attributes and R2 pre-event aggregates, then reruns the R4 first-touch math per
(stratification_dimension, stratification_bucket) subset.

Input SHAs: R4 expectancy `4341c862047b23414218c92ce56c9ae299f6cef496de304aa767feedd87b75cd`; R3
triggered `7da601066b958e484238a7fe767f6aead80df83ea38d54bbba1616b6b5dead3f`; R2 event-stream
`f9effd810b609c03394e96c69e473e9d388eec82accdcbf8975494a307c330cb`; R2 event-aggregates
`5c6e67701f54038592a387b4d7bb053637f7f9b172a62bad3bd19b60711dc3b9`; R1 manifest
`1aa076833537f5fbe1bead661e7fd806702a3686dec5f6d945eb27239192dc19`.

Both-sides carry-forward: rows with R3 `outcome=both_sides` use the earliest
trigger side for first-touch, matching MOC-R3 and MOC-R4 methodology.

Calendar combinatorial buckets use observed combinations only, encoded as
`is_friday=<bool>|is_month_end=<bool>|is_quarter_end=<bool>|is_triple_witching=<bool>`.
No Cartesian product of unobserved combinations is emitted.

Observed bucket session counts:
- vix_quartile: Q1_low:3, Q2:9, Q3:3, Q4_high:15
- regime_label: high:18, mid:4, low:8
- day_of_week: Mon:7, Tue:6, Wed:6, Thu:6, Fri:5
- is_roll_week: false:30
- is_macro_day: true:1, false:29
- calendar_combinatorial: is_friday=false|is_month_end=false|is_quarter_end=false|is_triple_witching=false:24, is_friday=false|is_month_end=true|is_quarter_end=true|is_triple_witching=false:1, is_friday=true|is_month_end=false|is_quarter_end=false|is_triple_witching=false:4, is_friday=true|is_month_end=false|is_quarter_end=false|is_triple_witching=true:1
- pre_event_spread_ticks_t_minus_10s: 1:3, 2:23, >=3:4
- pre_event_imbalance_t_minus_10s: strong_bid:6, neutral:18, strong_ask:6
- pre_event_volume_z_score: none

Surviving buckets after n<20 filter:
- vix_quartile: none
- regime_label: none
- day_of_week: none
- is_roll_week: false:30
- is_macro_day: false:29
- calendar_combinatorial: is_friday=false|is_month_end=false|is_quarter_end=false|is_triple_witching=false:24
- pre_event_spread_ticks_t_minus_10s: 2:23
- pre_event_imbalance_t_minus_10s: none
- pre_event_volume_z_score: none

No surviving rows: vix_quartile, regime_label, day_of_week, pre_event_imbalance_t_minus_10s, pre_event_volume_z_score. Filtered tuple count: 1905120.
Emitted row count: 362880. Every emitted row has n_events_total >= 20.

## Top 10 by expected_daily_pnl_usd

| rank | dimension | bucket | pt | stop | cost | latency | arm | offset | ref | protection | n | expected_daily_pnl_usd | p_pt | p_stop |
|---:|---|---|---:|---:|---|---:|---:|---:|---|---|---:|---:|---:|---:|
| 1 | pre_event_spread_ticks_t_minus_10s | 2 | 6.0 | 3.0 | mnq_low | 0 | 10 | 3.0 | microprice | null | 23 | 1.2908695652 | 0.7391304348 | 0.2608695652 |
| 2 | pre_event_spread_ticks_t_minus_10s | 2 | 6.0 | 3.0 | mnq_low | 0 | 10 | 3.0 | microprice | 0.5 | 23 | 1.2908695652 | 0.7391304348 | 0.2608695652 |
| 3 | pre_event_spread_ticks_t_minus_10s | 2 | 6.0 | 3.0 | mnq_low | 0 | 10 | 3.0 | microprice | 1.0 | 23 | 1.2908695652 | 0.7391304348 | 0.2608695652 |
| 4 | pre_event_spread_ticks_t_minus_10s | 2 | 6.0 | 3.0 | mnq_low | 0 | 10 | 3.0 | microprice | 1.5 | 23 | 1.2908695652 | 0.7391304348 | 0.2608695652 |
| 5 | pre_event_spread_ticks_t_minus_10s | 2 | 6.0 | 3.0 | mnq_low | 100 | 10 | 3.0 | microprice | null | 23 | 1.2908695652 | 0.7391304348 | 0.2608695652 |
| 6 | pre_event_spread_ticks_t_minus_10s | 2 | 6.0 | 3.0 | mnq_low | 100 | 10 | 3.0 | microprice | 0.5 | 23 | 1.2908695652 | 0.7391304348 | 0.2608695652 |
| 7 | pre_event_spread_ticks_t_minus_10s | 2 | 6.0 | 3.0 | mnq_low | 100 | 10 | 3.0 | microprice | 1.0 | 23 | 1.2908695652 | 0.7391304348 | 0.2608695652 |
| 8 | pre_event_spread_ticks_t_minus_10s | 2 | 6.0 | 3.0 | mnq_low | 100 | 10 | 3.0 | microprice | 1.5 | 23 | 1.2908695652 | 0.7391304348 | 0.2608695652 |
| 9 | pre_event_spread_ticks_t_minus_10s | 2 | 6.0 | 3.0 | mnq_low | 500 | 10 | 3.0 | microprice | null | 23 | 1.2908695652 | 0.7391304348 | 0.2608695652 |
| 10 | pre_event_spread_ticks_t_minus_10s | 2 | 6.0 | 3.0 | mnq_low | 500 | 10 | 3.0 | microprice | 0.5 | 23 | 1.2908695652 | 0.7391304348 | 0.2608695652 |
