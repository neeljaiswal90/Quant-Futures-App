# Dashboard Probability Calibration Methodology

RA-046 makes scenario probabilities quantifiable but not yet empirically
calibrated. The displayed values are still heuristic priors adjusted by explicit
market-condition multipliers.

## What Gets Logged

Every dashboard generation appends one probability snapshot per scenario to:

`data/live_analysis/probability_snapshots.jsonl`

Each row includes:

- trading date and session
- scenario id and state
- prior probability range
- displayed probability range
- full multiplier list with rationale and trigger text
- timestamp of the dashboard run

When a scenario completes with `target_hit` or `stop_hit`, the dashboard appends
one outcome row to:

`data/live_analysis/probability_outcomes.jsonl`

Each row includes the displayed probability at completion time, outcome, entry
timestamp if available, exit timestamp, and the applied multiplier list.

## Why This Is Not Calibrated Yet

The multipliers are defensible trading hypotheses:

- bullish CVD should improve long scenario reliability
- quiet volume should reduce signal reliability
- unrecovered sweeps and repeated absorption proxies indicate level importance

They are not yet measured win-rate adjustments. A minimum useful corpus is about
30 completed scenarios per bucket or trigger family.

## Future Calibration Path

After enough outcomes accumulate:

1. Group outcomes by probability bucket and multiplier trigger.
2. Compute realized hit rate and Wilson confidence interval.
3. Compare displayed probability ranges against realized rates.
4. Replace or shrink heuristic multipliers whose confidence intervals do not
   support the assumed effect.

Until that happens, the dashboard footer must keep the heuristic disclosure.
