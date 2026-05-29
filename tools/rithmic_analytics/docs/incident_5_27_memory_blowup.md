# 2026-05-27 Memory Blowup Post-Mortem

## Summary

During the 2026-05-27 RTH session, a Python process tied to the dashboard
refresh path consumed roughly 20GB resident memory and reached a much larger
private working set during a full MBO/order-lifecycle analytics pass. This
degraded the trading workstation and made the dashboard loop unsafe for
sustained live use.

## Impact

- Dashboard refresh became expensive enough to threaten the local machine.
- The capture/probe process itself was not the primary memory consumer.
- Live capture continuity was at risk because the analytics consumer was
  competing with the probe for local resources.

## Root Cause

`run_local_probe_refresh.ps1` was being used as a 5-minute intraday loop and
was invoking:

```powershell
python -m rithmic_analytics.cli.daily_zones `
  --emit-pressure-json `
  --emit-cancellation-analysis
```

Those flags load full MBO/order lifecycle state and perform groupby-style
analytics intended for EOD review. On a live-extending RTH capture above 20GB,
that work can materialize tens of GB in Python memory. Running it every 5
minutes was the wrong operational tier.

A second, smaller but still important issue was also found: the same loop was
running full `normalize --force` every cycle. The immediate stopgap removed
the heaviest MBO analytics, but full re-normalization still re-scanned the
entire raw capture every five minutes.

## Immediate Stopgap

On 2026-05-27, `run_local_probe_refresh.ps1` was patched with an
`-EmitHeavyAnalytics` opt-in switch:

- Default loop: skips pressure/cancellation analytics.
- Opt-in/EOD path: adds pressure/cancellation analytics intentionally.

This brought the live loop back into a usable range, but it was still a
degraded path because normalization remained full-file.

## Permanent RA-052 Fix

RA-052 formalizes the split:

- `daily_zones --mode light`: intraday-safe, rejects heavy MBO flags.
- `daily_zones --mode full`: EOD-heavy, permits pressure/cancellation scans.
- `normalize_probe_incremental`: appends only new normalized records based on
  a byte-offset state file.
- `run_eod_full_analytics.ps1`: dedicated EOD/full analytics script.
- Tests assert light mode does not call heavy emitters.
- Slow RSS smoke is opt-in via `RUN_RA052_RSS_SMOKE=1`.

## Monitoring Rules

- In the 5-minute loop, command lines should include `--mode light`.
- In the 5-minute loop, command lines should not include
  `--emit-pressure-json` or `--emit-cancellation-analysis`.
- Repeated `_audit.json` events with
  `event_type: normalize_state_missing_fallback_full` in the same session
  indicate the incremental state is not sticking. Investigate state-file
  atomicity, output deletion, or raw file shrink/rotation.
- Use `-EmitHeavyAnalytics` only for explicit full/EOD runs.

## Follow-Up Gap

RA-052 found no dedicated `session_combined` CLI. The EOD script logs this as
a warning instead of inventing a new tool in this ticket. RA-053 tracks the
missing EOD prep CLI separately.
