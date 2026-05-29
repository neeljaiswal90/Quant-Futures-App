# Rithmic Dashboard Operations

## Cadence

The Windows scheduled task `MNQ_Dashboard_Generator_15m` runs every 15 minutes
on quarter-hour boundaries when the static generator is left to its normal
cadence. During an active probe, `scripts/run_local_probe_refresh.ps1 -Loop
-IntervalMinutes 5` is the preferred local runner; it normalizes the active
capture, recomputes zones, and refreshes the dashboard every 5 minutes. Both
paths respect `data/dashboard/_pause.flag`. They write:

- `data/dashboard/index.html`
- `data/dashboard/_state.json`
- `data/dashboard/_scenarios.json`
- `data/dashboard/_audit.json`
- `data/dashboard/_orderflow_cache.json`
- `data/dashboard/generator_<date>.log`
- `data/live_analysis/*_cvd.jsonl`
- `data/live_analysis/*_sweeps.jsonl`
- `data/live_analysis/*_absorption_proxy.jsonl`
- `data/live_analysis/*_delta_dislocations.jsonl`
- `data/live_analysis/*_delta_dislocation_alerts.jsonl`
- `data/live_analysis/*_institutional_flow.jsonl`
- `data/live_analysis/*_aggressor_flow.jsonl`
- `data/live_analysis/*_aggressor_flow_state.json`
- `data/live_analysis/*_footprint.jsonl`
- `data/live_analysis/*_vol_regime.jsonl`
- `data/live_analysis/*_day_type.json`
- `data/live_analysis/*_day_type.jsonl`
- `data/live_analysis/dislocation_thresholds.json`
- `data/live_analysis/trade_size_thresholds.json`
- `data/live_analysis/session_overrides.json`
- `data/live_analysis/probability_snapshots.jsonl`
- `data/live_analysis/probability_outcomes.jsonl`
- `data/live_analysis/day_type_outcomes.jsonl`
- `data/live_analysis/ewma_volatility_state.json`

Open `file:///D:/Quant-futures-app/tools/rithmic_dashboard/data/dashboard/index.html`
in a browser tab. The page contains a 300-second meta refresh to match the
active 5-minute local probe loop.

## Manual Full Refresh

Use `scripts/run_local_probe_refresh.ps1` when you want to run the whole local
pipeline from a terminal instead of waiting for scheduled tasks:

```powershell
cd D:\Quant-futures-app\tools\rithmic_dashboard
.\scripts\run_local_probe_refresh.ps1
```

The script finds the latest MNQ raw probe capture, normalizes it to
OBS-01/MBP1/MBO siblings, runs `daily_zones --mode light` with absorption,
probability cards, and adaptive bins, then regenerates `data/dashboard/index.html`.
The default path is the intraday-safe path: it uses incremental normalize and
does not run pressure/cancellation MBO scans.

For EOD/full analytics after RTH close, use:

```powershell
.\scripts\run_eod_full_analytics.ps1 -TradingDate 2026-05-27 -Session rth
```

`run_local_probe_refresh.ps1 -EmitHeavyAnalytics` remains available as an
explicit opt-in and maps to full normalize plus `daily_zones --mode full`.
Do not use it in the 5-minute loop.

Useful forms:

```powershell
.\scripts\run_local_probe_refresh.ps1 -DryRun
.\scripts\run_local_probe_refresh.ps1 -TradingDate 2026-05-22 -Session rth -OpenDashboard
.\scripts\run_local_probe_refresh.ps1 -SkipNormalize -SkipDailyZones
.\scripts\run_local_probe_refresh.ps1 -TradingDate 2026-05-26 -Session globex -Loop -IntervalMinutes 5
.\scripts\run_local_probe_refresh.ps1 -ClearPauseFlag
```

The manual runner never deletes raw captures. It overwrites only derived files
that are regenerated from the raw probe data.

## Pause And Resume

Create `data/dashboard/_pause.flag` to skip scheduled generator runs. Delete the
flag to resume. The pause flag is for code edits, manual investigation, or any
period where a half-updated dashboard should not render.

## Reading The Page

Active Posture is the fast scan:

