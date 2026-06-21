# ORB low-regime 100-150 risk-band exclusion artifact

Determination: `ORB_LOW_REGIME_100_150_RISKBAND_TEST_COMPLETE_REJECT_EXPANDED_HISTORY`

Rule tested:

```text
regime_label == low and 100 < abs(entry_price - stop_price) <= 150
```

## Summary

| sample | row | trades | net_usd | profit_factor | max_drawdown_usd | pnl_to_drawdown | win_rate | avg_trade_usd | t_stat |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| recent_12mo | baseline | 254 | 5558.5 | 1.3167 | 3400.25 | 1.6347 | 0.5433 | 21.8839 | 1.6786 |
| recent_12mo | exclusion_scenario | 215 | 7485 | 1.5704 | 2886.5 | 2.5931 | 0.5581 | 34.814 | 2.4776 |
| recent_12mo | direct_excluded_stream | 53 | -1357 | 0.7505 | 2510.5 | -0.5405 | 0.4906 | -25.6038 | -0.895 |
| recent_12mo | exclusion_minus_baseline | -39 | 1926.5 |  | -513.75 |  |  |  |  |
| expanded_2019_2026 | baseline | 2094 | 23580 | 1.1934 | 5068.75 | 4.652 | 0.5148 | 11.2607 | 3.1606 |
| expanded_2019_2026 | exclusion_scenario | 1851 | 18304.25 | 1.1759 | 5252.75 | 3.4847 | 0.5057 | 9.8888 | 2.6893 |
| expanded_2019_2026 | direct_excluded_stream | 303 | 7155.25 | 1.3404 | 4087.25 | 1.7506 | 0.5842 | 23.6147 | 2.1663 |
| expanded_2019_2026 | exclusion_minus_baseline | -243 | -5275.75 |  | 184 |  |  |  |  |

## Direct excluded stream by strategy

| sample | strategy_id | trades | net_usd | profit_factor | win_rate | avg_trade_usd | t_stat |
| --- | --- | --- | --- | --- | --- | --- | --- |
| recent_12mo_direct_excluded_stream | opening_range_box_breakout_long | 20 | -342.5 | 0.8049 | 0.55 | -17.125 | -0.4082 |
| recent_12mo_direct_excluded_stream | opening_range_box_regime_long | 33 | -1014.5 | 0.7245 | 0.4545 | -30.7424 | -0.7937 |
| expanded_2019_2026_direct_excluded_stream | opening_range_box_breakout_long | 131 | 2882.25 | 1.3212 | 0.5878 | 22.0019 | 1.3499 |
| expanded_2019_2026_direct_excluded_stream | opening_range_box_regime_long | 172 | 4273 | 1.3547 | 0.5814 | 24.843 | 1.6908 |

## Expanded direct excluded stream periods

| period | trades | net_usd | profit_factor | win_rate | avg_trade_usd | t_stat |
| --- | --- | --- | --- | --- | --- | --- |
| 2019-2024 | 211 | 7668.75 | 1.5946 | 0.6209 | 36.3448 | 2.9126 |
| 2025-2026 | 92 | -513.5 | 0.9368 | 0.5 | -5.5815 | -0.2599 |
| 2020 only | 21 | 1396.75 | 2.5872 | 0.7143 | 66.5119 | 1.8526 |
| 2022 only | 79 | 2528.5 | 1.4128 | 0.5696 | 32.0063 | 1.3356 |
| 2026 only | 32 | -348.25 | 0.8932 | 0.5625 | -10.8828 | -0.2704 |

## Conclusion

Reject exact low-regime 100:150 risk-band exclusion because the directly excluded stream is profitable over expanded 2019-2026 history and excluding it lowers expanded net PnL.
