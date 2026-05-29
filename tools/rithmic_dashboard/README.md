# Rithmic Dashboard

Local static dashboard for MNQ futures prep, generated from the sibling
`rithmic_analytics` data artifacts. The generated page is written to
`data/dashboard/index.html` and is safe to open directly with a browser.

Run:

```powershell
python -m rithmic_dashboard.cli.generate --output-path data\dashboard\index.html
```

To run the full local probe-to-dashboard refresh from a terminal, use:

```powershell
.\scripts\run_local_probe_refresh.ps1
```

That script finds the latest `MNQ_*.jsonl` raw probe capture, normalizes it to
OBS-01/MBP1/MBO siblings incrementally, runs `daily_zones --mode light` with
absorption, probability cards, and adaptive bins, then regenerates the dashboard
HTML. Pressure and cancellation scans are EOD-only; use
`.\scripts\run_eod_full_analytics.ps1 -TradingDate <YYYY-MM-DD> -Session rth`
after RTH close, or explicitly pass `-EmitHeavyAnalytics` for a one-off full run.

Useful options:

```powershell
# Check the exact commands without running heavy analytics
.\scripts\run_local_probe_refresh.ps1 -DryRun

# Process a specific session/date and open the dashboard afterward
.\scripts\run_local_probe_refresh.ps1 -TradingDate 2026-05-22 -Session rth -OpenDashboard

# Keep it running locally in your terminal every 5 minutes
.\scripts\run_local_probe_refresh.ps1 -Loop

# Remove the dashboard pause banner before rendering
.\scripts\run_local_probe_refresh.ps1 -ClearPauseFlag

# Try threshold calibration too; exits nonzero only inside that optional step
.\scripts\run_local_probe_refresh.ps1 -TryCalibrateThresholds -LookbackSessions 20
```

## RA-045/RA-046 sections

The loader now merges the selected volume-profile envelope with same-date RTH
statistical reference lines. Combined session VP remains the structural source
for VPOC/VAH/VAL/HVN/LVN, while RTH VWAP and sigma bands are overlaid for
distance and scenario logic. If `+/-2sd` lines are absent upstream, the dashboard
derives them from VWAP and `+/-1sd` so the grid always shows VWAP, `+1sd`,
`-1sd`, `+2sd`, and `-2sd`.

The Active Posture block is a three-sentence scan layer: price regime, active or
watching scenarios, then CVD confirmation/contradiction. It is informational and
does not place or recommend trades.

The Orderflow Pulse reads completed local artifacts only: normalized trades for
session and last-60-minute CVD, MBP1 for recent spread quality, absorption JSON
for the latest emitted event, and order-pressure summary JSON for top spoof bins.
Missing artifacts render as `n/a` with a visible warning; one missing orderflow
source never blocks the rest of the page.

RA-046 adds bounded-tail live signals from the active capture: rolling live
VWAP, session/60m/15m CVD, volume velocity, structural sweeps, and absorption
proxy events. These feed transparent probability multipliers in the scenario
tooltips and write provenance logs under `data/live_analysis/`.

Audit trail entries are now restricted to actionable state-machine events.
Data-quality warnings stay in the header warning panel, and identical actionable
entries inside five minutes are collapsed.

Pause automation by creating:

```powershell
New-Item -ItemType File data\dashboard\_pause.flag
```

Resume by deleting that flag.
