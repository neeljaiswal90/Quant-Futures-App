<#
.SYNOPSIS
  End-of-session shadow-mode pipeline. Runs after capture closes; produces
  setups + labels + predictions + performance for the just-completed session.

.DESCRIPTION
  Five-stage chain:

    1. post_capture_rotate.ps1        — refresh envelope + calibrations + bounce backend
    2. replay.cli                     — replay tape → signals.jsonl + setups.jsonl
    3. forward-return-labels/cli.ts   — labels.jsonl with realized MFE/MAE
    4. scalp_models score             — predictions.jsonl
    5. scalp_models evaluate          — performance.md + .json sidecar

  Each stage's output feeds the next. The artifacts land under:

    data\shadow_runs\<DATE>_<SESSION>\signals.jsonl
    data\shadow_runs\<DATE>_<SESSION>\setups.jsonl
    data\shadow_runs\<DATE>_<SESSION>\labels.jsonl
    data\shadow_runs\<DATE>_<SESSION>\labels.manifest.json
    data\predictions\<DATE>_<SESSION>.jsonl
    data\performance\<DATE>_<SESSION>.md  (+ .json sidecar)

.PARAMETER TradingDate
  YYYY-MM-DD of the completed session.

.PARAMETER Session
  rth | globex.

.PARAMETER ModelsDir
  Trained run dir to score + evaluate against. Default = the
  quiet-window-2026-05-31 run.

.PARAMETER SkipRotate
  Skip the post_capture_rotate stage. Useful if you've already run it
  manually OR you want to test on an already-rotated session.

.PARAMETER DryRun
  Print the commands that would run but don't execute.

.EXAMPLE
  # The intended use — fire after capture ends at 13:05 PT.
  .\end_of_session_pipeline.ps1 -TradingDate 2026-06-03 -Session rth
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d{4}-\d{2}-\d{2}$')]
    [string]$TradingDate,
    [Parameter(Mandatory = $true)]
    [ValidateSet('rth','globex')]
    [string]$Session,
    [string]$ModelsDir = "D:\Quant-futures-app\scratch\ra093b-run1\quiet-window-2026-05-31\model_runs\quiet-window-2026-05-31",
    [string]$Python = "C:\Users\Neel\AppData\Local\Programs\Python\Python312\python.exe",
    [string]$AnalyticsRoot = "D:\Quant-futures-app\tools\rithmic_analytics",
    [string]$DashboardRoot = "D:\Quant-futures-app\tools\rithmic_dashboard",
    [string]$ShadowRoot = "D:\Quant-futures-app\data\shadow_runs",
    [string]$PredictionsRoot = "D:\Quant-futures-app\data\predictions",
    [string]$PerformanceRoot = "D:\Quant-futures-app\data\performance",
    [float]$TargetTicks = 4.0,
    [switch]$SkipRotate,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$RepoRoot = $PSScriptRoot
$ServicesScalp = Join-Path $RepoRoot "services\scalp_models"

function Write-Status {
    param([string]$Message, [string]$Color = "Gray")
    Write-Host ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message) -ForegroundColor $Color
}

function Invoke-Step {
    param([string]$Name, [string]$Cwd, [string[]]$Cmd)
    Write-Status "START $Name" "Cyan"
    Write-Host "  cwd: $Cwd"
    Write-Host "  cmd: $($Cmd -join ' ')"
    if ($DryRun) {
        Write-Status "DRY skipped $Name" "Yellow"
        return
    }
    Push-Location $Cwd
    try {
        & $Cmd[0] @($Cmd[1..($Cmd.Count - 1)])
        if ($LASTEXITCODE -ne 0) {
            throw "$Name failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
    Write-Status "END $Name" "Green"
}

$sessionTag = "${TradingDate}_${Session}"
$shadowDir = Join-Path $ShadowRoot $sessionTag

if (-not $DryRun) {
    New-Item -ItemType Directory -Path $shadowDir -Force | Out-Null
    New-Item -ItemType Directory -Path $PredictionsRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $PerformanceRoot -Force | Out-Null
}

$signalsPath = Join-Path $shadowDir "signals.jsonl"
$setupsPath = Join-Path $shadowDir "setups.jsonl"
$labelsPath = Join-Path $shadowDir "labels.jsonl"
$labelsManifest = Join-Path $shadowDir "labels.manifest.json"
$predictionsPath = Join-Path $PredictionsRoot "${sessionTag}.jsonl"
$performancePath = Join-Path $PerformanceRoot "${sessionTag}.md"

Write-Status "end_of_session_pipeline for $sessionTag" "Green"
Write-Status "  shadow dir: $shadowDir" "Gray"
Write-Status "  models dir: $ModelsDir" "Gray"

# Stage 1 — post_capture_rotate (envelope + calibrations + backend bounce)
if (-not $SkipRotate) {
    $rotateScript = Join-Path $RepoRoot "post_capture_rotate.ps1"
    if (-not (Test-Path $rotateScript)) {
        throw "post_capture_rotate.ps1 missing at $rotateScript"
    }
    Invoke-Step -Name "post_capture_rotate" -Cwd $RepoRoot -Cmd @(
        "powershell.exe","-NoProfile","-ExecutionPolicy","Bypass",
        "-File",$rotateScript,
        "-TradingDate",$TradingDate
    )
} else {
    Write-Status "SKIP post_capture_rotate (--SkipRotate)" "Yellow"
}

# Stage 2 — replay today's tape, produce signals + setups
Invoke-Step -Name "replay" -Cwd $RepoRoot -Cmd @(
    $Python,"-m","replay",
    "--capture-date",$TradingDate,
    "--session",$Session,
    "--out",$signalsPath,
    "--setups-out",$setupsPath,
    "--analytics-root",$AnalyticsRoot,
    "--dashboard-root",$DashboardRoot
)

# Stage 3 — forward-return labels (TypeScript CLI via tsx)
Invoke-Step -Name "forward_return_labels" -Cwd $RepoRoot -Cmd @(
    "npx","tsx","apps/backtester/src/forward-return-labels/cli.ts",
    "--dataset",$signalsPath,
    "--out",$labelsPath,
    "--manifest",$labelsManifest,
    "--tick-size","0.25"
)

# Stage 4 — score setups against trained models
Invoke-Step -Name "score" -Cwd $ServicesScalp -Cmd @(
    $Python,"-m","scalp_models","score",
    "--setups",$setupsPath,
    "--models",$ModelsDir,
    "--out",$predictionsPath
)

# Stage 5 — evaluate predictions vs realized labels
Invoke-Step -Name "evaluate" -Cwd $ServicesScalp -Cmd @(
    $Python,"-m","scalp_models","evaluate",
    "--setups",$setupsPath,
    "--labels",$labelsPath,
    "--models",$ModelsDir,
    "--out",$performancePath,
    "--target-ticks",[string]$TargetTicks
)

Write-Status "end_of_session_pipeline complete" "Green"
Write-Host ""
Write-Host "  signals:     $signalsPath"
Write-Host "  setups:      $setupsPath"
Write-Host "  labels:      $labelsPath"
Write-Host "  predictions: $predictionsPath"
Write-Host "  performance: $performancePath"
Write-Host "  sidecar:     $performancePath.json"
Write-Host ""
Write-Host "Quick read:" -ForegroundColor Yellow
Write-Host "  Get-Content '$performancePath' | Select-Object -First 60"
