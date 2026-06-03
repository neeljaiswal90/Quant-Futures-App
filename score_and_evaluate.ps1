<#
.SYNOPSIS
  Shadow-mode scoring + performance evaluation for a completed session.

.DESCRIPTION
  After post_capture_rotate completes (envelope + calibrations refreshed,
  backend bounced), THIS script reads the session's setups + labels, scores
  them with a trained models run, and writes:

    data/predictions/<DATE>_<SESSION>.jsonl
    data/performance/<DATE>_<SESSION>.md  (+ .json sidecar)

  Per the RA-094 shadow-mode design: predictions are produced for every
  completed session BUT NEVER influence live trading. Predictions and
  realized labels are persisted side-by-side so the operator can review
  whether the model is performing as the calibration report claimed.

.PARAMETER TradingDate
  YYYY-MM-DD of the completed session.

.PARAMETER Session
  rth | globex — which session to evaluate.

.PARAMETER ModelsDir
  Trained run dir to score against. Default points at the most recent
  manually committed run.

.EXAMPLE
  # Standard end-of-session shadow workflow:
  .\post_capture_rotate.ps1 -TradingDate 2026-06-03
  .\score_and_evaluate.ps1 -TradingDate 2026-06-03 -Session rth

.EXAMPLE
  # Quick smoke (--max-rows caps the prediction run):
  .\score_and_evaluate.ps1 -TradingDate 2026-06-03 -Session rth -MaxRows 500
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
    [string]$PredictionsRoot = "D:\Quant-futures-app\data\predictions",
    [string]$PerformanceRoot = "D:\Quant-futures-app\data\performance",
    [string]$Python = "C:\Users\Neel\AppData\Local\Programs\Python\Python312\python.exe",
    [string]$RunDirRoot = "D:\Quant-futures-app\scratch\ra093b-run1\quiet-window-2026-05-31\sessions",
    [int]$MaxRows = 0,
    [float]$TargetTicks = 4.0,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ServicesRoot = "D:\Quant-futures-app\services\scalp_models"

function Write-Status {
    param([string]$Message, [string]$Color = "Gray")
    Write-Host ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message) -ForegroundColor $Color
}

# Validate the inputs exist.
$sessionDir = Join-Path $RunDirRoot "${TradingDate}_${Session}"
$setupsPath = Join-Path $sessionDir "setups.jsonl"
$labelsPath = Join-Path $sessionDir "labels.jsonl"
foreach ($p in @($sessionDir, $setupsPath, $labelsPath, $ModelsDir)) {
    if (-not (Test-Path $p)) {
        throw "required path missing: $p"
    }
}

# Output paths — date+session organized.
$predOut = Join-Path $PredictionsRoot "${TradingDate}_${Session}.jsonl"
$perfOut = Join-Path $PerformanceRoot "${TradingDate}_${Session}.md"

Write-Status "shadow-mode scoring + evaluation for ${TradingDate} ${Session}" "Green"
Write-Status "  setups: $setupsPath" "Gray"
Write-Status "  labels: $labelsPath" "Gray"
Write-Status "  models: $ModelsDir" "Gray"
Write-Status "  predictions out: $predOut" "Gray"
Write-Status "  performance out: $perfOut" "Gray"

# Step 1: score the session's setups.
Write-Status "START score" "Cyan"
$scoreArgs = @(
    "-m","scalp_models","score",
    "--setups",$setupsPath,
    "--models",$ModelsDir,
    "--out",$predOut
)
if ($MaxRows -gt 0) {
    $scoreArgs += @("--max-rows", [string]$MaxRows)
}
Write-Host "  cmd: $Python $($scoreArgs -join ' ')"
if (-not $DryRun) {
    Push-Location $ServicesRoot
    try {
        & $Python @scoreArgs
        if ($LASTEXITCODE -ne 0) {
            throw "score step failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}
Write-Status "END score" "Green"

# Step 2: evaluate predictions vs realized labels.
Write-Status "START evaluate" "Cyan"
$evalArgs = @(
    "-m","scalp_models","evaluate",
    "--setups",$setupsPath,
    "--labels",$labelsPath,
    "--models",$ModelsDir,
    "--out",$perfOut,
    "--target-ticks",[string]$TargetTicks
)
Write-Host "  cmd: $Python $($evalArgs -join ' ')"
if (-not $DryRun) {
    Push-Location $ServicesRoot
    try {
        & $Python @evalArgs
        if ($LASTEXITCODE -ne 0) {
            throw "evaluate step failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}
Write-Status "END evaluate" "Green"

Write-Status "shadow-mode performance pass complete" "Green"
Write-Host ""
Write-Host "  predictions: $predOut"
Write-Host "  performance: $perfOut"
Write-Host "  sidecar:     $perfOut.json"
Write-Host ""
Write-Host "Quick review:" -ForegroundColor Yellow
Write-Host "  Get-Content $perfOut | Select-Object -First 40"
