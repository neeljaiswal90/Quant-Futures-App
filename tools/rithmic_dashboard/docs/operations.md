# Rithmic Dashboard Operations

## Current Surface

The static V1 HTML dashboard is retired. Do not use
`python -m rithmic_dashboard.cli.generate` or
`data/dashboard/index.html` for live operations. Direct generator calls now
fail loudly with v2 guidance.

Use the v2 realtime stack:

```powershell
D:\Quant-futures-app\run_realtime_stack.ps1
```

The retained 5-minute script is now a data-pipeline upkeep loop. It maintains
normalized siblings and analytics artifacts for the v2 backend; it does not
render HTML.

```powershell
cd D:\Quant-futures-app\tools\rithmic_dashboard
.\scripts\run_local_probe_refresh.ps1 -TradingDate 2026-05-29 -Session rth -Loop -IntervalMinutes 5
```

Default behavior:

- Incremental normalize (`normalize_probe_incremental`) unless `-SkipNormalize`
  is explicitly supplied.
- `daily_zones --mode light` with absorption, probability cards, and adaptive
  bins.
- No heavy pressure/cancellation scan.
- No V1 HTML generation.

For EOD/full analytics after RTH close:

```powershell
.\scripts\run_eod_full_analytics.ps1 -TradingDate 2026-05-29 -Session rth
```

The EOD path preserves full normalize plus `daily_zones --mode full`, and also
stops after data artifacts. It no longer runs the V1 HTML generator.

## Normalize Ownership

RA-071 retires only the V1 HTML view. It does not move normalize ownership.

Before the RA-070 cutover, the 5-minute loop should keep normalizing. After the
operator enables backend self-normalize with `RA60_SELF_NORMALIZE=1`, start the
loop with `-SkipNormalize` so exactly one normalizer writes the capture
siblings. Do not run backend self-normalize and loop normalize at the same time.

The EOD full-normalize path has the same ownership caveat: after the cutover,
use it only as an intentional reconciliation action when the backend normalizer
is stopped or the operator has accepted the write ownership handoff.

## Useful Forms

```powershell
.\scripts\run_local_probe_refresh.ps1 -DryRun
.\scripts\run_local_probe_refresh.ps1 -TradingDate 2026-05-29 -Session globex
.\scripts\run_local_probe_refresh.ps1 -TradingDate 2026-05-29 -Session rth -Loop -IntervalMinutes 5
.\scripts\run_local_probe_refresh.ps1 -SkipNormalize
.\scripts\run_local_probe_refresh.ps1 -ClearPauseFlag
.\scripts\run_local_probe_refresh.ps1 -TryCalibrateThresholds -LookbackSessions 20
```

`-OpenDashboard` is retained for command compatibility but no longer opens a
static HTML page. Start the v2 stack and open the Vite URL instead.

## Data Artifacts

The loop writes and refreshes:

- `data/live_analysis/*_cvd.jsonl`
- `data/live_analysis/*_sweeps.jsonl`
- `data/live_analysis/*_absorption_proxy.jsonl`
- `data/live_analysis/*_delta_dislocations.jsonl`
- `data/live_analysis/*_institutional_flow.jsonl`
- `data/live_analysis/*_icebergs.jsonl`
- `data/live_analysis/*_aggressor_flow.jsonl`
- `data/live_analysis/*_footprint.jsonl`
- `data/live_analysis/*_vol_regime.jsonl`
- `data/live_analysis/*_day_type.json`
- `data/live_analysis/*_day_type.jsonl`
- `data/live_analysis/probability_snapshots.jsonl`
- `data/live_analysis/probability_outcomes.jsonl`
- `data/live_analysis/day_type_outcomes.jsonl`
- `data/live_analysis/ewma_volatility_state.json`
- `data/dashboard/local_probe_refresh_<date>.log`
- `data/dashboard/eod_full_analytics_<date>.log`
- `data/dashboard/_audit.json` compatibility audit state used by the loop

The archived V1 implementation is under `rithmic_dashboard/legacy_v1/` for
historical reference only.

## Troubleshooting

- If the v2 UI is stale, first check the realtime backend health and then
  `data/dashboard/local_probe_refresh_<date>.log`.
- Healthy intraday logs include `normalize incremental <session>`,
  `daily_zones ... --mode light`, and `V1 dashboard generation retired`.
- If normalized siblings stop updating before RA-070 cutover, the loop was
  probably launched with `-SkipNormalize` too early.
- If normalized siblings are corrupted after RA-070 cutover, check for both
  loop normalize and backend self-normalize running simultaneously.
- `-EmitHeavyAnalytics` is an explicit EOD-style opt-in. Do not use it in the
  5-minute loop.
