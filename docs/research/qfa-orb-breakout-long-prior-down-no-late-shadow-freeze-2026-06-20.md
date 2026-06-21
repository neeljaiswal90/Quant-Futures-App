# QFA ORB breakout long prior-down no-late shadow freeze - 2026-06-20

## Disposition

`QFA_ORB_BREAKOUT_LONG_PRIOR_DOWN_NO_LATE_SHADOW_FREEZE_COMPLETE`

This freezes the ORB shadow-testing hypothesis and evidence chain after secondary quant review.

Approved next step:

```text
QFA-ORB-BREAKOUT-LONG-PRIOR-DOWN-NO-LATE-SHADOW-01
```

This is a forward live-shadow test only. It does not authorize broker orders, `ORDER_INTENT`, paper/live execution, Phase 6 promotion, or roster mutation.

## Frozen shadow profile

```text
strategy_id = opening_range_box_breakout_long
mode = live_shadow_only
ORDER_INTENT = 0
broker/live authority = false
roster mutation = false
```

Entry context:

```text
allow prior_day_trend_state in {prior_down, prior_down_large}
block breakout_time_bucket = 14:00+
```

Required control streams:

```text
baseline opening_range_box_breakout_long control
prior_up / prior_up_large contrast
candidate accepted stream
candidate excluded stream with exclusion reason
```

Primary forward readout:

```text
candidate prior-down/no-14 performance
vs same-window baseline breakout_long control
vs same-window prior-up contrast
```

Absolute PnL/PF is not the primary early readout. If forward market conditions do not pay the baseline long drift, the hypothesis is not falsified unless the same-window candidate stream also fails to separate from the baseline/prior-up contrast.

## Log-only overlays

The following overlays must be logged as counterfactual telemetry only:

```text
75% MAE60 path-stop counterfactual
2-contract dynamic two-PT counterfactual
Kelly sizing telemetry
```

The 75% MAE60 overlay modestly improves historical prior-down profile table metrics, but the delta is small and statistically inconclusive. It remains log-only.

The 2-contract dynamic two-PT profile improves drawdown-adjusted results in the preferred universe but gives up net PnL and has only 123 warmup-eligible historical trades. It remains log-only.

Kelly remains log-only because runtime `q_kelly` is intentionally `null`, and the Kelly research did not justify runtime promotion.

## Accepted evidence

Baseline `opening_range_box_breakout_long`:

```text
trades = 631
net_usd = 13286.00
profit_factor = 1.4133
max_drawdown_usd = 1767.25
pnl_to_drawdown = 7.5179
```

Frozen candidate without path overlay:

```text
prior_day_trend_state in {prior_down, prior_down_large}
exclude 14:00+
trades = 223
net_usd = 9397.00
profit_factor = 1.8457
win_rate = 0.5964
avg_trade_usd = 42.1390
max_drawdown_usd = 921.50
pnl_to_drawdown = 10.1975
```

Frozen candidate with 75% MAE60 log-only overlay:

```text
trades = 223
adjusted_net_usd = 9572.13
profit_factor = 1.9268
max_drawdown_usd = 769.13
pnl_to_drawdown = 12.4455
path_stop_hits = 40
status = log_only_statistically_inconclusive
```

Frozen candidate with 2-contract dynamic two-PT log-only overlay:

```text
contracts = 2
warmup_eligible_trades = 123
net_usd = 8111.26
profit_factor = 1.7865
win_rate = 0.6341
max_drawdown_usd = 956.97
pnl_to_drawdown = 8.4760
status = log_only_risk_control_comparison
```

## Rejected or unpromoted rules

Rejected:

```text
low regime + 100 < risk_points <= 150 exclusion
```

Reason:

```text
recent 12mo direct excluded stream = -1357.00 / PF 0.7505
expanded 2019-2026 direct excluded stream = +7155.25 / PF 1.3404
expanded exclusion scenario delta = -5275.75
```

The rule removes profitable expanded-history trades and is not stable.

Also not promoted:

```text
opening_range_box_breakout_short
raw OR/prior hard filters
50% MAE60 stop
Kelly runtime sizing
single dynamic PT
full-universe dynamic PT
```

## Forward evidence thresholds

Early directional evidence:

```text
accepted_candidate_signals >= 30
baseline control present
prior-up contrast present
excluded-stream counterfactual present
ORDER_INTENT = 0
```

Useful validation evidence:

```text
accepted_candidate_signals >= 100
same-window relative readout still separates
baseline/prior-up contrast still logged
excluded-stream counterfactual PnL still logged
operational capture quality acceptable
```

45-60 trading sessions should be treated as operational evidence, not full statistical validation for this sparse candidate stream.

## Required shadow telemetry

Each signal or exclusion should log:

```text
strategy_id
timestamp_utc
session_id
prior_day_trend_state
breakout_time_bucket
candidate_allowed
candidate_exclusion_reason
baseline_control_signal
prior_up_contrast_signal
entry_price
stop_price
risk_points
opening_range_size_to_prior_range
first30_volume_ratio
gap_size_and_direction
vwap_distance_at_signal
MFE30 / MAE30
MFE60 / MAE60
MFE120 / MAE120
mae60_75pct_counterfactual_hit
dynamic_two_pt_counterfactual
kelly_fraction_telemetry
ORDER_INTENT_count
```

Required invariant:

```text
ORDER_INTENT_count = 0
broker_adapter_calls = 0
order_translation_calls = 0
roster_mutation = false
```

## Evidence chain

Machine-readable freeze:

```text
artifacts/backtests/qfa-orb-breakout-long-prior-down-no-late-shadow-freeze-2026-06-20/evidence-chain.json
```

Load-bearing artifacts:

```text
artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-breakout-long-factor-audit-01/orb-breakout-long-factor-audit-report.json
sha256 = 4cfb0dc6b8b298db33de7985272a9cbfb3e4a27d8cf2b1d0d2ab837c4661fdcc

artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-breakout-long-time-prior-trend-management-audit-01/orb-breakout-long-time-prior-trend-management-report.json
sha256 = 40f733fd6cd2984de81e2f224d243aba47b65043831753d2501479d5f3cebe84

artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-breakout-long-path-risk-control-audit-01/orb-breakout-long-path-risk-control-report.json
sha256 = f8bee313d07c5ccf1b455e0be5833e4e19df1b08497f2bc5a373d048321ec455

artifacts/backtests/orb-low-regime-100-150-riskband-test-2026-06-20/low-regime-100-150-test-report.json
sha256 = e5bf4c9e94ae7814c0999974c1f271e44be45ccde7feb098cf045574f8c6dbdf

artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-breakout-long-dynamic-pt-2contract-01/orb-breakout-long-dynamic-pt-2contract-report.json
sha256 = e90b0b819e807e0078143b6e6540f792d2949ec0240de67ffeca4d175fe15625
```

## Next implementation ticket

```text
QFA-ORB-BREAKOUT-LONG-PRIOR-DOWN-NO-LATE-SHADOW-01
```

Implementation must be shadow-only and must preserve the `ORDER_INTENT=0` invariant.
