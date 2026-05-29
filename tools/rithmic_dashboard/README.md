# Rithmic Dashboard

Realtime MNQ futures dashboard support package. The old static V1 HTML page at
`data/dashboard/index.html` is retired; the active view is the v2 realtime
stack launched from the repository tools root:

```powershell
D:\Quant-futures-app\run_realtime_stack.ps1
```

The data pipeline remains here. `scripts/run_local_probe_refresh.ps1` still
normalizes active captures and runs intraday-light analytics so the v2 backend
has fresh normalized siblings and zone/live-analysis artifacts.

```powershell
cd D:\Quant-futures-app\tools\rithmic_dashboard
.\scripts\run_local_probe_refresh.ps1 -TradingDate 2026-05-29 -Session rth -Loop -IntervalMinutes 5
```

Default behavior:

- Incremental normalize to OBS-01/MBP1/MBO siblings.
- `daily_zones --mode light` with absorption, probability cards, and adaptive bins.
- No pressure/cancellation full MBO scan.
- No V1 HTML generation.

For EOD/full analytics after RTH close:

```powershell
.\scripts\run_eod_full_analytics.ps1 -TradingDate <YYYY-MM-DD> -Session rth
```

That path keeps the full normalize plus `daily_zones --mode full` behavior, but
also no longer generates V1 HTML.

Useful options:

```powershell
# Check the exact commands without running analytics
.\scripts\run_local_probe_refresh.ps1 -DryRun

# Process a specific session/date
.\scripts\run_local_probe_refresh.ps1 -TradingDate 2026-05-29 -Session rth

# Keep it running locally every 5 minutes
.\scripts\run_local_probe_refresh.ps1 -Loop

# Cutover-only: use after RA60_SELF_NORMALIZE=1 is enabled on the backend
.\scripts\run_local_probe_refresh.ps1 -SkipNormalize

# Try threshold calibration too; exits nonzero only inside that optional step
.\scripts\run_local_probe_refresh.ps1 -TryCalibrateThresholds -LookbackSessions 20
```

`python -m rithmic_dashboard.cli.generate` is intentionally retired and exits
non-zero with v2 guidance. The historical implementation is archived under
`rithmic_dashboard/legacy_v1/` for reference only.

## Signal Pipeline

The package still owns the completed RA-046 through RA-059 signal modules:
live CVD, sweeps, absorption proxy, delta dislocations, institutional flow,
EWMA volatility regime, aggressor flow, footprint, and iceberg detection.
These modules are reused by the v2 backend as library code.

Audit trail and calibration artifacts remain under `data/live_analysis/` and
`data/dashboard/` as compatibility data/log locations. They are not a static
HTML dashboard surface anymore.