1. EWMA volatility regime, once calibration exists.
2. Day type, once RTH has enough initial-balance data.
3. Price regime versus VWAP/sigma.
4. ACTIVE/WATCHING scenarios.
5. Live CVD/velocity confirmation or contradiction, falling back to artifact CVD
   when live capture data is unavailable.

The Volatility Regime read appears in Orderflow Pulse. It consumes
`D:\Quant-futures-app\tools\rithmic_analytics\data\calibration_corpus\ewma_decay.json`.
Refresh the calibration manually/monthly:

```powershell
cd D:\Quant-futures-app\tools\rithmic_analytics
python -m rithmic_analytics.cli.calibrate_ewma --symbol MNQ
```

The live loop uses the last 15 minutes of trade ticks to produce one Parkinson
sigma observation every 5 minutes, then updates the persisted EWMA state. The
EWMA memory is governed by lambda; the 15-minute window is only the observation
granularity.

The Day Type card appears during RTH. Before 08:00 PT it stays `pending`
because MNQ needs the first 90 minutes of RTH data: the 60-minute initial
balance plus a 30-minute confirmation window. It then rechecks every 15 minutes
and emits a `day_type_revised` event only when the classification changes. If a
partial-session override is active, or if RTH capture data is missing, it stays
pending/skipped and no day-type multiplier applies.

Recent Signals is the live signal strip. It reads canonical
`data/live_analysis/<date>_<session>_*.jsonl` files first and uses the capped
audit trail only as a fallback for older sessions. Rows are time-decayed:
fresh signals are under 5 minutes old, normal signals are 5-15 minutes old, and
faded signals are 15-30 minutes old. Older signals drop out.

The sticky multi-signal banner appears when two or more distinct signal
families, such as sweep plus absorption, sweep plus dislocation, or
institutional flow plus absorption, or aggressor flow plus sweep, fire at the
same zone inside the 30-minute window and price is still within 30 points of
that zone. Multiple sweeps alone, or a concentration plus block that are both
institutional-flow events, do not trigger the banner. Session-level day-type
classification rows have no
`level_id`, so they appear in Recent Signals but do not create badges or
same-zone stacks. IB-break and IB-extension rows do carry a level and can stack
when they coincide with another zone-level family.

Session-level volatility-regime rows also have no `level_id`, so they appear in
Recent Signals without badges or same-zone stacks.

Distance To Key Levels always pins VWAP, `+1sd`, `-1sd`, `+2sd`, and `-2sd` rows
even when those levels are farther away than the normal top-15 distance slice.
The Signals column shows compact badges for recent sweeps, absorption proxies,
delta dislocations, institutional-flow events, IB day-type level events, and
aggressor-flow events, and same-zone stacks.

Orderflow Pulse is intentionally fail-open. `n/a` means the artifact is missing
or not yet produced; it does not invalidate the structural sections. Live CVD
and velocity come from a bounded tail read of the active capture. Session CVD is
the slow regime read. Last-60-minute and last-15-minute CVD are faster momentum
reads. Divergence between session and last-15-minute CVD is a momentum-flip
warning.

Recent sweeps show fast moves through structural levels. An unrecovered sweep
near a scenario entry confirms that level matters, but it does not by itself say
whether to fade or follow the move.

Absorption proxy events are live approximations only. They flag heavy volume
with balanced aggressor delta at a fixed price. True absorption still comes from
post-session MBP1-based analytics.

Delta dislocations flag a 60-minute candle moving one way while CVD moves the
other way at a nearby key level. Long-side means price fell while CVD was
positive; short-side means price rose while CVD was negative. If the card says
`low tail span`, the dashboard states the confidence issue in the
tooltip/posture. Dislocation multipliers still degrade on low-tail confidence.

Institutional flow classifies trade sizes as retail, mixed, institutional, or
block using `data/live_analysis/trade_size_thresholds.json` when present and
the approved defaults otherwise: `1-9`, `10-49`, `50-99`, and `>=100`
contracts. It writes broad visibility events for any nearby structural level,
but scenario probability multipliers apply only when those events occur at a
scenario entry zone.

Aggressor Flow is the fast trade-side decomposition. `liftAsk` is aggressive
buy volume; `hitBid` is aggressive sell volume; net is `liftAsk - hitBid`.
The dashboard shows 60-second and 5-minute net values in Orderflow Pulse, with
full 60s/5m/15m/60m metrics available to events. A ratio above `3.0` or below
`0.33` emits `aggressor_imbalance_extreme`.

