<#
.SYNOPSIS
  Post-crash MBP1 sibling repair, sequenced for end-of-globex quiesce.

.DESCRIPTION
  Recovery flow for the 2026-06-03 system crash:

    1. Wait for capture probe to exit (it ends at ~13:04:54 PT given
       --duration-sec 16854 from 8:24 AM). Bail if probe still running
       after grace period — operator should investigate.
    2. Kill the realtime backend so self-normalize releases the MBP1
       sibling file handle.
    3. Stream-rewrite the MBP1 sibling, skipping malformed lines.
       Write to a .tmp file + manifest sidecar.
    4. Atomic rename: original -> .crashbak; .tmp -> original.
    5. Verify pd.read_json succeeds on the rewritten file.
    6. Restart the realtime backend via the standard launcher.

  The script is idempotent: if no bad lines are found, no rename is
  performed (the repair Python script exits 2; this wrapper treats that
  as a no-op and skips straight to verify + restart).

.PARAMETER TradingDate
  YYYY-MM-DD. Defaults to today's PT date.

.PARAMETER Session
  globex (default) | rth. The MBP1 sibling root is
  data/captures/<date>/MNQ_<session>.mbp1.jsonl.

.PARAMETER ProbeWaitSeconds
  How long to wait for the probe to exit naturally before bailing.
  Default 300s (5 minutes).

.PARAMETER SkipBackendRestart
  Don't restart the dashboard launcher after repair. Useful when
  chaining into another script that owns the restart.
#>
[CmdletBinding()]
param(
    [string]$TradingDate = (Get-Date).ToString('yyyy-MM-dd'),
    [ValidateSet('globex','rth')]
    [string]$Session = 'globex',
    [string]$Symbol = 'MNQ',
    [string]$Python = 'C:\Users\Neel\AppData\Local\Programs\Python\Python312\python.exe',
    [int]$ProbeWaitSeconds = 300,
    [switch]$SkipBackendRestart,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$RepoRoot = 'D:\Quant-futures-app'

# Detect PowerShell host. Task Scheduler under the SYSTEM/current-user account
# may not have pwsh.exe (PS7+) on PATH — only powershell.exe (5.1) is
# guaranteed. The repair script is compatible with both; the script that
# RE-LAUNCHES the dashboard needs a real PS exe, so resolve which one is
# available now rather than hardcoding pwsh.exe. This is the fix for the
# 2026-06-03 task failure (LastTaskResult=2147942402 = ERROR_FILE_NOT_FOUND
# because schtasks /Create /TR "pwsh.exe ..." couldn't find pwsh on the
# scheduler's PATH).
$PsHost = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $PsHost) {
    $PsHost = (Get-Command powershell -ErrorAction SilentlyContinue).Source
}
if (-not $PsHost) {
    throw "no PowerShell (pwsh or powershell) found on PATH"
}

function Write-Status {
    param([string]$Message, [string]$Color = 'Gray')
    Write-Host ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message) -ForegroundColor $Color
}

$mbp1 = Join-Path $RepoRoot "tools\rithmic_analytics\data\captures\$TradingDate\${Symbol}_${Session}.mbp1.jsonl"
$tmp  = "$mbp1.tmp"
$bak  = "$mbp1.crashbak"
$manifest = Join-Path $RepoRoot "scratch\mbp1_repair\${TradingDate}_${Symbol}_${Session}.repair.json"

Write-Status "repair_mbp1_at_eos for $TradingDate $Session" Green
Write-Status "  source: $mbp1" Gray
Write-Status "  tmp   : $tmp" Gray
Write-Status "  bak   : $bak" Gray

if (-not (Test-Path $mbp1)) {
    Write-Status "MBP1 sibling missing — nothing to repair" Yellow
    exit 0
}

