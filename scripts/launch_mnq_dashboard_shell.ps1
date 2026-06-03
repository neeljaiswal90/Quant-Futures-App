<#
.SYNOPSIS
  One-click launcher for the MNQ Tauri dashboard shell.

.DESCRIPTION
  Starts only the downstream dashboard stack:

    1. Realtime backend with self-normalize enabled.
    2. Dashboard upkeep loop with -SkipNormalize.
    3. Tauri desktop dashboard shell.

  It intentionally does NOT start, stop, or supervise Rithmic capture. Capture
  remains owned by the external Globex/RTH automations.

  Depth output is backend startup configuration. The launcher enables depth by
  default for the desktop shell and publishes 20 ticks per side unless
  -DepthNTicks is supplied. The backend/contract cap is 200 (RA-104b raised
  from 100). Operator sets -DepthNTicks 200 for the widest Bookmap-parity
  ±50pt window; default 20 stays the quiet near-price scalping profile.
#>
[CmdletBinding()]
param(
    [string]$TradingDate = "",
    [ValidateSet("auto", "globex", "rth")]
    [string]$Session = "auto",
    [string]$RootSymbol = "MNQ",
    [int]$Port = 8765,
    [int]$IntervalMinutes = 5,
    [string]$Python = "C:\Users\Neel\AppData\Local\Programs\Python\Python312\python.exe",
    [string]$AnalyticsRoot = "D:\Quant-futures-app\tools\rithmic_analytics",
    [string]$DashboardRoot = "D:\Quant-futures-app\tools\rithmic_dashboard",
    [switch]$NoDepth,
    [ValidateRange(1, 200)]
    [int]$DepthNTicks = 20,
    [switch]$NoRefresh,
    [switch]$VisibleStackWindows,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ServicesRoot = Join-Path $RepoRoot "services"
$ShellRoot = Join-Path $RepoRoot "apps\dashboard_shell"
$ShellExe = Join-Path $ShellRoot "src-tauri\target\release\mnq-dashboard-shell.exe"
$RefreshScript = Join-Path $DashboardRoot "scripts\run_local_probe_refresh.ps1"
$LogRoot = Join-Path $DashboardRoot "data\dashboard\shell_launcher_logs"

function Write-Status {
    param([string]$Message, [string]$Color = "Gray")
    Write-Host ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message) -ForegroundColor $Color
}

function Resolve-Python {
    param([string]$Candidate)
    if (Test-Path $Candidate) {
        return $Candidate
    }
    return "python"
}

function Quote-PS {
    param([string]$Value)
    return "'" + ($Value -replace "'", "''") + "'"
}

function Set-EnvStatement {
    param([string]$Name, [string]$Value)
    return "`$env:$Name = $(Quote-PS $Value)"
}

function Get-ProcessMatches {
    param([string[]]$Contains)
    Get-CimInstance Win32_Process | Where-Object {
        $cmd = $_.CommandLine
        if ([string]::IsNullOrWhiteSpace($cmd)) {
            return $false
        }
        foreach ($needle in $Contains) {
            if ($cmd -notlike "*$needle*") {
                return $false
            }
        }
        return $true
    }
}

function Test-BackendHealth {
    param([int]$BackendPort)
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$BackendPort/health" -TimeoutSec 2
        return $resp.status -eq "ok"
    } catch {
        return $false
    }
}