vDelta is a 30-second signed-volume read. `v_delta_sign_flip` requires the new
sign to persist for 10 seconds before the event is emitted, so brief flickers
around zero do not clutter Recent Signals.

The Footprint card shows the most recent completed 5-minute bar at tick
granularity. Bid volume is aggressive selling at a price; ask volume is
aggressive buying at a price. Imbalance is `(ask - bid) / total`. Three or more
adjacent prices with same-side imbalance above `0.30` emit
`stacked_footprint_imbalance` and can create Distance Grid badges/stack banners
near the matching level.

Day type is RTH-only structural conditioning from auction market theory. The
classifier writes current state to
`data/live_analysis/<date>_rth_day_type.json`, appends classification/revision
and IB events to `<date>_rth_day_type.jsonl`, and logs session-close
provenance to `day_type_outcomes.jsonl`. It reads normalized
`data/captures/<date>/MNQ_rth.obs01.jsonl` first and falls back to the raw
`MNQ_rth.jsonl`. If neither exists, it emits
`day_type_skipped_no_capture_data` and applies no multiplier.

Scenario probability tooltips show every active multiplier. Examples:

- `cvd_direction_match x1.20`: live CVD supports the scenario direction.
- `cvd_direction_oppose x0.80`: live CVD opposes the scenario direction.
- `volume_velocity_quiet x0.85`: participation is thin, so signals are less
  reliable.
- `recent_sweep_at_entry x1.10`: an unrecovered sweep touched the entry zone.
- `delta_dislocation_at_entry x1.25`: candle and CVD diverged at the entry
  level. A low-tail-span event displays `x1.15` instead.
- `institutional_flow_match x1.20`: institutional concentration aligns with
  the scenario direction at entry.
- `institutional_flow_oppose x0.80`: institutional concentration opposes the
  scenario direction at entry.
- `block_trade_at_entry x1.15`: a block trade aligns with the scenario
  direction at entry.
- `day_type_trend_day_up_long x1.25`: RTH structure favors long continuation
  after the live-event factors have already been composed.
- `day_type_trend_day_up_mean_reversion x0.60`: trend-day structure discounts
  fade/mean-reversion setups after live-event factors.

Day-type factors apply last. The tooltip keeps all pre-day-type live-event
factors visible, then shows the day-type factor and the final cap if the raw
composition exceeded `[0.4, 1.6]`.

Run threshold calibration manually or from Task Scheduler when enough sessions
exist:

```powershell
cd D:\Quant-futures-app\tools\rithmic_dashboard
python -m rithmic_dashboard.cli.calibrate_thresholds --symbol MNQ --lookback-sessions 20
python -m rithmic_dashboard.cli.calibrate_trade_size_thresholds --symbol MNQ --lookback-sessions 7
```

Both CLIs are idempotent and write atomically under `data/live_analysis/`. They
exit non-zero when fewer than the requested sessions are available.

The probabilities remain heuristic priors, not calibrated win rates. The
calibration logs collect the evidence needed to replace these multipliers after
enough completed scenarios accumulate.

Audit Trail remains the capped rolling backstop for state transitions and live
events. The Recent Signals panel is the primary place to read current sweep,
absorption, dislocation, institutional-flow, aggressor-flow, day-type, and
volatility-regime prominence. Missing data warnings appear in the header warning
panel and should not appear in audit history.

## Troubleshooting

- Zones warning: expected during an active session before post-session zones are
  produced. The loader falls back to the latest available zones JSON.
- Missing pressure summary: expected if pressure compute timed out or has not run.
  CVD/spread/absorption still render when available.
- Corrupt state file: generator quarantines corrupt JSON as
  `*.broken_<timestamp>` and starts fresh.
- Runtime over 60 seconds: check whether a cache was invalidated and a large
  normalized trade file was reprocessed. Subsequent runs should return to the
  cached path.
- No live sweeps/absorption: normal during quiet periods or when the active
  capture tail lacks enough trade rows. The structural dashboard remains valid.
- Probability looks lower despite good structure: inspect the tooltip. CVD
  opposition, quiet velocity, or momentum flip likely discounted the setup.
