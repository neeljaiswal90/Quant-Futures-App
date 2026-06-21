# QFA ORB breakout long Kelly sizing research - 2026-06-20

Determination: `ORB_BREAKOUT_LONG_KELLY_SIZING_RESEARCH_COMPLETE_RUNTIME_UNCHANGED`

## Scope

Research-only Kelly sizing audit for `opening_range_box_breakout_long`.

Runtime sizing is unchanged. No broker action, no `ORDER_INTENT`, no paper/live authority, and no roster mutation are authorized.

## Method

Kelly is estimated from historical R-multiples:

```text
R = net_usd / (risk_points * $2 MNQ point value)
```

The walk-forward estimator uses expanding prior trades only after 100 prior observations. Full-sample Kelly is reported only as an in-sample diagnostic and is not used for walk-forward sizing.

Applied Kelly fractions are capped at 0.25% equity risk per trade.

## R-multiple summary

```json
{
  "trades": 631,
  "mean_r": 0.11077391,
  "variance_r": 0.71684818,
  "sample_full_kelly_fraction_in_sample_diagnostic": 0.1550963,
  "min_r": -1.03225806,
  "max_r": 1.49498118
}
```

## Scenario summary

| scenario | pnl_mode | trades | net_usd | profit_factor | win_rate | avg_trade_usd | max_drawdown_usd | pnl_to_max_drawdown | avg_applied_risk_fraction | avg_raw_full_kelly_fraction | avg_continuous_contract_equivalent | discrete_positive_contract_trades |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| one_contract_actual | continuous_contract_equivalent | 631 | 13286 | 1.4133 | 0.5753 | 21.0555 | 1767.25 | 7.5179 | 0.00348669 | 0 | 1 | 631 |
| fixed_025pct_continuous | continuous_contract_equivalent | 631 | 8737.29 | 1.354 | 0.5753 | 13.8467 | 1036.95 | 8.4259 | 0.0025 | 0.10151146 | 0.879401 | 0 |
| fixed_025pct_discrete_floor | discrete_floor_contracts | 631 | 1498.25 | 1.2164 | 0.1759 | 2.3744 | 692.75 | 2.1628 | 0.0025 | 0.10151146 | 0.879401 | 206 |
| walkforward_full_kelly_capped_025pct_continuous | continuous_contract_equivalent | 631 | 8156.26 | 1.3997 | 0.4881 | 12.9259 | 1036.95 | 7.8656 | 0.0021038 | 0.10151146 | 0.671859 | 0 |
| walkforward_quarter_kelly_capped_025pct_continuous | continuous_contract_equivalent | 631 | 8092.04 | 1.3966 | 0.4881 | 12.8242 | 1036.95 | 7.8037 | 0.002099 | 0.10151146 | 0.670314 | 0 |
| walkforward_eighth_kelly_capped_025pct_continuous | continuous_contract_equivalent | 631 | 7930.92 | 1.3905 | 0.4881 | 12.5688 | 1036.95 | 7.6483 | 0.00208081 | 0.10151146 | 0.663893 | 0 |
| walkforward_quarter_kelly_capped_025pct_discrete_floor | discrete_floor_contracts | 631 | 1276.25 | 1.2704 | 0.1125 | 2.0226 | 471 | 2.7097 | 0.002099 | 0.10151146 | 0.670314 | 131 |

## Interpretation

The discrete 0.25% cap is usually too small for one MNQ contract when stop distance is large, so the discrete-floor variants mostly skip trades. Continuous Kelly sizing is useful for research, but it is not directly executable at small account size.

Do not promote Kelly to runtime until the forward shadow stream has enough accepted trades to estimate edge without relying on the same backtest used for selection.

## Artifacts

- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-kelly-sizing-research-01\orb-breakout-long-kelly-sizing-overlay-trades.csv`
- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-kelly-sizing-research-01\orb-breakout-long-kelly-sizing-summary.csv`
- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-kelly-sizing-research-01\orb-breakout-long-kelly-sizing-by-year.csv`
- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-kelly-sizing-research-01\orb-breakout-long-kelly-sizing-report.json`
- `artifacts\backtests\mnq-included-2019-05-06_2026-06-20-orb-breakout-long-kelly-sizing-research-01\orb-breakout-long-kelly-sizing-report.md`