function Wait-BackendHealth {
    param([int]$BackendPort, [int]$TimeoutSeconds = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-BackendHealth -BackendPort $BackendPort) {
            return $true
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-NormalizeStatePath {
    param([string]$CaptureSource)
    if ([string]::IsNullOrWhiteSpace($CaptureSource)) {
        return $null
    }
    $captureItem = Get-Item -LiteralPath $CaptureSource -ErrorAction SilentlyContinue
    if ($null -eq $captureItem) {
        return $null
    }
    $name = $captureItem.Name
    if ($name.EndsWith(".obs01.jsonl")) {
        $stateName = $name.Substring(0, $name.Length - ".obs01.jsonl".Length) + ".obs01.normalize_state.json"
    } elseif ($name.EndsWith(".jsonl")) {
        $stateName = $name.Substring(0, $name.Length - ".jsonl".Length) + ".obs01.normalize_state.json"
    } else {
        return $null
    }
    return Join-Path $captureItem.DirectoryName $stateName
}

function Get-NormalizeStateMarker {
    param([string]$StatePath)
    if ([string]::IsNullOrWhiteSpace($StatePath) -or -not (Test-Path -LiteralPath $StatePath)) {
        return $null
    }
    try {
        $item = Get-Item -LiteralPath $StatePath -ErrorAction Stop
        $raw = Get-Content -LiteralPath $StatePath -Raw -ErrorAction Stop
        $json = $raw | ConvertFrom-Json -ErrorAction Stop
        return [pscustomobject]@{
            LastNormalizedAt = [string]$json.last_normalized_at
            LastByteOffset = [int64]$json.last_byte_offset
            LastWriteTime = $item.LastWriteTimeUtc
        }
    } catch {
        return $null
    }
}

function Wait-NormalizeProgress {
    param(
        [string]$StatePath,
        [object]$BaselineMarker,
        [datetime]$BackendLaunchUtc,
        [int]$TimeoutSeconds = 30
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $marker = Get-NormalizeStateMarker -StatePath $StatePath
        if ($null -ne $marker) {
            $advanced = $false
            if ($null -eq $BaselineMarker) {
                $advanced = $marker.LastWriteTime -ge $BackendLaunchUtc
            } else {
                $advanced = (
                    $marker.LastByteOffset -gt $BaselineMarker.LastByteOffset -or
                    $marker.LastNormalizedAt -ne $BaselineMarker.LastNormalizedAt -or
                    $marker.LastWriteTime -gt $BaselineMarker.LastWriteTime
                )
            }
            if ($advanced) {
                return $marker
            }
        }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

function Start-LoggedPowerShell {
    param(
        [string]$Title,
        [string]$WorkingDirectory,
        [string]$Command,
        [string]$LogPrefix
    )

    New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
    if ($DryRun) {
        Write-Status "DRY start $Title" "Cyan"
        Write-Host "  cwd: $WorkingDirectory"
        Write-Host "  cmd: $Command"
        return
    }
    if ($VisibleStackWindows) {
        $visibleCommand = "`$host.UI.RawUI.WindowTitle = $(Quote-PS $Title); $Command"
        Start-Process -FilePath "powershell.exe" -ArgumentList @(
            "-NoExit",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            $visibleCommand
        ) -WorkingDirectory $WorkingDirectory | Out-Null
        Write-Status "STARTED $Title (visible window)" "Green"
        return
    }

    $stdoutPath = Join-Path $LogRoot "$LogPrefix.out.log"
    $stderrPath = Join-Path $LogRoot "$LogPrefix.err.log"
    Start-Process -FilePath "powershell.exe" -ArgumentList @(
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        $Command
    ) -WorkingDirectory $WorkingDirectory -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath | Out-Null
    Write-Status "STARTED $Title (logs: $stdoutPath / $stderrPath)" "Green"
}

function Build-CommonPythonPath {
    $parts = @(
        $RepoRoot,
        $ServicesRoot,
        (Join-Path $RepoRoot "contracts"),
        $DashboardRoot,
        $AnalyticsRoot
    )
    return ($parts | Where-Object { Test-Path $_ }) -join ";"
}

function Resolve-CaptureContext {
    param(
        [string]$RequestedTradingDate,
        [string]$RequestedSession
    )

    $captureRoot = Join-Path $AnalyticsRoot "data\captures"
    if (-not (Test-Path $captureRoot)) {
        return [pscustomobject]@{
            TradingDate = $RequestedTradingDate
            Session = $RequestedSession
            LastWrite = $null
            Source = ""
        }
    }

    $sessions = if ($RequestedSession -eq "auto") { @("globex", "rth") } else { @($RequestedSession) }
    $directories = if ([string]::IsNullOrWhiteSpace($RequestedTradingDate)) {
        @(Get-ChildItem -Path $captureRoot -Directory -ErrorAction SilentlyContinue)
    } else {
        @(Get-Item -Path (Join-Path $captureRoot $RequestedTradingDate) -ErrorAction SilentlyContinue)
    }

    $candidates = @()
    foreach ($dir in $directories) {
        foreach ($candidateSession in $sessions) {
            foreach ($suffix in @(".jsonl", ".obs01.jsonl", ".mbo.jsonl", ".mbp1.jsonl")) {
                $candidatePath = Join-Path $dir.FullName ("{0}_{1}{2}" -f $RootSymbol, $candidateSession, $suffix)
                if (Test-Path $candidatePath) {
                    $item = Get-Item $candidatePath
                    $candidates += [pscustomobject]@{
                        TradingDate = $dir.Name
                        Session = $candidateSession
                        LastWrite = $item.LastWriteTime
                        Source = $item.FullName
                    }
                }
            }
        }
    }

    if ($candidates.Count -eq 0) {
        return [pscustomobject]@{
            TradingDate = $RequestedTradingDate
            Session = $RequestedSession
            LastWrite = $null
            Source = ""
        }
    }

    return ($candidates | Sort-Object LastWrite -Descending | Select-Object -First 1)
}

function Ensure-ShellExecutable {
    if (Test-Path $ShellExe) {
        return
    }

    if ($DryRun) {
        Write-Status "DRY shell build because executable is missing: $ShellExe" "Cyan"
        return
    }

    Write-Status "Tauri shell executable missing; building it once..." "Yellow"
    $cargoBin = "C:\Users\Neel\.cargo\bin"
    if (Test-Path $cargoBin) {
        $env:PATH = "$cargoBin;$env:PATH"
    }
    if (-not (Test-Path (Join-Path $ShellRoot "node_modules"))) {
        Push-Location $ShellRoot
        try {
            npm install
        } finally {
            Pop-Location
        }
    }
    Push-Location $ShellRoot
    try {
        npm run build
    } finally {
        Pop-Location
    }
    if (-not (Test-Path $ShellExe)) {
        throw "Tauri shell build completed but executable was not found: $ShellExe"
    }
}

$PythonExe = Resolve-Python -Candidate $Python
$CommonPythonPath = Build-CommonPythonPath
$DepthEnabled = -not $NoDepth
$CaptureContext = Resolve-CaptureContext -RequestedTradingDate $TradingDate -RequestedSession $Session
$ResolvedTradingDate = $CaptureContext.TradingDate
$ResolvedSession = $CaptureContext.Session
$PinBackendContext = $Session -ne "auto"
$NormalizeStatePath = Get-NormalizeStatePath -CaptureSource $CaptureContext.Source

Write-Status "MNQ dashboard shell launch requested" "Green"
Write-Status "capture lifecycle: external Globex/RTH automations only; this launcher will not start/stop Rithmic capture" "Yellow"
Write-Status ("backend self-normalize: ON; depth stream: {0}; n_ticks: {1}" -f ($(if ($DepthEnabled) { "ON" } else { "OFF" }), $DepthNTicks)) "Yellow"
if (-not [string]::IsNullOrWhiteSpace($CaptureContext.Source)) {
    Write-Status ("capture context: {0} {1} from {2}" -f $ResolvedTradingDate, $ResolvedSession, $CaptureContext.Source) "Yellow"
    if ($null -ne $CaptureContext.LastWrite -and $CaptureContext.LastWrite -lt (Get-Date).AddMinutes(-2)) {
        Write-Status ("capture appears stale; latest write {0}" -f $CaptureContext.LastWrite) "Red"
    }
} else {
    Write-Status "capture context: no matching capture file found; backend will use its own default resolution" "Yellow"
}
if ($PinBackendContext) {
    Write-Status "backend capture context: pinned by explicit -Session" "Yellow"
} else {
    Write-Status "backend capture context: auto-resolved continuously; not pinning session/date from latest file" "Yellow"
}
if (-not [string]::IsNullOrWhiteSpace($NormalizeStatePath)) {
    Write-Status ("normalize state target: {0}" -f $NormalizeStatePath) "Yellow"
}

foreach ($path in @($ServicesRoot, $ShellRoot, $DashboardRoot, $AnalyticsRoot, $RefreshScript)) {
    if (-not (Test-Path $path)) {
        throw "required path missing: $path"
    }
}

$refreshProcesses = @(Get-ProcessMatches -Contains @("run_local_probe_refresh.ps1"))
$normalizingRefresh = @($refreshProcesses | Where-Object { $_.CommandLine -notlike "*-SkipNormalize*" })
if ($normalizingRefresh.Count -gt 0) {
    Write-Status "REFUSING: backend self-normalize would overlap with an existing normalizing refresh loop." "Red"
    $normalizingRefresh | ForEach-Object {
        Write-Host ("  pid={0} cmd={1}" -f $_.ProcessId, $_.CommandLine)
    }
    throw "Stop the existing normalizing refresh loop first."
}

if (-not $NoRefresh) {
    if ($refreshProcesses.Count -gt 0) {
        Write-Status "refresh upkeep loop already running; not starting duplicate" "Yellow"
    } else {
        $refreshArgs = @(
            "-File", (Quote-PS $RefreshScript),
            "-Session", $ResolvedSession,
            "-RootSymbol", $RootSymbol,
            "-Python", (Quote-PS $PythonExe),
            "-AnalyticsRoot", (Quote-PS $AnalyticsRoot),
            "-DashboardRoot", (Quote-PS $DashboardRoot),
            "-Loop",
            "-IntervalMinutes", "$IntervalMinutes",
            "-ClearPauseFlag",
            "-ContinueOnError",
            "-SkipNormalize"
        )
        if (-not [string]::IsNullOrWhiteSpace($ResolvedTradingDate)) {
            $refreshArgs += @("-TradingDate", $ResolvedTradingDate)
        }
        $refreshCommand = "& powershell.exe -NoProfile -ExecutionPolicy Bypass $($refreshArgs -join ' ')"
        Start-LoggedPowerShell -Title "mnq-refresh-upkeep" `
            -WorkingDirectory $DashboardRoot `
            -Command $refreshCommand `
            -LogPrefix "refresh_upkeep"
    }
} else {
    Write-Status "SKIP refresh upkeep loop (-NoRefresh)" "Yellow"
}

$backendLaunchUtc = $null
$normalizeBaseline = $null
$startedFreshBackend = $false
if (Test-BackendHealth -BackendPort $Port) {
    Write-Status "backend already healthy on port $Port; not starting duplicate" "Yellow"
    Write-Status "note: depth/self-normalize env changes only apply when this launcher starts a fresh backend" "Yellow"
} else {
    $backendLaunchUtc = (Get-Date).ToUniversalTime()
    $normalizeBaseline = Get-NormalizeStateMarker -StatePath $NormalizeStatePath
    $startedFreshBackend = $true
    $backendStatements = @(
        (Set-EnvStatement -Name "PYTHONPATH" -Value $CommonPythonPath),
        (Set-EnvStatement -Name "RA60_ANALYTICS_ROOT" -Value $AnalyticsRoot),
        (Set-EnvStatement -Name "RA60_SELF_NORMALIZE" -Value "1"),
        (Set-EnvStatement -Name "RA60_DEPTH_ENABLED" -Value ($(if ($DepthEnabled) { "1" } else { "0" }))),
        (Set-EnvStatement -Name "RA60_DEPTH_N_TICKS" -Value ([string]$DepthNTicks))
    )
    $backendArgs = @(
        "-m", "realtime_backend",
        "--host", "127.0.0.1",
        "--port", "$Port",
        "--analytics-root", (Quote-PS $AnalyticsRoot)
    )
    if ($PinBackendContext -and $ResolvedSession -ne "auto") {
        $backendArgs += @("--session", $ResolvedSession)
        $backendStatements += (Set-EnvStatement -Name "RA60_SESSION" -Value $ResolvedSession)
    }
    if ($PinBackendContext -and -not [string]::IsNullOrWhiteSpace($ResolvedTradingDate)) {
        $backendArgs += @("--trading-date", $ResolvedTradingDate)
        $backendStatements += (Set-EnvStatement -Name "RA60_TRADING_DATE" -Value $ResolvedTradingDate)
    }
    $backendCommand = ($backendStatements + @("& $(Quote-PS $PythonExe) $($backendArgs -join ' ')")) -join "; "
    Start-LoggedPowerShell -Title "mnq-realtime-backend" `
        -WorkingDirectory $ServicesRoot `
        -Command $backendCommand `
        -LogPrefix "backend"
}

if (-not $DryRun) {
    if (Wait-BackendHealth -BackendPort $Port -TimeoutSeconds 30) {
        Write-Status "backend healthy at http://127.0.0.1:$Port/health" "Green"
        if (-not $startedFreshBackend) {
            # Backend was already running — its normalize-progress was verified when
            # the OWNER launcher started it. Re-verifying here would crash on the
            # uninitialized $backendLaunchUtc and is redundant anyway.
            Write-Status "normalize-state verification skipped (backend was already running before this launcher invocation)" "Yellow"
        } elseif ([string]::IsNullOrWhiteSpace($NormalizeStatePath)) {
            if ($PinBackendContext) {
                throw "backend is healthy, but no normalize_state target could be resolved for the pinned capture context."
            }
            Write-Status "normalize-state verification skipped because no capture path could be resolved" "Yellow"
        } else {
            $normalizeMarker = Wait-NormalizeProgress -StatePath $NormalizeStatePath -BaselineMarker $normalizeBaseline -BackendLaunchUtc $backendLaunchUtc -TimeoutSeconds 30
            if ($null -eq $normalizeMarker) {
                throw "backend is healthy, but normalize_state did not advance within 30s: $NormalizeStatePath"
            }
            Write-Status ("normalize-state advanced: byte_offset={0} last_normalized_at={1}" -f $normalizeMarker.LastByteOffset, $normalizeMarker.LastNormalizedAt) "Green"
        }
    } else {
        Write-Status "backend health not confirmed within 30s; shell will reconnect when backend comes up" "Yellow"
    }
}

Ensure-ShellExecutable

$shellProcesses = @(Get-Process -Name "mnq-dashboard-shell" -ErrorAction SilentlyContinue)
if ($shellProcesses.Count -gt 0) {
    Write-Status "Tauri dashboard shell already running; not starting duplicate" "Yellow"
} elseif ($DryRun) {
    Write-Status "DRY start Tauri dashboard shell" "Cyan"
    Write-Host "  exe: $ShellExe"
} else {
    Start-Process -FilePath $ShellExe -WorkingDirectory $ShellRoot | Out-Null
    Write-Status "STARTED Tauri dashboard shell: $ShellExe" "Green"
}

Write-Host ""
Write-Status "dashboard shell launch complete" "Green"
Write-Host "  backend health : http://127.0.0.1:$Port/health"
Write-Host "  backend ws     : ws://127.0.0.1:$Port/ws"
Write-Host "  shell exe      : $ShellExe"
Write-Host "  logs           : $LogRoot"
Write-Host "  capture        : external automations own start/stop"
