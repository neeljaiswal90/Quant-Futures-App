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

Write-Status "MNQ dashboard shell launch requested" "Green"
Write-Status "capture lifecycle: external Globex/RTH automations only; this launcher will not start/stop Rithmic capture" "Yellow"
Write-Status ("backend self-normalize: ON; depth stream: {0}" -f ($(if ($DepthEnabled) { "ON" } else { "OFF" }))) "Yellow"

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
            "-Session", $Session,
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
        if (-not [string]::IsNullOrWhiteSpace($TradingDate)) {
            $refreshArgs += @("-TradingDate", $TradingDate)
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

if (Test-BackendHealth -BackendPort $Port) {
    Write-Status "backend already healthy on port $Port; not starting duplicate" "Yellow"
    Write-Status "note: depth/self-normalize env changes only apply when this launcher starts a fresh backend" "Yellow"
} else {
    $backendStatements = @(
        (Set-EnvStatement -Name "PYTHONPATH" -Value $CommonPythonPath),
        (Set-EnvStatement -Name "RA60_ANALYTICS_ROOT" -Value $AnalyticsRoot),
        (Set-EnvStatement -Name "RA60_SELF_NORMALIZE" -Value "1"),
        (Set-EnvStatement -Name "RA60_DEPTH_ENABLED" -Value ($(if ($DepthEnabled) { "1" } else { "0" })))
    )
    $backendArgs = @(
        "-m", "realtime_backend",
        "--host", "127.0.0.1",
        "--port", "$Port",
        "--analytics-root", (Quote-PS $AnalyticsRoot)
    )
    if ($Session -ne "auto") {
        $backendArgs += @("--session", $Session)
        $backendStatements += (Set-EnvStatement -Name "RA60_SESSION" -Value $Session)
    }
    if (-not [string]::IsNullOrWhiteSpace($TradingDate)) {
        $backendArgs += @("--trading-date", $TradingDate)
        $backendStatements += (Set-EnvStatement -Name "RA60_TRADING_DATE" -Value $TradingDate)
    }
    $backendCommand = ($backendStatements + @("& $(Quote-PS $PythonExe) $($backendArgs -join ' ')")) -join "; "
    Start-LoggedPowerShell -Title "mnq-realtime-backend" `
        -WorkingDirectory $ServicesRoot `
        -Command $backendCommand `
        -LogPrefix "backend"
}

if (Wait-BackendHealth -BackendPort $Port -TimeoutSeconds 30) {
    Write-Status "backend healthy at http://127.0.0.1:$Port/health" "Green"
} else {
    Write-Status "backend health not confirmed within 30s; shell will reconnect when backend comes up" "Yellow"
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
