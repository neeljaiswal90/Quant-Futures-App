# Task Scheduler setup runbook (RA-011)

This document is the operator playbook for the five Windows Task Scheduler
entries that run the continuous-capture pipeline. **The install script does
NOT execute automatically — Neel runs it manually after the validation pass
below.**

## Prerequisites (one-time setup)

1. `pip install -e .` from the `rithmic_analytics` project root (so `python -m
   rithmic_analytics.cli.*` works).
2. Five `RITHMIC_*` environment variables set **system-wide** (not per-user):
   `RITHMIC_CONNECT_POINT`, `RITHMIC_SYSTEM_NAME`, `RITHMIC_USER`,
   `RITHMIC_PASSWORD`, `RITHMIC_RPROTOCOL_HOME`. Set via *System Properties →
   Environment Variables → System variables*. Task Scheduler-launched
   processes inherit only system-wide vars reliably.
3. System timezone is **America/New_York**. The install script registers
   triggers in *local* system time; ET times only work if local is ET. If
   your laptop is in a different timezone, adjust the script's `Hour`/`Minute`
   fields or change the system timezone.
4. ≥250 GB free disk space on the volume containing `data/captures`. The
   install script enforces this gate.

## Manual validation pass — do this BEFORE running `install_scheduled_tasks.ps1`

The install script's gates check structural correctness. They cannot
validate that the Rithmic credentials actually work. Validate the live
pipeline manually first:

### Step 1 — Dry-run

From a normal (non-elevated) PowerShell:

```powershell
python -m rithmic_analytics.cli.start_capture --root-symbol MNQ --session rth --dry-run
```

Expect: a single log line printing the probe invocation. Exit code 0. **No
subprocess launched.**

### Step 2 — Short live run on a Saturday afternoon

The validation window is **Saturday between 12:00 and 16:00 ET** — Rithmic is
open for test-connection auth, no active market data is flowing, no risk of
the test interfering with real captures. Run:

```powershell
python -m rithmic_analytics.cli.start_capture `
    --root-symbol MNQ `
    --session rth `
    --captures-root C:\temp\rithmic_validation `
    --override-duration-sec 300
```

The wrapper will:
- Resolve the active front-month contract via the rollover calendar
- Load credentials from env vars
- Compute the RTH window (which is closed on Saturday) — note that
  `start_capture` requires the wall-clock to be IN the configured session
  window, so for a Saturday test you may need to temporarily edit
  `cli/start_capture.py`'s window logic, OR pass `--session globex` (which
  spans across the weekend differently — check the trading-date convention
  in `architecture.md` D-003). The cleanest test is during the **Sunday
  17:55 ET → 09:30 Monday** Globex window when Rithmic is live and the
  capture pipeline runs normally.

Expect:
- A JSONL file at `C:\temp\rithmic_validation\<trading-date>\MNQ_<session>.jsonl`
- `wrapper.log` alongside it with the probe stdio
- Wrapper exit code 0 (clean shutdown) or 1 (probe ran with errors — inspect
  alerts.ndjson; usually fine for a short test)

Inspect:

```powershell
Get-Content C:\temp\rithmic_validation\<date>\MNQ_<session>.jsonl | Select-Object -First 1
```

Expect a TRADE envelope JSON with `payload.exchange_event_ts_ns`,
`payload.price`, `payload.aggressor_side`, etc. If you see this, the live
path works.

### Step 3 — Register the scheduled tasks

ONLY after Step 2 succeeds:

```powershell
# Open elevated PowerShell (Run as Administrator)
cd D:\Quant-futures-app\tools\rithmic_analytics
.\rithmic_analytics\ops\install_scheduled_tasks.ps1 -WhatIf  # preview first
.\rithmic_analytics\ops\install_scheduled_tasks.ps1
```

Verify each task appears:

```powershell
schtasks /Query /TN RithmicCapture_RTH
schtasks /Query /TN RithmicCapture_Globex
schtasks /Query /TN RithmicDailyZones
schtasks /Query /TN RithmicRotation
schtasks /Query /TN RithmicHeartbeat
```

## The five scheduled tasks

| Task | Schedule (system local time) | Invokes |
|---|---|---|
| `RithmicCapture_RTH` | Mon–Fri 09:24 | `python -m rithmic_analytics.cli.start_capture --root-symbol MNQ --session rth` |
| `RithmicCapture_Globex` | Sun–Thu 17:54 | `python -m rithmic_analytics.cli.start_capture --root-symbol MNQ --session globex` |
| `RithmicDailyZones` | Mon–Fri 17:30 | `python -m rithmic_analytics.cli.daily_zones` |
| `RithmicRotation` | Daily 02:00 | `python -m rithmic_analytics.cli.rotate` |
| `RithmicHeartbeat` | Daily 10:00 | `python -m rithmic_analytics.cli.heartbeat` |

All tasks register with `-StartWhenAvailable` so missed windows fire when
the system wakes (within Task Scheduler's default skew tolerance).

## Reboot behavior

Tasks persist across reboots. No action required after a normal reboot —
the next scheduled fire happens automatically. If the laptop was off
during a scheduled time, Task Scheduler will fire that task at the next
boot opportunity (per `-StartWhenAvailable`).

## Credentials rotation (Rithmic password changes)

When the Rithmic account password changes:

1. Update `RITHMIC_PASSWORD` via *System Properties → Environment Variables*
   (system-wide).
2. Confirm in a new PowerShell session:
   ```powershell
   python -m rithmic_analytics.cli.start_capture --root-symbol MNQ --session rth --dry-run
   ```
3. **No need to re-register tasks** — they read env vars at invocation time.
4. Wait for the next scheduled fire OR run a manual `--override-duration-sec 60`
   test to validate end-to-end.

## Uninstall

```powershell
# Elevated PowerShell
.\rithmic_analytics\ops\uninstall_scheduled_tasks.ps1
```

This removes all five tasks. Capture data, archives, alerts, and env vars
are NOT touched.

## Troubleshooting

### Task shows "Last Run Result: 0x1" or non-zero

Open the wrapper log for that session:
```powershell
Get-Content data\captures\<date>\wrapper.log -Tail 50
```

Exit code semantics (from `start_capture.py`):
- `0` — probe exited cleanly
- `1` — probe ran but reported errors (check `data/alerts/alerts.ndjson`)
- `2` — wrapper pre-flight failed (bad creds, calendar miss, output dir
  uncreatable, scheduled too far before window)
- `3` — probe pre-flight failed (connectivity / credentials rejected by
  Rithmic)
- `130` — SIGINT received during supervision

### Task did not fire at all (no `wrapper.log` for today)

Two possibilities:
1. Task is disabled or deleted: `schtasks /Query /TN RithmicCapture_RTH`
2. System was off during the window. `RithmicHeartbeat` will detect this
   and append a `CAPTURE_HEARTBEAT_MISSING` line to `alerts.ndjson` the
   next time it runs.

### `python` not found from Task Scheduler

The install script defaults `-PythonPath python`, which Task Scheduler
resolves via PATH. If PATH is limited under the task user account, pass an
absolute path:

```powershell
.\install_scheduled_tasks.ps1 -PythonPath "C:\Users\Neel\AppData\Local\Programs\Python\Python312\python.exe"
```

### Heartbeat missing alerts firing every day

Inspect `alerts.ndjson` for the `CAPTURE_HEARTBEAT_MISSING` records. If the
heartbeat task itself isn't firing (Windows Update edge case), the next day's
heartbeat will detect the previous-day miss. If Windows Update repeatedly
clobbers the task, see the external-monitoring note in `future_work.md`.
