param(
  [string]$Python = "python",
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$PipelineArgs
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptRoot "..\..")).Path
$paths = @(
  $repoRoot,
  (Join-Path $repoRoot "services"),
  (Join-Path $repoRoot "services\replay"),
  (Join-Path $repoRoot "services\scalp_models"),
  (Join-Path $repoRoot "tools\rithmic_dashboard"),
  (Join-Path $repoRoot "tools\rithmic_analytics")
)

$existing = $env:PYTHONPATH
$env:PYTHONPATH = (($paths + @($existing)) | Where-Object { $_ -and $_.Trim().Length -gt 0 }) -join ";"

Push-Location (Join-Path $repoRoot "services\scalp_models")
try {
  & $Python -m scalp_models pipeline @PipelineArgs
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