# Stage 1: wait for probe to exit
Write-Status "stage 1: wait for probe to exit (timeout ${ProbeWaitSeconds}s)" Cyan
$deadline = (Get-Date).AddSeconds($ProbeWaitSeconds)
while ((Get-Date) -lt $deadline) {
    $probe = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'capture-rithmic-probe.py' }
    if (-not $probe) { Write-Status "  probe exited" Green ; break }
    Start-Sleep -Seconds 5
}
$probe = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'capture-rithmic-probe.py' }
if ($probe) {
    Write-Status "probe still running after ${ProbeWaitSeconds}s; bailing — operator must investigate" Red
    exit 1
}

# Stage 2: bounce backend so self-normalize releases the file handle
Write-Status "stage 2: stop realtime backend" Cyan
$be = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'realtime_backend' -and $_.CommandLine -notmatch 'Where-Object' }
foreach ($p in $be) {
    Write-Status "  stopping pid=$($p.ProcessId)" Yellow
    if (-not $DryRun) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
}
# Also stop the refresh upkeep so it doesn't fire mid-repair
$ru = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'run_local_probe_refresh' }
foreach ($p in $ru) {
    Write-Status "  stopping refresh upkeep pid=$($p.ProcessId)" Yellow
    if (-not $DryRun) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 3

# Stage 3: rewrite
Write-Status "stage 3: stream-rewrite MBP1 sibling" Cyan
New-Item -ItemType Directory -Path (Split-Path $manifest) -Force | Out-Null
$repairScript = Join-Path $RepoRoot 'scripts\maintenance\repair_mbp1_sibling.py'
if ($DryRun) {
    Write-Status "  DRY run; would invoke: $Python $repairScript $mbp1 --tmp $tmp --manifest $manifest" Yellow
} else {
    & $Python $repairScript $mbp1 --tmp $tmp --manifest $manifest
    $rc = $LASTEXITCODE
    if ($rc -eq 0) {
        Write-Status "  repair succeeded; rotating files" Green
        if (Test-Path $bak) { Remove-Item $bak -Force }
        Rename-Item -Path $mbp1 -NewName ([System.IO.Path]::GetFileName($bak))
        Rename-Item -Path $tmp  -NewName ([System.IO.Path]::GetFileName($mbp1))
    } elseif ($rc -eq 2) {
        Write-Status "  no bad lines found — sibling already healthy, no rename" Green
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
    } else {
        Write-Status "  repair script failed rc=$rc" Red
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
        exit 1
    }
}

# Stage 4: verify pd.read_json succeeds on the rewritten file
Write-Status "stage 4: verify load_mbp1 succeeds" Cyan
$verifyExpr = "import sys; sys.path.insert(0, r'$RepoRoot\tools\rithmic_analytics'); from pathlib import Path; from rithmic_analytics.core.loader import load_mbp1; df = load_mbp1(Path(r'$mbp1')); print(f'OK n_records={len(df):,}')"
if ($DryRun) {
    Write-Status "  DRY: would verify via load_mbp1($mbp1)" Yellow
} else {
    & $Python -c $verifyExpr
    if ($LASTEXITCODE -ne 0) {
        Write-Status "  verify FAILED — file may still be corrupted" Red
        exit 1
    }
}

# Stage 5: restart backend
if (-not $SkipBackendRestart) {
    Write-Status "stage 5: restart dashboard launcher" Cyan
    $launcher = Join-Path $RepoRoot 'scripts\launch_mnq_dashboard_shell.ps1'
    $launchLog = Join-Path $RepoRoot "scratch\dashboard_launch_${TradingDate}_post_repair.log"
    if (-not $DryRun) {
        Start-Process -FilePath $PsHost -ArgumentList @(
            '-NoProfile','-ExecutionPolicy','Bypass',
            '-File', $launcher,
            '-Session', $Session,
            '-TradingDate', $TradingDate,
            '-DepthNTicks','100'
        ) -RedirectStandardOutput $launchLog -RedirectStandardError "$launchLog.err" `
          -WorkingDirectory $RepoRoot -WindowStyle Hidden | Out-Null
        Write-Status "  launcher started via $PsHost; log: $launchLog" Gray
    }
} else {
    Write-Status "stage 5: SKIP backend restart (--SkipBackendRestart)" Yellow
}

Write-Status "repair_mbp1_at_eos COMPLETE" Green
