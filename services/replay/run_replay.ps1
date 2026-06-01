param(
  [string]$Python = "python",
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ReplayArgs
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptRoot "..\..")).Path
$paths = @(
  $repoRoot,
  (Join-Path $repoRoot "services"),
  (Join-Path $repoRoot "services\replay"),
  (Join-Path $repoRoot "tools\rithmic_dashboard"),
  (Join-Path $repoRoot "tools\rithmic_analytics")
)

$existing = $env:PYTHONPATH
$env:PYTHONPATH = (($paths + @($existing)) | Where-Object { $_ -and $_.Trim().Length -gt 0 }) -join ";"

Push-Location (Join-Path $repoRoot "services\replay")
try {
  & $Python -m replay @ReplayArgs
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
